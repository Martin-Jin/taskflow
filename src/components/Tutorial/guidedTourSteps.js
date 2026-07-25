/**
 * Static content for GuidedTour — each step names the tab it lives on (so
 * the tour can switch tabs as it advances) and a `[data-tour="..."]`
 * selector for the real on-screen element to spotlight. Kept separate from
 * the component so copy edits don't require touching positioning logic.
 */

export const GUIDED_TOUR_STEPS = [
  {
    tab: null,
    selector: '[data-tour="brand"]',
    placement: 'right',
    title: 'Welcome to TaskFlow',
    body: 'TaskFlow turns your task list into an auto-scheduled calendar. This short tour points out where everything lives — replay it anytime from Settings.',
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
    selector: '[data-tour="block-time"]',
    placement: 'bottom',
    title: 'Block time',
    body: 'Reserve time for anything that is not a task — meetings, appointments, focus blocks — so Re-balance schedule plans around it.',
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
    tab: 'tasks',
    selector: '[data-tour="tasks-view-switch"]',
    placement: 'bottom',
    title: 'Switch views',
    body: 'List, Board, or Gantt — same tasks, three ways to see them. Board groups them into boards and sections; Gantt shows burn-down bars across your planning horizon.',
  },
  {
    tab: 'tasks',
    view: 'board',
    selector: '[data-tour="add-board"]',
    placement: 'bottom',
    title: 'Boards',
    body: 'Create as many boards as you like to separate work, personal life, or any other project. New accounts start with a few generic sample boards you can rename, delete, or clear from Settings.',
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
    selector: '[data-tour="nav-settings"]',
    placement: 'right',
    title: 'Settings',
    body: 'Connect Todoist and Google Calendar, tune scheduling rules, and manage your data here.',
  },
  {
    tab: 'settings',
    selector: '[data-tour="account-card"]',
    placement: 'top',
    title: 'Sync across devices',
    body: 'Sign in with Google (also available from the account button in the sidebar/topbar) to sync your tasks, boards, and settings between your phone and computer. Fully optional — staying signed out keeps TaskFlow exactly as local-only as it is today.',
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
    body: 'Clear the sample tasks and boards, or fully reset TaskFlow, whenever you want a clean slate — and replay this tour again from here.',
  },
];
