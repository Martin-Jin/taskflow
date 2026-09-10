# Taskflow — Working Agreement

React + Vite + Firebase task manager. `npm run build` is the per-change correctness
check (catches type/import/build errors); a Vitest unit suite and a Playwright E2E
suite exist too, but running them isn't required on every commit — see Testing.

## Model usage (token efficiency)

Default to **Sonnet** for the main session. Scale up or down based on what the change
actually needs — don't default to the most expensive model out of caution.

Subagent model selection is enforced by the subagent definition files in
`.claude/agents/`, not by prose here — each file's `model:` frontmatter is what
actually pins its cost. Use these subagents rather than ad-hoc delegation:

- **`finder`** (Haiku, low effort) — mechanical/low-risk work: grepping/searching
  for a symbol, reading files to answer a factual question, tracing where
  something is defined or used, simple rename/formatting edits.
- **`feature-worker`** (Sonnet, medium effort) — the default for most feature
  work, bug fixes, and refactors in this repo: normal-sized components, hooks,
  Firebase integration code.
- **`hard-problem-solver`** (Sonnet, high effort) — **last resort only, gated
  on token efficiency, not difficulty alone.** Reserve for cases where a
  `feature-worker` pass would likely cost *more overall* than paying for one
  higher-effort pass up front — because it would probably need a retry/rework
  cycle, or because a plausible-but-wrong fix would ship and need finding
  (and re-fixing) later: tricky concurrency/sync bugs (e.g. Firebase sync
  conflicts), recurrence-parsing logic, or cross-cutting refactors touching
  many files where a wrong first answer is expensive to unwind. Don't reach
  for it out of caution, or because a task merely "sounds hard" — the
  question is always "does skipping this tier cost more tokens in the end,
  via rework?", not "could this tier plausibly help?". That said, the failure
  mode of *under*-using it when it's genuinely warranted is worse than the
  failure mode of overusing it: skip it there and expect a higher chance of
  subtle bugs, missed edge cases, or a worse design than if it had been used.
  If unsure which tier a task needs, default to `feature-worker` and only
  escalate if it visibly struggles or the change turns out to be more
  cross-cutting than expected.
