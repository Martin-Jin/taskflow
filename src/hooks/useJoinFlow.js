/**
 * ============================================================================
 * useJoinFlow — the `?join=<token>` share-link landing (Phase 2)
 * ============================================================================
 * Owns the whole lifecycle of arriving at the app via someone's share link:
 * read the token, sign the visitor in (anonymously if they aren't already),
 * resolve the token server-side, ask an anonymous visitor what to call
 * themselves, write the membership, and open the project.
 *
 * All the SEQUENCING DECISIONS live in utils/joinFlow.js (pure, unit-tested)
 * — this hook is the wiring, same split as useSharedProjectSync/sharedTaskSync
 * elsewhere in this feature.
 *
 * THE TOKEN IS STRIPPED FROM THE URL IMMEDIATELY
 * ----------------------------------------------
 * Before any network call, and whether or not the join ends up succeeding.
 * A share token is a secret, and the URL bar is the single most exposed place
 * in the browser: shoulder-surfed, screenshotted, pasted into chats, copied
 * into bug reports, and leaked to third parties via `Referer`. Stripping it
 * also stops a reload from re-running the join. It's only needed transiently
 * within this effect's own closure (resolveShareToken, below), so removing it
 * from the URL costs nothing.
 *
 * WHY IT RUNS ONCE, GUARDED BY A REF
 * ----------------------------------
 * The effect depends on auth state, which changes DURING the flow (an
 * anonymous sign-in, then a custom-token sign-in, both re-render this hook).
 * Without the ref guard each of those would restart the join, and the third
 * step — writing membership — would race itself. `startedRef` makes the whole
 * sequence run exactly once per page load.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signInAnonymously } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useScheduler } from '../context/SchedulerContext';
import { resolveShareToken, isShareLinkConfigured } from '../services/shareLinkService';
import { JOIN_STATUS, joinStatusForReason, planJoinStep, readJoinToken, urlWithoutJoinParam } from '../utils/joinFlow';
import { resolveGuestDisplayName, setGuestDisplayName, setGuestUid } from '../utils/guestIdentity';

/**
 * @param {(projectId: string) => void} onJoined - Called with the local project id once the join completes, so the app can navigate to it.
 * @returns {{status: string, projectName: string, error: string|null, submitName: (name: string) => void, dismiss: () => void}}
 */
