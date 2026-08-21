/**
 * Static content for GuidedTour — each step names the tab it lives on (so
 * the tour can switch tabs as it advances) and a `[data-tour="..."]`
 * selector for the real on-screen element to spotlight. Kept separate from
 * the component so copy edits don't require touching positioning logic.
 */

export const GUIDED_TOUR_STEPS = [
  {
    // The mobile topbar (and its data-tour="brand" mark) only renders on the
    // Dashboard tab now (see App.jsx) — pin this step there explicitly
    // rather than `tab: null`, so replaying the tour from Settings still
    // lands on a tab where the brand mark actually exists instead of
    // falling back to a spotlight-less centered tooltip.
    tab: 'dashboard',
    selector: '[data-tour="brand"]',
    placement: 'right',
    title: 'Welcome to TaskFlow',
    body: 'TaskFlow turns your task list into an auto-scheduled calendar. This short tour points out where everything lives — replay it anytime from Settings.',
  },
  {
    tab: 'dashboard',
    selector: '[data-tour="nav-dashboard"]',
    placement: 'right',
    title: 'Dashboard',
    body: 'Your home base — what\'s due, what you\'re doing right now, today\'s agenda, this week\'s progress, and your notes, all at a glance.',
  },
  {
    tab: 'calendar',
    selector: '[data-tour="nav-calendar"]',
    placement: 'right',
    title: 'Calendar',
    body: 'Your auto-scheduled work, day by day. Drag a block to move it, or let Re-balance schedule place everything for you.',
  },
  {
    tab: 'calendar',
    selector: '[data-tour="new-event"]',
    placement: 'bottom',
    title: 'New event',
    body: 'Add any event — a meeting, appointment, or anything else that is not a task — and drag it to move, or drag its edge to resize. Re-balance schedule plans around it automatically.',
  },
  {
    tab: 'calendar',
    selector: '[data-tour="rebalance"]',
    placement: 'bottom',
    title: 'Re-balance schedule',
    body: 'Whenever due dates, priorities, or capacity change, hit this to re-plan all unlocked work across your work hours and buffer days.',
  },
  {
    tab: 'tasks',
    view: 'list',
    selector: '[data-tour="nav-tasks"]',
    placement: 'right',
    title: 'Tasks',
    body: 'Everything on your plate, in one page — switch between a flat sortable List, a Todoist-style Board, and a burn-down Gantt view without leaving it.',
  },
  {
    tab: 'tasks',
    selector: '[data-tour="add-task"]',
    placement: 'bottom',
    title: 'Add a task, the fast way',
    body: 'Type naturally: "Call dentist tomorrow p2 every month" auto-detects a due date, priority, and recurrence as dismissible chips.',
  },
  {
    // The real `[data-tour="ai-quick-add"]` mini-FAB only mounts once the
    // "Add task" button's speed-dial is expanded (see AddTaskFabGroup) — it
    // doesn't exist in the DOM otherwise, so pointing this step at it would
    // silently time out and fall back to a spotlight-less tooltip on every
    // run. Target the always-present main button instead.
    tab: 'tasks',
    selector: '[data-tour="add-task"]',
    placement: 'bottom',
    title: 'AI Quick Add',
    body: 'Tap this button to expand a small "AI Quick Add" option next to it. Type — or paste a screenshot or PDF of an email, text, or flyer — and let AI propose changes across your tasks, events, projects, and subtasks/dependencies: creating, editing, moving, or deleting them. You review and approve each change before anything is applied. Needs your own Anthropic or Gemini API key added in Settings → Integrations first; tap the "?" inside the panel for the full setup guide.',
  },
  {
    tab: 'tasks',
    selector: '[data-tour="tasks-view-switch"]',
    placement: 'bottom',
    title: 'Switch views',
    body: 'List, Board, or Gantt — same tasks, three ways to see them. Board groups them into boards and sections; Gantt shows burn-down bars across your planning horizon.',
  },
  {
    tab: 'projects',
    selector: '[data-tour="nav-projects"]',
    placement: 'right',
    title: 'Projects page',
    body: 'A directory of everything: search for any project, or browse Recent, Shared, and My Projects — sortable by size, duration, or when you created them.',
  },
  {
    tab: 'projects',
    selector: '[data-tour="manage-projects"]',
    placement: 'left',
    title: 'Creating projects',
    body: 'Create as many projects as you like to separate work, personal life, or any other area — pin your favorites, rename or delete any of them, and switch between them from here, the Tasks page (including its own collapsible "all projects" panel), or the search bar. Each project\'s "⋯" menu also lets you share it via a link, so others can view or edit it with you.',
  },
  {
    tab: 'stats',
    selector: '[data-tour="nav-stats"]',
    placement: 'right',
    title: 'Stats',
    body: 'A summary of your scheduled capacity and workload.',
  },
  {
    tab: 'settings',
    selector: '[data-tour="account-card"]',
    placement: 'top',
    title: 'Sync across devices',
    body: 'Sign in with Google (also available from the account button in the sidebar/topbar) to keep your tasks, boards, and settings automatically up to date across your phone and computer — usually within seconds of a change. Fully optional — staying signed out keeps TaskFlow exactly as local-only as it is today.',
  },
  {
    tab: 'settings',
    selector: '[data-tour="integrations-card"]',
    placement: 'top',
    title: 'Connect your tools',
    body: 'Paste a Todoist API token to replace the sample tasks with your real ones, and connect Google Calendar for two-way calendar sync.',
  },
  {
    tab: 'settings',
    selector: '[data-tour="appearance-toggle"]',
    placement: 'top',
    title: 'Light or dark',
    body: 'TaskFlow ships with a warm off-white light theme and a warm charcoal dark theme, both built around the same teal accent. Switch anytime — your choice is remembered on this device.',
  },
  {
    tab: 'settings',
    selector: '[data-tour="danger-zone-card"]',
    placement: 'top',
    title: 'Fresh start any time',
    body: 'Clear the sample tasks and boards, or fully reset TaskFlow, whenever you want a clean slate. Look for "Replay guided tour" under Settings → Help whenever you want to see this tour again.',
  },
];
