# TaskFlow

TaskFlow is a task manager with a scheduler attached. You add tasks and fixed
commitments; it works out *when* each task actually gets done, fitting the work
into your real free time around your deadlines instead of just sorting a list.

It runs out of the box on local sample data — every view and every feature
works with nothing connected, no account, no setup.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. A guided tour walks you through the main views
on first load (replay it anytime from **Settings → Help**).

## What it does

| | |
|---|---|
| **Auto-scheduling** | A capacity-aware engine places each task in your free time, balancing deadlines, priorities, buffer days, and work hours. **Re-balance schedule** re-plans everything unlocked; lock a block to pin it. |
| **Calendar** | Month / Week / 3 Day / Day, full 00:00–24:00 grid, drag to move, drag an edge to resize, on desktop and by touch. |
| **Tasks** | One page, three views — sortable List, Kanban Board, burn-down Gantt — with subtasks, dependencies, recurrence, tags, and comment threads. |
| **Smart input** | Type *"Call dentist tomorrow p2 every month"* and the due date, priority, and recurrence are detected as dismissible chips. |
| **AI Quick Add** | Describe what you want, or paste a screenshot or PDF, and review the proposed changes before any are applied. Bring your own API key. |
| **Projects & sharing** | Projects, sections, and a searchable directory. Any project can be shared by link for live collaboration, no account needed to join. |
| **Sync & backups** | Optional Google sign-in syncs everything live across devices, with automatic daily cloud snapshots plus file export/import. |
| **Integrations** | One-click import from Todoist; two-way Google Calendar event sync. |
| **Notes** | Folder-organized markdown notes with a WYSIWYG editor, checklists, and Markdown export. |
| **Notifications** | In-app alerts for tasks starting soon, overdue, or due today, plus an optional self-hosted email channel. |

Undo/redo, a `Ctrl+K` command palette, typo-tolerant search, bulk select,
rebindable keyboard shortcuts, and light/dark themes throughout. Fully
responsive down to phone width, and installable as a PWA.

## Documentation

**Using TaskFlow**

- **[Using the app](docs/USAGE.md)** — a tour of every tab, plus smart task
  titles, bulk select, and the command palette.
- **[Sync, backups, and sharing](docs/SYNC-AND-SHARING.md)** — signing in,
  cross-device sync, backups and restore, and shared projects.
- **[Integrations](docs/INTEGRATIONS.md)** — Todoist, Google Calendar, AI
  Quick Add, and notifications.
- **[Known limitations](docs/LIMITATIONS.md)** — what it doesn't do, and why.

**Running your own copy**

- **[Hosting](docs/HOSTING.md)** — a public copy on GitHub Pages, or a private
  one on your own network.
- **[Sync setup](docs/SYNC-AND-SHARING.md#account--cross-device-sync)** — the
  Firebase project sign-in and shared projects need.
- **[`cloudflare-worker/README.md`](cloudflare-worker/README.md)** — the
  companion Worker behind AI Quick Add, share links, and persistent Google
  Calendar auth.
- **[`notify-worker/README.md`](notify-worker/README.md)** — the scheduled job
  behind email notifications.

**Working on TaskFlow itself**

- **[Development](docs/DEVELOPMENT.md)** — scheduler internals, data model,
  project layout, persistence, testing, and contribution conventions.

## Building

```bash
npm run build     # outputs to dist/
npm run preview   # serve the production build locally
npm run test:unit # unit suite
npm run test:e2e  # Playwright suite
```

## A note on privacy

There is no TaskFlow server. Everything lives in your browser's
`localStorage` by default, and the optional cloud sync writes to a Firebase
project *you* own, locked to your own account by the rules in
[`firestore.rules`](firestore.rules).

Every credential is bring-your-own and stays in your browser: your Todoist
token, your Anthropic or Gemini API key, your Google Calendar grant. None of
them is ever sent to whoever deployed the app, and none is baked into a build.