- **Effort ceiling:** no subagent in this repo should ever be configured with
  reasoning effort above `high` (`hard-problem-solver`'s tier) — there is no
  task here that justifies `xhigh`/`max`. Within that ceiling, keep each
  agent's configured effort at the lowest tier that reliably handles its
  job (see each file's `effort:` frontmatter) rather than defaulting high
  "to be safe."

When delegating, prefer naming the subagent explicitly (e.g. "use the finder
subagent to locate X") over a generic Task/Agent call — a generic call
inherits the main session's model instead of the cheaper tier.

Don't spawn subagents for tasks that are faster to just do directly (a single
grep, reading one known file).

## Git workflow

- **Never work directly on `main`.** Create a feature branch per unit of work:
  `feature/<short-description>` or `fix/<short-description>`.
- Commit as often as makes sense on the branch — don't worry about a clean history
  while iterating. If a small fix is needed on top of the previous commit, squash
  it into that commit rather than adding a separate one.
- **When merging back to `main`, always squash to a single commit.** No merge
  commits, no per-WIP-commit noise on `main`. Use `git merge --squash` (or the
  equivalent squash-merge on GitHub) so `main`'s history stays one commit per
  feature/fix.
- Write that final squashed commit message to describe the *why*, not a list of
  the intermediate steps.
- Delete the feature branch after it's merged into `main`, unless told otherwise.

### Two remotes: `main-history` vs `origin`/`main` — pushing work forward

This repo has two remotes that are NOT the same history: `taskflow_history`
(the local working branch `main-history` tracks this, and this is where the
squash-merge workflow above happens day to day) and `origin` (the deployed
`taskflow` repo, whose `main` branch has its own separate commit history —
currently just a few large snapshot commits, e.g. a "Deployment V1.0" dump).
They share a real common ancestor but have each moved on independently
since, so `main-history` is NOT simply ahead of `origin/main` — pushing
`main-history` straight onto `origin/main` would require a force-push and
would destroy whatever commits are unique to `origin/main`. Don't do that
without explicit, one-time confirmation from the user for that exact push.

**The normal way to bring the newest `main-history` work to `origin/main`**
is a cherry-pick onto a throwaway branch based on `origin/main`, not a merge
or a force-push:

```bash
git fetch origin
git checkout -b sync-<short-name> origin/main
git cherry-pick <sha> --no-commit
git commit -m "<simplified, user-facing message>"
git push origin sync-<short-name>:main
git checkout main-history
git branch -D sync-<short-name>
```

- Use `--no-commit` so the commit message can be rewritten short and plain
  (a squashed `main-history` commit's own message is often "Squashed commit
  of the following:" plus noise — don't carry that onto `main`).
- If the cherry-pick conflicts (expected — the two histories can genuinely
  contain independently-built, overlapping work, not just textual drift),
  resolve deliberately rather than reflexively taking one side. Check what
  each side's version actually is before picking — ask the user if it's not
  obvious which one should win.
- This lands as a plain fast-forward on `origin/main` (one new commit on top,
  no merge commit), since the cherry-picked branch is based on `origin/main`'s
  own tip.
- **Never push to `origin/main` without the user's go-ahead on that specific
  push** — prepare the branch/commit and stop there unless told to push.

**Authorship — never become a co-author.** Every commit pushed from this repo
must show the user as its sole author (and committer). This means:
- Never add a `Co-Authored-By` trailer to a commit destined for `main-history`
  *or* `origin/main` unless the user explicitly asks for one.
- When writing a commit yourself on the user's behalf (a squash-merge, a
  cherry-pick resolution, an amended message), use a plain `git commit -m
  "..."` with no trailer — don't reuse the heredoc-with-co-author pattern
  from an ordinary "create a commit for me" request. The commit's author
  field is already the user's configured git identity; don't add anything
  that would make it look shared.

### Concurrent sessions / worktrees

This repo is often worked on by more than one Claude Code session at once
(different windows/tasks against the same clone). A plain `git checkout`
operates on the one shared working directory, so switching branches while
another session has uncommitted changes checked out will silently carry
their dirty files along with you — and checking back away carries them
right back, potentially stripping in-progress work out from under that
other session. Signs you're not alone: `git worktree list` shows more than
one entry, or `git status`/`git reflog` shows branches or commits you don't
recognize from this conversation.

- Before creating a branch or committing, run `git worktree list` and
  `git status`. If the working directory has changes you don't recognize,
  don't assume they're stray — another session is probably mid-task.
- If you find yourself needing to switch away from a branch that has
  uncommitted changes that aren't yours, don't just `git checkout` past
  them. Use `git worktree add ../<name> <branch>` instead, so your work
  happens in its own directory and never touches the other session's dirty
  files. Do the same for `main` itself when squash-merging, if `main` isn't
  already checked out somewhere — don't check it out in a directory another
  session currently has parked on a different branch.
- If a mixup already happened (someone else's changes got carried onto your
  branch, or vice versa), untangle it with `git stash push -- <exact paths>`
  (stash only the specific files that are actually yours) rather than a
  blanket stash/reset — never discard or force-overwrite files you didn't
  create just to get back to a clean state.
- Clean up worktrees you created once done: `git worktree remove <path>`
  (add `--force` if a stale dev-server process is still holding the
  directory open — check `netstat`/kill the process rather than fighting
  the lock repeatedly).

## Changelog

**Every push that ships a user-visible change must update the changelog —
do this before considering the change done, not as an afterthought.**

- Add an entry to `src/changelog.js` (newest first) and bump `CURRENT_VERSION`
  (the first entry's `version`) — this drives the "What's New" popup
  (`ChangelogModal`, auto-shown once per version bump and reachable anytime
  from Settings → Versions).

### Version numbering (standard semver — read before bumping)

`MAJOR.MINOR.PATCH`, **each part a single digit that rolls over at 9**. Never
write a multi-digit part like `1.100.0`.

- **Patch** (`2.1.0` → `2.1.1`) — bug fix / small correction to something
  already shipped, no new capability.
- **Minor** (`2.1.3` → `2.2.0`) — a new user-visible feature, or a meaningful
  change to an existing one. The common case.
- **Major** (`2.9.0` → `3.0.0`) — the minor rolling past 9, or a genuine
  overhaul of how the app works. **`x.9.0` is followed by `(x+1).0.0`, not
  `x.10.0`** — reset the lower parts to zero on roll-over.

Always look at the previous entry's number and roll it properly rather than
incrementing the last component blindly. This has already gone wrong once
(`1.99.0` → `1.100.0`/`1.101.0`, since renumbered to `2.0.0`/`2.1.0`), which
is why the rule is spelled out here. Renumbering a shipped entry is safe —
`App.jsx` compares `lastSeenChangelogVersion` with `!==`, not ordered semver,
so it only re-pops "What's New" once — but get it right the first time.

The same number must appear in all three places: the first `CHANGELOG`
entry's `version`, `CURRENT_VERSION` (derived automatically), and
`package.json`'s `version`. See `docs/DEVELOPMENT.md` → "Versioning and the
changelog" for the same rule in the contributor docs.
- Write entries in plain English for end users, not a raw commit log — group
  same-day/same-branch commits into one entry, and skip anything with no
  user-visible effect (internal refactors, one-time migration code, etc.).
- Keep `package.json`'s `version` in sync with `CURRENT_VERSION` too, so
  there's one version number, not two.

## Development practices

- Read the actual file before editing it; don't assume structure from memory.
- Match existing code style in each file (this repo has no linter/formatter
  configured, so consistency is judged by eye).
- Keep changes scoped to what was asked; this is a small personal-scale app, not
  a place for speculative abstractions or config plumbing "for later."
- Choose the approach that best follows good programming practice for the
  effort involved — e.g. dynamic sizing + max-height for something whose
  content can grow over time, rather than a static size. This depends on
  context: if a value genuinely never needs to change, the simpler static
  approach is correct. Don't over-engineer for hypothetical futures.
- Firebase config/credentials must never be committed in plaintext — check before
  staging any file touching auth or Firebase setup.
- Ensure all UI changes are responsive and work well on mobile.
- Synced text (e.g. synced with Google Calendar and Todoist) doesn't need to be
  surfaced everywhere — only where it's relevant.
- Update the tutorial and README when a change affects what they document.
  Docs are split by audience, and `README.md` is deliberately kept short — a
  pitch, a quick start, a feature table, and an index. Prose belongs in the
  doc that owns the area, not the README: `docs/USAGE.md` (every tab, smart
  task titles, bulk select, palette), `docs/SYNC-AND-SHARING.md` (sign-in,
  cross-device sync, backups, shared projects), `docs/INTEGRATIONS.md`
  (Todoist, Google Calendar, AI Quick Add, notifications),
  `docs/HOSTING.md` (GitHub Pages, private network), `docs/LIMITATIONS.md`
  (what it doesn't do, and why), and `docs/DEVELOPMENT.md` (scheduler
  internals, data model, project layout, persistence, contributing
  conventions, tech stack, testing). Update whichever file actually documents
  the area you changed — a change can touch several. If a change makes the
  README's feature table or an index entry wrong, fix that too, but resist
  growing the README back into a manual.
- Before changing a component, check what else depends on it. E.g. adding a new
  input field may also require updating integrations with other apps (syncing/
  importing that new field).
- **When adding a new feature or field that's likely to get exposed broadly,
  explicitly list which cross-cutting systems it touches before considering
  the change done** — it's easy to ship the feature itself and forget the
  systems that fan out from it. Check each of: backups/restore
  (`BACKUP_FIELDS`, see Backups), cross-device cloud sync (`computeFingerprint`/
  `planRemoteDataMerge`/`applyRemoteData` in `useCloudSync.js`), smart-parse /
  natural-language input (`smartParse.js`, `dateParse.js` — does the new field
  need a parse path?), the AI quick-add prompt (does the model need to know
  this field exists to fill it in?), Google Calendar/Todoist sync
  (`eventSyncService.js`/`todoistSync.js`), and shared-project permissions/
  presence (if the field is visible to collaborators). Not every feature
  touches all of these — the point is to check each one deliberately rather
  than assume "it's just a UI field" and find out later it silently doesn't
  sync, back up, or get recognized by AI input.
- Keep data changes backwards compatible. If that's not possible or is too
  costly, write a one-time migration function to convert the old format to the
  new one — and remove that migration code once it's no longer needed (see
  code review checklist below).

### Adding a field to TaskDetailModal's sidebar/⋯ menu

`TaskDetailModal.jsx` autosaves those fields on a debounce, reconciled against
external changes. A new field must appear in **all seven** of these or it
misbehaves — and the failure is not local to the field:

1. local state + setter;
2. the initial `initialSnapshotRef.current` build;
3. the re-seed effect (both the snapshot AND a `setX(task.x)` reset);
4. the reconcile effect's `taskValues`, `setters` **and** `localValues` — all
   three, since it iterates `Object.keys(taskValues)` and indexes the others;
5. `sidebarDirty`, or an edit never triggers a save;
6. the `commitChanges` payload, or the edit is never persisted;
7. **the post-save `initialSnapshotRef` rebuild inside `commitChanges`.**

Miss 6 or 7 and the field stays dirty after its own save, so the debounce
re-arms forever: a write loop that pegs the CPU and kills the browser. It
surfaces as *unrelated* tests timing out with "Target page has been closed" and
the E2E suite running minutes longer — nothing pointing at the field. A targeted
test run passes while the full suite fails.

Verify by counting `localStorage` writes to `:tasks` around an edit: exactly one
per user action, and zero while idle afterwards. A functional assertion alone
passes happily with the loop running behind it (see
tasks-and-smart-parse.spec.js's "without a write loop" test).

### Cross-cutting concerns: sync, presence, and project state

The app has several interconnected systems that are easy to break when making
unrelated changes. **For ANY change, explicitly check the following:**

- **Cloud sync state (`useCloudSync.js`):** Any change to `SchedulerContext` fields,
  task properties, or data shapes requires reviewing whether `BACKUP_FIELDS`,
  `computeFingerprint`, `planRemoteDataMerge`, and `applyRemoteData` need
  updates. A missing sync path silently loses data on cross-device sync or
  restore, or worse, causes race conditions where stale snapshots resurrect
  deleted data. See Backups section for the full logic. Watch for: new field
  on Task/ScheduledBlock, new top-level collection, new user settings.
  
- **Shared project state (`useSharedProjects.js`, presence avatars, permissions):**
  When changing project deletion, access revocation, or state mutations, verify
  that local sidebar state mirrors the server's view. Fixes in this area have
  repeatedly caught: stale project lingering after deletion/kick, wrong presence
  avatars (out of sync with actual members), orphaned projects (deleted on
  server but stuck locally), false permission errors on first retry. When
  touching `removeProject`, `updateProjectMember`, permission checks, or
  project selection UI, trace the entire flow: deletion/revocation on server
  → listener fires → local state cleanup → sidebar/dropdown/view state updates.
  
- **Project selection and view filters:** The active project filter
  (`activeProjectId`) appears in multiple places: Project dropdown (navbar),
  view filters, task list queries. If you change how projects are listed,
  deleted, or accessed, verify that selecting a now-inaccessible project
  (e.g. you were kicked from it) gracefully falls back to a valid project
  rather than breaking the filter or showing a blank task list.
  
- **Multi-source sync conflicts (Google Calendar, Todoist, local Firebase):**
  Calendar events and task syncs have their own merge policies. `events` is
  deliberately excluded from live cross-device sync (only in point-in-time
  backups) to avoid stale snapshots resurrecting deleted events. Todoist sync
  has its own conflict resolution. If you add a new synced field or change how
  existing ones are merged, audit the merge logic in the relevant sync service
  (`eventSyncService.js`, `todoistSync.js`, `useCloudSync.js`) to ensure
  deletions and edits in one app don't cause silent resurrections or
  contradictions in another.

### Backups

Backups (local file export/import, and cloud snapshots in Firestore at
`users/{uid}/backups/{backupId}`) cover a fixed set of state fields, listed in
`src/services/backupService.js`'s `BACKUP_FIELDS` — treat that array as the source
of truth rather than duplicating its contents here, since it drifts. `BACKUP_FIELDS`
is also what the live cross-device Firestore sync pushes/pulls (see
`useCloudSync.js`'s `computeFingerprint`/`planRemoteDataMerge`), not just point-in-time
backups — the two share one field list. When adding a new piece of persisted state to
`SchedulerContext` (a new field on Task/ScheduledBlock, a whole new top-level
collection, or a setting a user would be sad to lose on a device switch), add it to
`BACKUP_FIELDS` and to `applyBackupPayload`/`applyRemoteData`/`computeFingerprint` in
`useCloudSync.js` too — otherwise it silently won't survive a restore or cross-device
sync, and the existing "restore all your data" button quietly stops being true. Not
every piece of persisted state belongs here, though — some are genuinely device-local
(theme's live sync is one exception living outside SchedulerContext, in ThemeContext;
dashboard widget visibility and view/filter selections are deliberately local-only,
per their own doc comments) — check whether a new field is "data the user would want
to keep" before reflexively adding it. Completed one-off tasks (and their blocks) are
deliberately excluded from every backup payload — recurring tasks are never marked
completed on finishing an occurrence (see `types/index.js`'s `Task.isRecurring`), so
they're unaffected by this filter.

**`events` (CalendarEvents) now lives in `BACKUP_FIELDS` AND live-syncs across
devices through Firestore, the same as `tasks`.** That wasn't always true, and the
history matters for anyone touching this code:

- The ORIGINAL design (before this note was rewritten) synced the whole `events`
  ARRAY as one blob — the same "take one side's entire array" shape `tasks` itself
  used to have, before a per-task merge fixed it (see `taskMerge.js`'s own doc
  comment). A stale device waking up and pushing its whole array could arrive at
  Firestore AFTER a genuinely newer deletion made on another device and silently
  overwrite it, purely because its write landed last — a deleted event would
  "resurrect" with no explanation. That risk was serious enough that `events` was
  excluded from live sync entirely for a long time, with only a point-in-time
  backup (a one-directional, explicit restore, not a continuous background
  reconciliation) treating it as safe to capture.
- The fix mirrors the one already proven for `tasks`: instead of syncing one array,
  `utils/eventMerge.js`'s `mergeEventsByUpdatedAt` merges EVENT BY EVENT, keeping
  whichever side's copy has the newer `localUpdatedAt` timestamp (the field
  `SchedulerContext.updateEvent` already stamps on every local edit). A genuine
  deletion is recorded as a TOMBSTONE (`utils/eventTombstones.js` — a `deletedAt`
  stamp, row kept instead of removed, heavy fields like `description`/`location`
  cleared) rather than a plain array removal, mirroring `taskTombstones.js`
  exactly. A tombstone with a newer timestamp than a stale conflicting edit wins
  (the deletion sticks); an edit with a newer timestamp than an old tombstone wins
  too (the event correctly "un-deletes" — the same non-bug `taskMerge.js`
  documents for tasks). This closes the original resurrection risk because no
  single device's write can ever silently clobber another device's newer change —
  each event converges on its own most-recent state, independent of write order.
- Wiring: `events` is part of `SchedulerContext`'s `cloudSyncState` (fed into
  `useCloudSync.js`'s `state`/`stateRef`) exactly like `tasks`/`sections`/etc., so
  it flows through `computeFingerprint`/`planRemoteDataMerge`/`applyRemoteData`
  and the debounced push effect automatically. `SchedulerContext` also exposes a
  tombstone-filtered `visibleEvents` (mirroring `visibleTasks`) so the calendar
  grid and every other UI consumer never sees a tombstone — only the sync/merge
  layer and local persistence work with the raw, tombstone-including array.
- **Independent of Google Calendar.** This is TaskFlow's OWN device-to-device
  sync through Firestore — it works whether or not Google Calendar is connected
  on either device, which is the point: previously, an event edit or delete only
  reached a second device if BOTH had their own independent Google Calendar
  connection talking to Google directly; a device with Google disconnected saw
  nothing. Google Calendar sync (`eventSyncService.js`'s `mergePulledGoogleEvents`,
  policy: Google always wins for a Google-sourced event, unconditionally, no
  timestamp exception) is a separate, pre-existing relationship, untouched by this
  change — it still governs a Google-sourced event's day-to-day content whenever
  Google is connected. The two coexist safely for edits: an edit on a
  Google-connected device pushes both to Google directly AND through Firestore, so
  when a disconnected device later reconnects Google and pulls, it's pulling the
  same edit — nothing is lost or contradicted. **One known, accepted gap:**
  deleting a Google-sourced event on a device with Google DISCONNECTED tombstones
  it locally and syncs that tombstone through Firestore, but never tells Google
  itself — Google's own copy stays live. If Google Calendar is later connected on
  any device and pulls, and the event is still live there, `mergePulledGoogleEvents`
  (which has no concept of `deletedAt`) will pull it back in, since it has no way
  to know the event was deleted through TaskFlow's own sync rather than genuinely
  still wanted. This is inherent to deleting something without telling the system
  that's still authoritative for it, not a bug in the merge above — fixing it
  would mean changing `eventSyncService.js`'s own policy, which is deliberately
  out of scope for this note.
- An old backup taken before this design was live-synced is still valid — a
  missing `events` key is treated as "leave it untouched," not rejected (see
  `isValidBackupPayload`'s doc comment in `backupService.js`).

**Automatic daily cloud backups, and independent retention for both pools:**
in addition to the manual "Back up now" button, `useCloudSync.js`
(`runAutomaticBackupIfDue`) creates a Firestore backup automatically once
per day while a user is signed in with cloud sync active — checked once on
mount and hourly thereafter (`AUTO_BACKUP_CHECK_INTERVAL_MS`), gated by a
persisted `lastAutoBackupAt` timestamp so a reload doesn't cause an extra
one. Each backup doc is tagged `automatic: true`/`false`
(`firestoreSync.createBackup`'s option, defaulting to `false` for a manual
backup) so retention can tell them apart.

**Both automatic and manual backups are pruned, but against two independent
retention counts — not one shared pool:** automatic backups are capped at
the 14 most recent (`AUTO_BACKUP_RETENTION_COUNT`), and manual "Back up now"
backups are separately capped at their own 14 most recent
(`MANUAL_BACKUP_RETENTION_COUNT`) — up to 14 of each can coexist, for up to
28 total. This is a deliberate reversal of this project's earlier
design (manual backups used to never be pruned); the constants are separate
so the two counts don't have to move together if that changes again.
`planAutoBackupPrune` (a pure, unit-tested function, despite its name still
matching its original automatic-only purpose) takes a `wantAutomatic`
argument so the same "keep the N most recent, delete the rest oldest-first"
logic can decide either pool's deletions — `useCloudSync.js`'s
`pruneBackupPool` wraps it into one shared prune step used by both pools.
Manual-pool pruning runs in two places: right after `createCloudBackup`
creates a new manual backup (so repeated manual backups in one session get
pruned back down immediately, not after a day's wait), and again inside
`runAutomaticBackupIfDue`'s daily/hourly check as a catch-all. `MAX_LISTED_
BACKUPS` in `firestoreSync.js` was raised (20 → 40) so the "view backups"
list still shows a healthy mix of both kinds.

Either prune step must NOT source its candidate list from `listBackups` (the
"most recent 40 overall" query backing the display list) — enough backups
of one kind can push an old backup of the other kind outside that shared
40-doc window, and once it's outside the window `planAutoBackupPrune` never
even sees it, so it becomes permanently un-prunable and that pool's cap
silently breaks. `firestoreSync.listAutomaticBackups(uid)` and its sibling
`listManualBackups(uid)` exist specifically to avoid this: each is a
separate query filtered by `where('automatic', '==', true/false)` (not
client-side filtering) with no "most recent N overall" cap — only a
generous sanity ceiling (200 each) against a bug elsewhere causing runaway
growth, since each pool is already self-limiting to ~14 in steady state.
`pruneBackupPool` uses whichever lister matches the pool being pruned, and
`runAutomaticBackupIfDue` separately re-fetches via `listBackups` afterward
to refresh the "view backups" display list — pruning correctness and what's
shown in the UI are two different concerns and must keep using the right
query for each.

### Firebase data retention and cleanup policies

**Any new data stored to Firestore (in users/{uid}/* or any other path) must
have a documented retention policy.** The app already enforces retention in
several places; follow the same patterns:

- **Backups:** pruned via `pruneBackupPool` based on `AUTO_BACKUP_RETENTION_COUNT`
  and `MANUAL_BACKUP_RETENTION_COUNT`. Separate retained pools prevent one kind
  from pushing the other outside a shared list query's window.
  
- **Google Calendar sync metadata:** `eventSyncService.js`'s `isTooOldToRetain`
  actively purges non-recurring events outside the sync window (`ROUTINE_SYNC_
  WINDOW_DAYS`), enforced via an explicit purge boundary that tracks the union
  of all synced ranges (not just the current call's range) to survive on-demand
  fetches. Recurring events' own recurrence rule outlives their DTSTART, so they
  stay. Deleted event IDs are suppressed for `RECENTLY_DELETED_TTL_MS` to prevent
  resurrections from slow API propagation.
  
- **Todoist sync:** follows Google Calendar's pattern — pulled items win; local
  sync metadata ages out.

- **Deleted-task and deleted-event tombstones:** a task or event delete doesn't
  remove the row immediately — it's stamped with a `deletedAt` tombstone instead
  (`utils/taskTombstones.js` / `utils/eventTombstones.js`), so the cross-device
  merge has a real chance to see the deletion before it's gone for good. Each is
  swept once per app load: `SchedulerContext`'s "deleted task retention sweep"
  effect purges a task tombstone older than `RETENTION_DAYS_DELETED_TASKS` (30
  days), and its "deleted event retention sweep" effect does the same for an
  event tombstone against `RETENTION_DAYS_DELETED_EVENTS` (also 30 days) — both
  constants live in `dataRetention.js`. Long enough that a device offline for a
  realistic stretch still sees the tombstone before it's swept; too-early
  sweeping would let a returning device see the item as merely "missing" rather
  than "deleted" and push it back into existence.

When you add new persisted state to Firestore:
1. Choose a retention strategy (count-based like backups, time-based like
   calendar, or unlimited if it's already bounded elsewhere like user tasks).
2. Document the strategy in a comment where the data is created.
3. Implement the cleanup: a periodic prune function (called from `useCloudSync.js`'s
   auto-backup pass, or inline during the sync that created it), or an active
   check during reads (like `isTooOldToRetain` at sync time).
4. Test that old data is actually purged, not just left behind — stale data
   silently leaking to production is one class of bug that's hard to fix
   retroactively.

## Testing

- Treat `npm run build` as the minimum bar before calling a change done; run
  it after non-trivial edits. Running the full test suites (`npm run
  test:unit`, the Playwright suite) is **not** required for every commit —
  that's a code review checklist step, not a per-change one (see Code review
  checklist below).
- **For every change, explicitly check both test suites for whether they need
  updating or a new test added** — not just whether the existing ones still
  pass. Playwright (`tests/e2e/full-suite/`) covers user-facing behavior;
  the unit suite (`tests/unit/`) covers error-prone pure logic (date math,
  parsing, merge/race-guard decisions, migrations — see below). A change can
  need one, the other, both, or neither; don't assume a non-UI change is
  exempt from Playwright, or that an internal logic change is exempt from
  unit tests — check against each suite's own "keep in sync" rule. This is
  about keeping *coverage* in sync with the app, independent of whether you
  actually run either suite for this change.
- For UI or frontend changes, start the dev server and use the feature in a
  browser before reporting the task as complete. Test the golden path and edge (only if is a large change)
  cases, and watch for regressions in other features.
- **Do not reach for ad-hoc Playwright/browser automation on small or
  contained UI changes** (a modal, a button, a single component) — it's
  disproportionate setup cost for the size of the change. For these, rely on
  `npm run build`, a careful read-through of the diff, and/or asking the user
  to click through it themselves. Reserve one-off browser automation for a
  genuinely large change where it's the only practical way to verify it (e.g.
  a multi-step flow across several views).

### Full E2E suite (`tests/e2e/full-suite/`)

There IS a maintained, tracked Playwright suite — don't confuse it with
`tests/e2e/manual/` (gitignored, throwaway exploratory scripts) or
`tests/e2e/todoist-parity.spec.js` (a separate one-off parity check against
Todoist's own web app). The full suite works headless with no real
authentication needed: the app runs fully local against `localStorage` with
seeded mock data (`src/services/mockData.js`) whenever no one is signed in —
Firebase auth only gates optional cloud sync, never the UI itself.

- Run it with `npm run test:e2e -- tests/e2e/full-suite` (or omit the path to
  run everything under `tests/e2e/`). `playwright.config.js`'s `webServer`
  block boots the dev server automatically and reuses one already running on
  port 5183, so no manual setup is required.
- Suite layout: `helpers.js` (shared `gotoApp`/`gotoTab`/`openAddTask`/
  `trackConsoleErrors`/etc. — reuse these, don't re-duplicate boilerplate) plus
  one spec file per feature domain (tasks/smart-parse, views, dashboard/stats,
  settings/backups, search/shortcuts/undo, timer/AI-quick-add).
- Coverage isn't limited to happy-path clicking: it also includes drag-and-drop
  (Board column moves, section reassignment, calendar event rescheduling),
  error paths (corrupt/invalid backup restore, circular-dependency prevention,
  deleting the project currently selected as the active view filter),
  multi-step undo/redo chains, and a mobile-viewport pass. When adding new
  coverage, prefer extending one of these categories over only ever testing
  the golden path.
- **Keep it in sync with the app: whenever you add or materially change a
  user-facing feature, add or update the corresponding test(s) in this suite
  in the same change** — don't treat it as a one-time artifact. If a feature
  doesn't fit an existing spec file's domain, add a new one alongside the
  others rather than bloating an unrelated file.
- It does not need to be run after every small change (see the "ad-hoc
  Playwright" guidance above for those) — see the code review checklist for
  when a full run is expected.

### Unit test suite (`tests/unit/`)

A Vitest suite covers the app's error-prone pure logic — the kind of edge
cases (date/timezone math, recurrence rollover, race-condition guards) that
are easy to miss by reading a diff and impractical to exercise through the
UI. Run it with `npm run test:unit` (wired via `vitest.config.js`, which only
picks up `tests/unit/**/*.test.js`).

Current coverage: recurrence & recurrence-expansion date math
(`src/utils/recurrence.js`, `src/utils/recurrenceExpansion.js`), interval/
capacity scheduling math (`src/utils/intervalUtils.js`,
`src/algorithms/capacityEngine.js`), the cost-minimizing scheduler
refinement (`src/algorithms/placementCost.js`, `src/algorithms/localSearch.js`
— fragmentation/due-date cost terms, never-worse-than-seed guarantee,
transitive dependency-ordering enforcement), natural-language date/duration
parsing (`src/utils/dateParse.js`, `src/utils/smartParse.js`,
`src/utils/durationParser.js`, `src/utils/wordNumbers.js`), backup/restore
field-parity and payload validation (`src/services/backupService.js`),
dependency-cycle detection (`src/utils/dependencyUtils.js`), the one-shot
`migrateBlockedTimeToEvents` migration, and the cloud-sync fingerprint/race-
guard/merge-decision logic extracted from `src/hooks/useCloudSync.js`
specifically so it could be unit tested.

- **Keep it in sync with the app: whenever you add or materially change logic
  in one of the areas above (or introduce a new piece of similarly tricky
  pure logic — date math, parsing, merge/race-guard decisions, migrations),
  add or update the corresponding test(s) in this suite in the same change**
  — don't treat it as a one-time artifact, the same rule as the E2E suite
  below. If new logic doesn't fit an existing test file's domain, add a new
  file alongside the others rather than bloating an unrelated one.
- If sync-critical logic (e.g. anything in `useCloudSync.js`) is hard to unit
  test because it's a closure over hook-internal refs/state, prefer
  extracting the pure decision as a standalone exported function (taking
  plain arguments, no side effects) over leaving it untested — see how
  `computeFingerprint` and the race-guard/merge-decision functions were
  pulled out for precedent. Any such extraction must be a behavior-preserving
  refactor only; verify old and new code make identical decisions for the
  same inputs before trusting it.


## UI invariants and design direction

The "Quiet density" UI overhaul (2026-08-21) established these. They outlived
the workstreams that produced them, so they live here rather than in a
gitignored working file.

### Design direction — check UI decisions against these four rules

1. **Space and tone separate things; borders don't.** Borders survive in
   exactly two roles: the boundary of an interactive control, and a focus ring.
   Decorative dividers are gaps; nested bordered containers are flattened.
2. **Hierarchy comes from weight and scale.** The 7-step type scale exists —
   use it rather than compensating with badges and rules. Fraunces
   (`--font-display`) stays rare: page and card titles only.
3. **Never render the absence of information.** A row does not print "no due
   date" or a `low` priority badge. The absence of a badge *is* the signal.
4. **Motion explains causality or it doesn't ship.** No ambient drift.
   Everything gated on `useMotionEnabled` + `prefers-reduced-motion`. Three
   named roles exist on the duration/easing tokens in `global.css` —
   `--motion-enter-*` / `--motion-exit-*` / `--motion-emphasis-*` — and new
   transitions should use them rather than inventing their own timing.
   framer-motion transition objects can't read CSS custom properties, so
   `ROW_TRANSITION`/`ROW_EXIT`/`CARD_TRANSITION`/`CARD_EXIT` mirror the numbers
   in JS; keep them in step.

### Never violate these — each one is a fixed bug or an accessibility floor

- **`.btn`'s 1px border is load-bearing.** The button fill sits too close in
  tone to its surfaces, and the border is what satisfies WCAG 1.4.11 (3:1
  non-text contrast). Never remove it. Same for input and checkbox boundaries.
- **`--color-text-muted` measures ~2.4:1 and is decorative-only.** Never use it
  for anything that conveys information.
- **`calendarLayout.js`'s maths are accumulated bug fixes.**
  `MIN_BLOCK_HEIGHT_PX`, `COMPACT_BLOCK_HEIGHT_PX`, `MAX_SIDE_BY_SIDE_LANES`,
  `EXCESSIVE_PUSHDOWN_PX`, cluster-folding and `packLane` each encode a real
  fixed bug (most recently v9.4.0: short *events* were exempt from folding, so
  three 10-minute events rendered as 10px slivers while three identical task
  blocks correctly clustered). Visual changes only — never touch the thresholds
  or the maths. **If a change genuinely must** (v9.4.0 did), pin BOTH directions
  in `tests/unit/calendarLayout.test.js` before touching anything — the case
  that must fold AND the case that must not — because every past bug here was a
  fix in one direction that silently broke the other. Relatedly, keep transitions to
  `transform`/`opacity`/`box-shadow`: anything animating
  `top`/`left`/`height`/`width` collides with WeekView's absolute-position
  pixel maths.
- **`SelectMenu`/`MentionDropdown` are portaled to `document.body`** to escape
  `.modal`'s `overflow-y: auto` clipping, and `.select-menu-dropdown` uses
  `z-index: 200` to clear `.modal-overlay`'s 100. Preserve both; don't create a
  new stacking context that re-clips them.
- **Any new high-z-index surface must be checked against the guided tour
  overlay.** That exact bug already hit `JoinProjectModal` once.
- **Escape goes through `useEscapeLayer`, never a keydown handler.** One
  shared stack decides who handles it, and the innermost registered layer
  wins. A raw `if (e.key === 'Escape')` on an element inside a modal or an
  anchored menu will NOT fire — the stack listens at document capture and
  stops propagation, which is the only way a dropdown can beat the modal
  containing it. Seven such handlers were silently dead before this existed,
  and the visible symptom was Escape discarding a whole draft task rather
  than closing the picker the user was looking at. Register with
  `useEscapeLayer(active, onEscape)` on the state that makes your surface
  dismissible — not on mount, or it lands *below* its own modal (child
  effects run before parent ones).
- **Touch targets must hold at the 639px breakpoint.** Consolidated toolbars
  are where hit areas quietly shrink.

### Deliberately not doing (don't "helpfully" add these)

- Not rebuilding the token system — there are 5 stray colour literals in the
  whole app outside `:root`. It works; extend it, don't replace it.
- Not adding a component library. The shared primitives (`Modal`, `EmptyState`,
  `Badge`, `NumberField`, …) replace code that already existed many times over.
  That's consolidation, not architecture.

## Code review checklist

- Maintainable, efficient, modular, follows good programming practices for the
  languages used.
- Comments are concise, up to date, and in plain English — not exhaustive, just
  enough that a reader understands the file, plus callouts for anything
  non-obvious (unique features, or the reason something was done a specific way).
  A comment longer than a couple of sentences must be broken into short
  paragraphs, a bulleted/numbered list, or labelled sub-points — never one dense
  prose block a reader has to re-read to parse. This applies equally to doc
  updates (`docs/*.md`), not just inline code comments.
- Write for someone with no technical background: assume the reader doesn't
  know what a "hook," "callback," or "race condition" means, and explain what a
  piece of logic actually does in everyday terms before (or instead of) naming
  the mechanism. This applies to both code comments and doc updates. Keep full
  detail — don't cut anything a maintainer would need — just say it plainly
  rather than skipping the explanation because the term feels self-evident to
  someone who already knows it.
- Write it as a real document someone sat down and composed, not a reply typed
  out in a chat. No "as discussed above," "in this session," "I changed X," or
  other language that only makes sense as one turn in a conversation — a
  comment/doc must stand on its own for someone opening the file cold, with no
  memory of how the change came about.
- No repeated code or worse-than-necessary implementations where a clearly
  cleaner approach exists in meaningfully fewer lines (skip if the win is minor).
- Before adding new code, check whether an existing utility/component/hook
  already does this and can be reused or extended instead of duplicated.
- One-time/migration code has been removed once it's no longer needed.
  **Due now: the `src/migrations/` sweep.** `migrateBlockedTimeToEvents`,
  `migrateRecurrenceConsistency`, `migrateStaleRecurringRemainingHours` and
  `migrateSubtasksToTasks` all carry "SAFE TO DELETE after ~2026-09" headers;
  `migrateRecurrenceState` has its own criterion, so check it in the same pass.
  Deleting one means removing the file, its test, its call site in
  `SchedulerContext.jsx`, and its `*MigrationDone` persisted flag.
  Two things to know before doing it, so the decision isn't re-derived:
  (1) each header says to wait until "telemetry/support shows no remaining
  users" — **this app has no telemetry**, so that criterion can never actually
  be satisfied and the date is the only usable signal; (2) the guard flags are
  device-local `localStorage`, not synced, so "already migrated" is per-browser.
  The residual risk of deleting is therefore a device that has never loaded a
  post-migration build — including someone restoring a pre-migration backup —
  no longer getting backfilled. Decide against that, not against telemetry.
  `ensureProtectedSleepRoutine` was deliberately moved OUT of `src/migrations/`
  (it's a permanent invariant, now in `src/utils/`) so this sweep can't take it
  — don't move it back.
- No dead code left behind by the change itself — old components, props,
  branches, or imports that this change made obsolete (not just migration
  code) have been deleted, not left unreferenced.
- Every feature's implementation is complete across integrations, syncing, and
  any other consumer of what changed (see "Before changing a component" under
  Development practices).
- UI changes are responsive and usable on mobile (see Development practices).
- Any new persisted state has been added to `BACKUP_FIELDS` and
  `restoreFromBackup`, or deliberately left out as device-local (see Backups).
- **Sync-critical checks (see "Cross-cutting concerns" above):**
  - If change touches `SchedulerContext` fields or task data shape: verify
    `BACKUP_FIELDS`, `computeFingerprint`, `planRemoteDataMerge`, and
    `applyRemoteData` all know about the new/changed field.
  - If change touches project deletion, access revocation, or project state:
    verify full flow from server deletion/kick → listener → local cleanup →
    sidebar/dropdown/view state. Watch for: stale projects lingering, orphaned
    remote projects, false permission errors, broken filters when project is
    no-longer-accessible.
  - If change adds or alters synced fields (Google Calendar, Todoist, or
    cross-device): audit the merge policy to ensure deletions don't cause
    silent resurrections or contradictions across apps.
  - If change adds new Firestore storage (users/{uid}/* or elsewhere): verify
    a retention policy is documented and implemented. See "Firebase data
    retention and cleanup policies" in Development practices.
- `npm run build` passes, and `npm run test:unit` passes and has been updated
  to cover whatever the change added or altered in the areas listed under
  Unit test suite.
- For a **big/cross-cutting change** (touches many files, a core data flow,
  or several features at once): the full E2E suite (`tests/e2e/full-suite/`,
  see Testing) has been run and passes, and it's been updated to cover
  whatever the change added or altered. Not required for small/contained
  changes — see Testing for that distinction.
- No Firebase config/credentials or other secrets are committed in plaintext.
- If the change is user-visible, `src/changelog.js` has a new entry and
  `CURRENT_VERSION` is bumped, with `package.json`'s `version` kept in sync
  (see Changelog).
