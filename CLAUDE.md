# Taskflow — Working Agreement

React + Vite + Firebase task manager. No test suite configured; `npm run build` is the
main correctness check (catches type/import/build errors).

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
of truth rather than duplicating its contents here, since it drifts. When adding a
new piece of persisted state to `SchedulerContext` (a new field on Task/
ScheduledBlock, a whole new top-level collection, or a setting a user would be sad
to lose on a device switch), add it to `BACKUP_FIELDS` and to `restoreFromBackup` in
`SchedulerContext.jsx` too — otherwise it silently won't survive a restore, and the
existing "restore all your data" button quietly stops being true. Not every piece of
persisted state belongs here, though — some are genuinely device-local preferences
(theme's live sync is the one exception living outside SchedulerContext, in
ThemeContext; dashboard widget visibility and view/filter selections are deliberately
local-only, per their own doc comments) — check whether a new field is "data the user
would want to keep" before reflexively adding it. Completed one-off tasks (and their
blocks) are deliberately excluded from every backup payload — recurring tasks are
never marked completed on finishing an occurrence (see `types/index.js`'s
`Task.isRecurring`), so they're unaffected by this filter.

## Testing

- There's no test suite — treat `npm run build` as the minimum bar before
  calling a change done; run it after non-trivial edits.
- For UI or frontend changes, start the dev server and use the feature in a
  browser before reporting the task as complete. Test the golden path and edge
  cases, and watch for regressions in other features.
- You may install and use Playwright to test, but only for a big change that
  genuinely needs browser automation to verify.

## Code review checklist

- Maintainable, efficient, modular, follows good programming practices for the
  languages used.
- Comments are concise, up to date, and in plain English — not exhaustive, just
  enough that a reader understands the file, plus callouts for anything
  non-obvious (unique features, or the reason something was done a specific way).
- No repeated code or worse-than-necessary implementations where a clearly
  cleaner approach exists in meaningfully fewer lines (skip if the win is minor).
- One-time/migration code has been removed once it's no longer needed.
- Every feature's implementation is complete across integrations, syncing, and
  any other consumer of what changed.