export function useJoinFlow(onJoined) {
  const { authLoading } = useAuth();
  const { joinSharedProject, projects } = useScheduler();
  // Read through a ref: the owner-opens-own-link branch below runs inside the
  // async join effect, which must not re-run when the project list changes.
  const projectsRef = useRef(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const [status, setStatus] = useState(JOIN_STATUS.IDLE);
  const [projectName, setProjectName] = useState('');
  const [error, setError] = useState(null);

  const startedRef = useRef(false);
  // The resolved payload, held between "needs a name" and the user supplying
  // one — the custom-token session is already active by then, so the pending
  // work is only the membership write.
  const resolutionRef = useRef(null);
  const onJoinedRef = useRef(onJoined);
  useEffect(() => {
    onJoinedRef.current = onJoined;
  }, [onJoined]);

  /** Write membership and hand the project id back to the app. */
  const completeJoin = useCallback(
    async (displayName) => {
      const resolution = resolutionRef.current;
      if (!resolution) return;
      setStatus(JOIN_STATUS.JOINING);

      if (displayName) setGuestDisplayName(displayName);

      const result = await joinSharedProject({
        sharedProjectId: resolution.projectId,
        projectName: resolution.projectName,
        role: resolution.role,
        displayName,
        // Carried from the resolution's refreshed token claim, not from
        // user.isAnonymous — see resolveShareToken in shareLinkService.js.
        wasAnonymous: resolution.wasAnonymous,
      });

      if (!result.ok) {
        setStatus(JOIN_STATUS.ERROR);
        setError("Couldn't finish joining that project. Please try the link again.");
        return;
      }
      setStatus(JOIN_STATUS.SUCCESS);
      onJoinedRef.current?.(result.projectId);
    },
    [joinSharedProject]
  );

  useEffect(() => {
    // Wait for Firebase to report the existing session before deciding whether
    // to create an anonymous one — acting early would sign a returning user in
    // as a stranger.
    if (authLoading || startedRef.current) return;

    const token = readJoinToken();
    if (!token) return;

    startedRef.current = true;
    // Strip first, ask questions later — see the header comment.
    window.history.replaceState(null, '', urlWithoutJoinParam());

    if (!isShareLinkConfigured()) {
      setStatus(JOIN_STATUS.ERROR);
      setError('Sharing is not configured for this deployment.');
      return;
    }

    (async () => {
      setStatus(JOIN_STATUS.RESOLVING);
      try {
        // A visitor with no account at all still needs SOME identity before
        // the rules will let them join — that's what Anonymous Auth is for
        // here. Invisible to the user; they're only ever asked for a name.
        // This is still the ONLY place that mints a guest's Firebase uid
        // (see AuthContext.jsx's header comment: it's deliberately lazy, not
        // proactive on every load) — unchanged from before the unified
        // guest-identity feature. What's new is recording the resulting uid
        // into guestIdentity.js's local record right away, so it's available
        // to resolveGuestDisplayName below and to any other guest UI without
        // needing this hook's own state. Safe to record regardless of
        // whether this session is brand new or already existed (e.g. a
        // second share link opened in the same browser — Firebase restores
        // the same anonymous session across reloads on its own, and the
        // custom-token swap in resolveShareToken below preserves this exact
        // uid for an anonymous visitor, see its own comment).
        if (!auth.currentUser) await signInAnonymously(auth);
        setGuestUid(auth.currentUser.uid);

        const resolution = await resolveShareToken(token);
        if (!resolution.ok) {
          // The owner opening their own link isn't a failure — they already have
          // full access, so just show the project rather than an error. The
          // server decides this (it's the only side that can read the project's
          // ownerId before membership exists); nothing is written.
          if (resolution.reason === 'already_owner' && resolution.projectId) {
            setProjectName(resolution.projectName || '');
            setStatus(JOIN_STATUS.SUCCESS);
            // The owner's LOCAL project keeps its own id and merely carries a
            // `sharedProjectId` (see shareProject) — unlike a joiner, for whom
            // the two are the same. Navigate by the local id, falling back to
            // the shared id if the list hasn't loaded yet.
            const localId =
              projectsRef.current?.find((p) => p.sharedProjectId === resolution.projectId)?.id ||
              resolution.projectId;
            onJoinedRef.current?.(localId);
            return;
          }
          setStatus(joinStatusForReason(resolution.reason));
          return;
        }

        resolutionRef.current = resolution;
        setProjectName(resolution.projectName || '');

        // resolveShareToken has just replaced the auth session with the
        // custom-token one, so read the CURRENT user rather than the `user`
        // this hook closed over, which is a render behind.
        //
        // `sharedProject` is deliberately null: this client cannot read the
        // project document before membership exists, so it cannot evaluate
        // planJoinStep's "already a member at a strong enough role" rule. That
        // precedence is enforced SERVER-SIDE instead, by the resolve endpoint's
        // effectiveJoinRole — `resolution.role` already accounts for any stronger
        // stored role, so writing it can no longer downgrade anyone.
        const step = planJoinStep({
          resolution,
          user: auth.currentUser,
          existingGuestName: resolveGuestDisplayName(auth.currentUser?.uid),
          sharedProject: null,
        });

        if (step.action === 'prompt_name') {
          setStatus(JOIN_STATUS.NEEDS_NAME);
          return;
        }
        await completeJoin(step.displayName);
      } catch (err) {
        console.error('[useJoinFlow] Join failed', err);
        setStatus(JOIN_STATUS.ERROR);
        setError(err?.message || 'Something went wrong opening that link.');
      }
    })();
  }, [authLoading, completeJoin]);

  /** Called by the name prompt once an anonymous visitor picks a display name. */
  const submitName = useCallback(
    (name) => {
      const trimmed = (name || '').trim();
      if (!trimmed) return;
      completeJoin(trimmed);
    },
    [completeJoin]
  );

  const dismiss = useCallback(() => setStatus(JOIN_STATUS.IDLE), []);

  return { status, projectName, error, submitName, dismiss };
}
