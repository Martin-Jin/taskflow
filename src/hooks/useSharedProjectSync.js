/**
 * ============================================================================
 * useSharedProjectSync — live multi-writer sync for shared projects
 * ============================================================================
 * Phase 1 of Collaborative Projects. Deliberately a SEPARATE, smaller hook from
 * useCloudSync rather than an extension of it, because the two have opposite
 * models and unifying them would mean re-reasoning about every existing
 * single-user behaviour under concurrency:
 *
 *   useCloudSync         localStorage is truth; Firestore converges one
 *                        person's devices; one document holds everything.
 *   useSharedProjectSync Firestore is truth; many people write concurrently;
 *                        one document per task.
 *
 * WHAT IT DOES
 * ------------
 *   1. Subscribes to each joined project's document and its tasks
 *      subcollection, applying remote changes into SchedulerContext's task
 *      array through planRemoteTaskApply (which carries the in-flight write
 *      race guard).
 *   2. Watches that same array for local edits and pushes them back as
 *      per-document writes, computed by diffing rather than by hooking every
 *      mutation site — see planSharedTaskWrites for why.
 *   3. Heartbeats presence, and reports who else is viewing.
 *
 * All the decisions live in utils/sharedTaskSync.js, pure and unit-tested.
 * This hook is the wiring: subscriptions, refs, effects and error handling.
 *
 * CONFLICT POLICY: last write wins per task document, with recurring
 * completion state merged rather than overwritten. Stated in full in
 * utils/sharedTaskSync.js's header.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearPresence,
  subscribePresence,
  subscribeSharedProject,
  subscribeSharedSections,
  subscribeSharedTasks,
  writePresence,
  writeSharedSections,
  writeSharedTasks,
} from '../services/sharedProjectService';
import {
  computeActiveViewers,
  isBenignSelfDeleteWriteRejection,
  isSharedTask,
  partitionTasksBySharing,
  partitionSectionsBySharing,
  planRemoteTaskApply,
  planRemoteSectionApply,
  planSharedTaskWrites,
  planSharedSectionWrites,
  sharedTaskFingerprint,
  sharedSectionFingerprint,
  PRESENCE_STALE_MS,
} from '../utils/sharedTaskSync';
import { isGuestUser, findOwnGuestName } from '../utils/sharedProjectAccess';
import { PRESENCE_HEARTBEAT_MS, SHARED_PROJECT_SYNC_DEBOUNCE_MS } from '../services/dataRetention';

/**
 * @param {object} params
 * @param {import('../types').Task[]} params.tasks - the full local task array
 * @param {import('../types').Section[]} params.sections - the full local section array
 * @param {React.MutableRefObject<{tasks: Array, blocks: Array}>} params.stateRef - latest committed tasks/blocks, for async callbacks
 * @param {React.MutableRefObject<Array>} params.sectionsRef - latest sections array, for async callbacks. Separate from
 *   `stateRef`: sections are a plain useState in SchedulerContext, not part of useHistoryState's {tasks, blocks}.
 * @param {(next: {tasks: Array, blocks: Array}) => void} params.applyRemote - applies remote task/block changes WITHOUT a history entry
 * @param {(next: Array) => void} params.applyRemoteSections - applies a remote section array WITHOUT a history entry.
 *   Separate from `applyRemote`: sections are NOT part of the tasks/blocks undo history (a plain useState in
 *   SchedulerContext, unlike tasks/blocks' useHistoryState), so they need their own setter rather than sharing
 *   `overwritePresent`'s tasks/blocks-shaped signature.
 * @param {string[]} params.sharedProjectIds - projects this user is a member of
 * @param {React.MutableRefObject<import('../types').Project[]>} params.projectsRef - latest Project rows, for
 *   resolving THIS reader's own local Project row id for a shared project (see deserializeSharedTask's doc
 *   comment) — a ref, not a plain value, since it's read from inside long-lived onSnapshot callbacks.
 * @param {object|null} params.user - the signed-in Firebase user, or null
 * @param {(n: object) => void} params.setNotification
 */
