# Taskflow — Working Agreement

React + Vite + Firebase task manager. `npm run build` is the per-change correctness
check (catches type/import/build errors); a Vitest unit suite and a Playwright E2E
suite exist too, but running them isn't required on every commit — see Testing.

## Temporary model/effort cap (remove when user lifts it)

**Until further notice: only Sonnet at medium effort, for the main session and
every agent/subagent. Never use any agent or subagent above this (no high/xhigh/
max effort, no Opus), for any task regardless of how hard it seems.** This
overrides the per-tier guidance below — `hard-problem-solver` is temporarily
capped at medium effort (its file has been annotated accordingly) instead of its
normal high effort. Lower-cost tiers (e.g. `finder`'s Haiku/low) are unaffected,
since they're below the cap, not above it.

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
  The README was split: user-facing setup/usage stays in `README.md`;
  scheduler internals, data model, project layout, persistence, contributing
  conventions, tech stack, and testing live in `docs/DEVELOPMENT.md` — update
  whichever file actually documents the area you changed (a change can touch
  both).
- Before changing a component, check what else depends on it. E.g. adding a new
  input field may also require updating integrations with other apps (syncing/
  importing that new field).
- Keep data changes backwards compatible. If that's not possible or is too
  costly, write a one-time migration function to convert the old format to the
  new one — and remove that migration code once it's no longer needed (see
  code review checklist below).

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

**`events` (CalendarEvents) is a special case: it's in `BACKUP_FIELDS` (point-in-time
backups DO capture it) but deliberately excluded from LIVE cross-device Firestore
sync.** Google Calendar remains the authoritative store for events day-to-day (see
`useGoogleCalendarSync.js`), and round-tripping the same data through a continuously-
reconciled second store (the live Firestore doc `useCloudSync.js`'s
`computeFingerprint`/`planRemoteDataMerge`/`applyRemoteData` sync against) caused real
bugs: a stale cross-device snapshot could silently resurrect an event a user had
already deleted (in TaskFlow or directly in Google Calendar), on top of whatever the
Google Calendar sync's own merge policy (`eventSyncService.js`) was already doing. A
point-in-time backup doesn't have that failure mode — restoring one is an explicit,
one-directional, user-initiated action (not an automatic background reconciliation),
so it's safe to include `events` there as a safety net for "my local storage got
wiped" / "I need to roll back to an old snapshot" scenarios. Concretely: `events`/
`setEvents` are passed to `useCloudSync.js` as separate params (same pattern as
`theme`/`setTheme`) so `buildBackupPayload`/`applyBackupPayload` (backup export/
restore, in `backupService.js` and `useCloudSync.js` respectively) can read/write
them, while the `state`/`stateRef` bundle that feeds `computeFingerprint`/
`pushUserData`/`applyRemoteData` (the live-sync path) never includes them. An old
backup taken before `events` joined `BACKUP_FIELDS` is still valid — a missing
`events` key is treated as "leave it untouched," not rejected (see
`isValidBackupPayload`'s doc comment in `backupService.js`). Do not add `events` to
the live-sync path (`computeFingerprint`/`planRemoteDataMerge`/`applyRemoteData`, or
`SchedulerContext`'s `cloudSyncState`) without a strong reason and updating this note
plus the README's own Backups section.

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

## Code review checklist

- Maintainable, efficient, modular, follows good programming practices for the
  languages used.
- Comments are concise, up to date, and in plain English — not exhaustive, just
  enough that a reader understands the file, plus callouts for anything
  non-obvious (unique features, or the reason something was done a specific way).
- No repeated code or worse-than-necessary implementations where a clearly
  cleaner approach exists in meaningfully fewer lines (skip if the win is minor).
- Before adding new code, check whether an existing utility/component/hook
  already does this and can be reused or extended instead of duplicated.
- One-time/migration code has been removed once it's no longer needed.
- No dead code left behind by the change itself — old components, props,
  branches, or imports that this change made obsolete (not just migration
  code) have been deleted, not left unreferenced.
- Every feature's implementation is complete across integrations, syncing, and
  any other consumer of what changed (see "Before changing a component" under
  Development practices).
- UI changes are responsive and usable on mobile (see Development practices).
- Any new persisted state has been added to `BACKUP_FIELDS` and
  `restoreFromBackup`, or deliberately left out as device-local (see Backups).
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