export function useSharedProjectSync({ tasks, sections, stateRef, sectionsRef, applyRemote, applyRemoteSections, sharedProjectIds, projectsRef, user, setNotification }) {
  const [sharedProjects, setSharedProjects] = useState({});
  const [presenceByProject, setPresenceByProject] = useState({});
  // Read fresh from inside the heartbeat's setInterval closure (see the
  // presence heartbeat effect below) rather than closing over `sharedProjects`
  // directly — the heartbeat effect intentionally does NOT restart every time
  // `sharedProjects` updates (its deps are just [projectIdsKey, user]), so a
  // plain closure would freeze the guest-name fallback at whatever it was
  // when the effect last (re)started and broadcast that stale value for up to
  // the next membership change.
  const sharedProjectsRef = useRef(sharedProjects);
  useEffect(() => {
    sharedProjectsRef.current = sharedProjects;
  }, [sharedProjects]);
  // Ids of projects this user was a confirmed member of (their doc loaded at
  // least once) that then disappeared — deleted by the owner, or this user's
  // own collaborator entry was removed. Surfaced so SchedulerContext can prune
  // the now-dead local Project row/sharedProjectIds pointer; see the doc
  // subscription's onData/onError below for where this actually gets set.
  const [lostProjectIds, setLostProjectIds] = useState([]);

  // taskId -> fingerprint last known STORED in Firestore. Drives the write
  // diff: anything whose fingerprint differs is a genuine local edit.
  const syncedFingerprintsRef = useRef(new Map());
  // taskId -> fingerprint we've WRITTEN but not yet seen confirmed (null = a
  // written delete). This is the race guard's state — see planRemoteTaskApply.
  const pendingRef = useRef(new Map());
  // Ids deliberately deleted locally, awaiting their remote delete. Deletes are
  // never inferred from absence (see planSharedTaskWrites).
  const pendingDeletesRef = useRef(new Set());
  // Same three refs, but for sections — kept separate from the task ones
  // above (rather than sharing one keyspace) since a task and a section could
  // otherwise collide on id.
  const sectionSyncedFingerprintsRef = useRef(new Map());
  const sectionPendingRef = useRef(new Map());
  const sectionPendingDeletesRef = useRef(new Set());
  // Projects whose first snapshot has arrived. Until it does we know nothing
  // about what's stored, so pushing a diff would mis-create everything.
  // Shared between tasks and sections: both subscriptions must have delivered
  // their first snapshot before either one's push diff is trustworthy.
  const loadedProjectsRef = useRef(new Set());
  const loadedSectionProjectsRef = useRef(new Set());

  const applyRemoteRef = useRef(applyRemote);
  useEffect(() => {
    applyRemoteRef.current = applyRemote;
  }, [applyRemote]);
  const applyRemoteSectionsRef = useRef(applyRemoteSections);
  useEffect(() => {
    applyRemoteSectionsRef.current = applyRemoteSections;
  }, [applyRemoteSections]);

  const projectIdsKey = useMemo(() => [...(sharedProjectIds || [])].sort().join(','), [sharedProjectIds]);

  /**
   * Register that a task was deliberately deleted, so the diff may issue a
   * remote delete for it. Called by SchedulerContext's deleteTask — the only
   * place that knows a disappearance was intentional rather than an undo,
   * restore or cloud pull replacing the array wholesale.
   */
  const noteSharedTaskDeleted = useCallback((taskId) => {
    pendingDeletesRef.current.add(taskId);
  }, []);

  /** Same as noteSharedTaskDeleted, for a section deliberately deleted — see deleteSection. */
  const noteSharedSectionDeleted = useCallback((sectionId) => {
    sectionPendingDeletesRef.current.add(sectionId);
  }, []);

  // Ids of shared projects THIS client just deleted (the owner's own
  // deleteProject, see SchedulerContext) or left. `deleteSharedProject`'s
  // deleteDoc and any already-in-flight task/section write for the same
  // project (a debounced runPushNow batch dispatched moments earlier, still
  // awaiting its network round-trip when the delete button was clicked) race
  // with no ordering between them — firestore.rules' parentOwner()/
  // parentEditor() re-`get()` the parent doc on every task/section write, so
  // if the delete happens to land first server-side, that in-flight write is
  // rejected with permission-denied even though it was issued by the owner
  // with full rights at the time it was sent. Without this set, that rejection
  // looked identical to a genuine lost-access write (see reportWriteRejected
  // below) and surfaced a misleading "you don't have permission" toast for an
  // action that actually succeeded (the project WAS deleted) — the local
  // Project row was already gone by then too, so the very next click just
  // deleted-nothing-locally-but-retried-the-remote-delete and "worked",
  // which is what made the first attempt look like a failed-then-repeated
  // delete rather than a spuriously-reported one. Entries never need pruning:
  // the set only ever grows by a handful of short-lived project ids across a
  // session and is trivial in size.
  const deletingProjectIdsRef = useRef(new Set());
  const noteSharedProjectDeleted = useCallback((projectId) => {
    deletingProjectIdsRef.current.add(projectId);
  }, []);

  const reportError = useCallback(
    (err, projectId) => {
      // Losing access (removed by the owner, project deleted) surfaces here as
      // permission-denied and is a normal outcome, not a failure worth alarming
      // anyone about — the subscription teardown below files the project away.
      if (err?.code === 'permission-denied') return;
      console.error('[useSharedProjectSync] Sync error', projectId, err);
      setNotification?.({ type: 'error', message: "Couldn't sync a shared project. Your changes are saved locally." });
    },
    [setNotification]
  );

  /**
   * Same as reportError, but for a rejected WRITE rather than a broken
   * subscription — and here permission-denied must NOT be silent, UNLESS this
   * client itself just deleted (or left) the project the write targeted — see
   * deletingProjectIdsRef above.
   *
   * On a subscription, permission-denied means "you no longer have access", which
   * is benign. On a write it means the opposite: the change was applied locally
   * (every mutation commits optimistically) and the server refused it, so the
   * user is looking at an edit that is about to silently vanish on the next
   * snapshot. That's the confusing half of the viewer-permissions bug — the UI
   * now disables these controls for viewers, so reaching this is either a stale
   * role or a genuine bug, and both are worth saying out loud. A self-deletion
   * race is a third, benign case that looks identical at the error-code level:
   * the edit really is being dropped, but there's nothing to warn about since
   * the whole project (local row included) is already gone.
   */
  const reportWriteRejected = useCallback(
    (err, projectId) => {
      if (isBenignSelfDeleteWriteRejection(err, projectId, deletingProjectIdsRef.current)) return;
      if (err?.code === 'permission-denied') {
        console.warn('[useSharedProjectSync] Write rejected', projectId, err);
        setNotification?.({
          type: 'error',
          message: "You don't have permission to change that — your edit wasn't saved.",
        });
        return;
      }
      reportError(err, projectId);
    },
    [reportError, setNotification]
  );

  // ---- Subscriptions, one set per joined project ---------------------------
  // Ids whose shared-project doc has been confirmedly seen at least once
  // (loaded successfully) — a null/permission-denied AFTER that point means
  // real loss of access; BEFORE it, it just means the first snapshot hasn't
  // arrived yet and must not be mistaken for loss (e.g. right after joining).
  const confirmedProjectDocRef = useRef(new Set());

  useEffect(() => {
    if (!user || !projectIdsKey) {
      setSharedProjects({});
      setPresenceByProject({});
      loadedProjectsRef.current = new Set();
      confirmedProjectDocRef.current = new Set();
      setLostProjectIds([]);
      return undefined;
    }

    const ids = projectIdsKey.split(',').filter(Boolean);
    const unsubscribers = [];
    // Dropped from the membership list this render (e.g. the local Project
    // row was already cleaned up) shouldn't linger in lostProjectIds forever.
    setLostProjectIds((prev) => prev.filter((id) => ids.includes(id)));

    for (const projectId of ids) {
      unsubscribers.push(
        subscribeSharedProject(
          projectId,
          (project) => {
            if (project) {
              confirmedProjectDocRef.current.add(projectId);
            } else if (confirmedProjectDocRef.current.has(projectId)) {
              // Was there, now isn't: the owner deleted it. Real loss, not a
              // pre-first-snapshot false positive.
              setLostProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
            }
            setSharedProjects((prev) => {
              if (!project) {
                const { [projectId]: _removed, ...rest } = prev;
                return rest;
              }
              return { ...prev, [projectId]: project };
            });
          },
          (err) => {
            if (err?.code === 'permission-denied' && confirmedProjectDocRef.current.has(projectId)) {
              // Was readable before, now denied: this user's own access (not
              // just the doc) was revoked — e.g. removeCollaborator.
              setLostProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
              setSharedProjects((prev) => {
                const { [projectId]: _removed, ...rest } = prev;
                return rest;
              });
            }
            reportError(err, projectId);
          }
        )
      );

      unsubscribers.push(
        subscribeSharedTasks(
          projectId,
          (remoteTasks) => {
            // This reader's OWN local Project row for this shared project —
            // never the document's own `projectId` (that's the owner's local
            // id, meaningless here). See deserializeSharedTask's doc comment;
            // this is the fix for shared tasks silently not appearing for
            // anyone but the owner.
            const localProjectId = projectsRef.current?.find((p) => p.sharedProjectId === projectId)?.id;
            const { tasks: nextTasks, confirmedIds, removedIds } = planRemoteTaskApply({
              localTasks: stateRef.current.tasks,
              remoteTasks,
              projectId,
              pending: pendingRef.current,
              // Ids ever confirmed to exist server-side — lets the race guard
              // tell "never pushed yet" (keep) apart from "really deleted
              // remotely" (drop) for a task with no pending entry. See
              // planRemoteTaskApply's doc comment.
              knownRemoteIds: syncedFingerprintsRef.current.keys(),
              localProjectId,
            });

            for (const id of confirmedIds) {
              pendingRef.current.delete(id);
              pendingDeletesRef.current.delete(id);
            }

            // Record what's now stored, so the write diff doesn't immediately
            // re-push what we just received. Touches only this project's
            // entries, leaving other projects' bookkeeping alone.
            for (const id of removedIds) syncedFingerprintsRef.current.delete(id);
            for (const remote of remoteTasks) {
              if (pendingRef.current.has(remote.id)) continue; // ours is newer; don't record theirs as synced
              syncedFingerprintsRef.current.set(remote.id, sharedTaskFingerprint(remote));
            }

            loadedProjectsRef.current.add(projectId);

            // Blocks belonging to a task a collaborator deleted would otherwise
            // linger on this user's calendar pointing at nothing.
            const nextBlocks = removedIds.length
              ? stateRef.current.blocks.filter((b) => !removedIds.includes(b.taskId))
              : stateRef.current.blocks;

            applyRemoteRef.current({ tasks: nextTasks, blocks: nextBlocks });
          },
          (err) => reportError(err, projectId)
        )
      );

      unsubscribers.push(
        subscribeSharedSections(
          projectId,
          (remoteSections) => {
            // Same reasoning as the tasks subscription above.
            const localProjectId = projectsRef.current?.find((p) => p.sharedProjectId === projectId)?.id;
            const { sections: nextSections, confirmedIds, removedIds } = planRemoteSectionApply({
              localSections: sectionsRef.current,
              remoteSections,
              projectId,
              pending: sectionPendingRef.current,
              knownRemoteIds: sectionSyncedFingerprintsRef.current.keys(),
              localProjectId,
            });

            for (const id of confirmedIds) {
              sectionPendingRef.current.delete(id);
              sectionPendingDeletesRef.current.delete(id);
            }

            for (const id of removedIds) sectionSyncedFingerprintsRef.current.delete(id);
            for (const remote of remoteSections) {
              if (sectionPendingRef.current.has(remote.id)) continue;
              sectionSyncedFingerprintsRef.current.set(remote.id, sharedSectionFingerprint(remote));
            }

            loadedSectionProjectsRef.current.add(projectId);
            applyRemoteSectionsRef.current(nextSections);
          },
          (err) => reportError(err, projectId)
        )
      );

      unsubscribers.push(
        subscribePresence(
          projectId,
          (entries) => setPresenceByProject((prev) => ({ ...prev, [projectId]: entries })),
          (err) => reportError(err, projectId)
        )
      );
    }

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [projectIdsKey, user, stateRef, sectionsRef, projectsRef, reportError]);

  // ---- Push local edits (debounced) -----------------------------------------
  // Mirrors useCloudSync's schedulePush/runPushNow shape: a timer collapses a
  // burst of edits into one write per project instead of one per change.
  //
  // The diff (planSharedTaskWrites) and the "mark in flight" bookkeeping both
  // run at FIRE time, from runPushNow, reading stateRef.current.tasks rather
  // than the `tasks` this effect closed over when it was scheduled. This is
  // the same choice useCloudSync's runPushNow makes (it reads stateRef.current,
  // not a captured value) and matters here for the same reason: several edits
  // can land inside one debounce window, and only diffing/stamping against the
  // LATEST tasks array at fire time keeps the race guard correct — marking a
  // stale mid-window fingerprint as "in flight" would let a snapshot for an
  // even-newer local edit be wrongly accepted as confirming it.
  //
  // pendingDeletesRef is read at fire time too, so a delete queued anywhere
  // inside the debounce window is still included in the write that fires.
  const pushTimerRef = useRef(null);

  // projectIdsKey is read via a ref (not a useCallback dependency) so that
  // runPushNow's identity stays stable across project list changes — see
  // the note above the scheduling effect for why that matters.
  const projectIdsKeyRef = useRef(projectIdsKey);
  useEffect(() => {
    projectIdsKeyRef.current = projectIdsKey;
  }, [projectIdsKey]);

  const runPushNow = useCallback(() => {
    pushTimerRef.current = null;
    if (!user) return;
    const ids = projectIdsKeyRef.current ? projectIdsKeyRef.current.split(',').filter(Boolean) : [];
    const currentTasks = stateRef.current.tasks;
    const currentSections = sectionsRef.current;

    for (const projectId of ids) {
      // Until the first snapshot lands we don't know what's stored, and a diff
      // against an empty map would try to create every task afresh.
      if (loadedProjectsRef.current.has(projectId)) {
        const deletedIds = [...pendingDeletesRef.current];
        const plan = planSharedTaskWrites({
          tasks: currentTasks,
          projectId,
          syncedFingerprints: syncedFingerprintsRef.current,
          deletedIds,
        });
        if (plan.creates.length || plan.updates.length || plan.deletes.length) {
          // Mark in flight BEFORE awaiting, so a snapshot arriving mid-write is
          // correctly recognised as stale by the race guard.
          for (const task of [...plan.creates, ...plan.updates]) {
            const fingerprint = sharedTaskFingerprint(task);
            pendingRef.current.set(task.id, fingerprint);
            syncedFingerprintsRef.current.set(task.id, fingerprint);
          }
          for (const id of plan.deletes) {
            pendingRef.current.set(id, null);
            syncedFingerprintsRef.current.delete(id);
          }

          writeSharedTasks(projectId, plan).catch((err) => {
            // Roll the optimistic bookkeeping back so the next pass retries
            // rather than believing a failed write landed.
            for (const task of [...plan.creates, ...plan.updates]) {
              pendingRef.current.delete(task.id);
              syncedFingerprintsRef.current.delete(task.id);
            }
            for (const id of plan.deletes) pendingRef.current.delete(id);
            reportWriteRejected(err, projectId);
          });
        }
      }

      // Same push, same debounce window, for this project's sections — a
      // separate diff/bookkeeping pass (its own refs), since a section and a
      // task never share an id keyspace.
      if (loadedSectionProjectsRef.current.has(projectId)) {
        const deletedSectionIds = [...sectionPendingDeletesRef.current];
        const sectionPlan = planSharedSectionWrites({
          sections: currentSections,
          projectId,
          syncedFingerprints: sectionSyncedFingerprintsRef.current,
          deletedIds: deletedSectionIds,
        });
        if (sectionPlan.creates.length || sectionPlan.updates.length || sectionPlan.deletes.length) {
          for (const section of [...sectionPlan.creates, ...sectionPlan.updates]) {
            const fingerprint = sharedSectionFingerprint(section);
            sectionPendingRef.current.set(section.id, fingerprint);
            sectionSyncedFingerprintsRef.current.set(section.id, fingerprint);
          }
          for (const id of sectionPlan.deletes) {
            sectionPendingRef.current.set(id, null);
            sectionSyncedFingerprintsRef.current.delete(id);
          }

          writeSharedSections(projectId, sectionPlan).catch((err) => {
            for (const section of [...sectionPlan.creates, ...sectionPlan.updates]) {
              sectionPendingRef.current.delete(section.id);
              sectionSyncedFingerprintsRef.current.delete(section.id);
            }
            for (const id of sectionPlan.deletes) sectionPendingRef.current.delete(id);
            reportWriteRejected(err, projectId);
          });
        }
      }
    }
  }, [user, stateRef, sectionsRef, reportError, reportWriteRejected]);

  // Schedules (or reschedules) the debounced push. Called on every task-array
  // change, same as useCloudSync's schedulePush — clearing/resetting the timer
  // happens inside this stable callback rather than in the triggering effect's
  // cleanup, so a change to some OTHER dependency (e.g. joining a new shared
  // project) can't accidentally cancel a pending push for an unrelated edit.
  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(runPushNow, SHARED_PROJECT_SYNC_DEBOUNCE_MS);
  }, [runPushNow]);

  useEffect(() => {
    if (!user) return;
    schedulePush();
  }, [tasks, sections, user, schedulePush]);

  // Flush a pending debounced push immediately when the tab is about to go
  // away, and on unmount — same three-events approach as useCloudSync, so a
  // trailing edit made just before a tab switch/close isn't silently dropped
  // by the debounce timer never getting to fire.
  useEffect(() => {
    if (!user) return undefined;
    const flush = () => {
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
        runPushNow();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      // Also flush on unmount itself (e.g. signing out), not just on
      // tab-hide/close, so a trailing edit isn't dropped there either.
      flush();
    };
  }, [user, runPushNow]);

  // ---- Presence heartbeat --------------------------------------------------
  useEffect(() => {
    if (!user || !projectIdsKey) return undefined;
    const ids = projectIdsKey.split(',').filter(Boolean);

    // Same "what name do I show for myself" resolution AccountButton/
    // SettingsPanel already use (isGuestUser + findOwnGuestName, falling back
    // to Firebase Auth's own displayName/email) — reused rather than
    // duplicated so a guest's local rename (setGuestDisplayName, via
    // renameAnonymousSelf) is reflected here too. Previously this only ever
    // read user.displayName/user.email, which a guest/anonymous session never
    // has, so the heartbeat always broadcast the 'Someone' fallback regardless
    // of any name the guest had chosen.
    const resolveMyDisplayName = () => {
      if (!isGuestUser(user)) return user.displayName || user.email || 'Someone';
      return findOwnGuestName(user.uid, sharedProjectsRef.current) || 'Someone';
    };

    const beat = () => {
      const displayName = resolveMyDisplayName();
      for (const projectId of ids) {
        writePresence(projectId, user.uid, {
          displayName,
          photoURL: user.photoURL || null,
        }).catch(() => {
          // Presence is decorative — a failed heartbeat just means this user's
          // avatar ages out for others. Never surface it as an error.
        });
      }
    };

    beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS); // polls every PRESENCE_HEARTBEAT_MS and re-timestamps current user

    // Best-effort cleanup on unmount AND on tab-close/hide. A plain unmount
    // handler alone never fires for a closed tab (the React tree doesn't
    // unmount), so a closed tab used to rely entirely on the 90s staleness
    // fallback even though clearPresence's deleteDoc, if it ran, would
    // remove the doc immediately — same beforeunload/pagehide pattern as the
    // task/section push-flush effect above.
    const clearAll = () => {
      for (const projectId of ids) clearPresence(projectId, user.uid).catch(() => {});
    };
    window.addEventListener('pagehide', clearAll);
    window.addEventListener('beforeunload', clearAll);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', clearAll);
      window.removeEventListener('beforeunload', clearAll);
      clearAll();
    };
  }, [projectIdsKey, user]);

  /** Live shared tasks, authoritative — used to protect them from undo/redo and restores. */
  const liveSharedTasks = useMemo(() => partitionTasksBySharing(tasks).sharedTasks, [tasks]);
  /** Live shared sections, authoritative — used to protect them from cloud-sync pulls/restores (see preserveSharedSections). */
  const liveSharedSections = useMemo(() => partitionSectionsBySharing(sections).sharedSections, [sections]);

  // Staleness is a function of TIME, not of incoming data — and a viewer who
  // closes their tab stops producing snapshots by definition, so without this
  // ticker the memo below would never re-run for them and they'd sit in the
  // avatar strip forever rather than aging out after PRESENCE_STALE_MS. (The
  // web has no reliable "goodbye" event, which is why presence is heartbeat-
  // based and expiry has to be evaluated on a clock.) Half the stale window,
  // so someone disappears within ~45s of the cutoff rather than up to a full
  // window late.
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => {
    if (!user || !projectIdsKey) return undefined;
    const timer = setInterval(() => setPresenceTick((n) => n + 1), PRESENCE_STALE_MS / 2);
    return () => clearInterval(timer);
  }, [user, projectIdsKey]);

  /** Who else is currently viewing each project, keyed by project id. */
  const viewersByProject = useMemo(() => {
    const now = Date.now();
    const out = {};
    for (const [projectId, entries] of Object.entries(presenceByProject)) {
      out[projectId] = computeActiveViewers(entries, now, user?.uid);
    }
    return out;
    // presenceTick is a deliberate re-evaluation trigger, not data — see above.
  }, [presenceByProject, user?.uid, presenceTick]);

  return {
    /** Shared project documents this user is a member of, keyed by id. */
    sharedProjects,
    /** Ids that were confirmed accessible and then lost access to (deleted, or this user was removed) — see the doc comment above lostProjectIds' useState. */
    lostProjectIds,
    /** Active viewers per project (excluding this user). */
    viewersByProject,
    /** Current shared tasks, for preserveSharedTasks at undo/restore points. */
    liveSharedTasks,
    /** Current shared sections, for preserveSharedSections at cloud-sync pull/restore points. */
    liveSharedSections,
    /** Tell the sync engine a task deletion was deliberate. */
    noteSharedTaskDeleted,
    /** Tell the sync engine a section deletion was deliberate. */
    noteSharedSectionDeleted,
    /** Tell the sync engine a whole shared project delete/leave was deliberate — see deletingProjectIdsRef. */
    noteSharedProjectDeleted,
    /** Whether a given task belongs to a shared project. */
    isSharedTask,
  };
}
