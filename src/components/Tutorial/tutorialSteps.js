/**
 * Static content for TutorialModal — kept separate from the component so
 * copy edits don't require touching rendering logic. Each step is a plain
 * {icon, title, body} triple; icons come from lucide-react so they match
 * the rest of the app's iconography.
 */

import {
  LayoutGrid,
  Plus,
  Link2,
  Lock,
  Undo2,
  Zap,
  KeyRound,
  CalendarDays,
  ShieldCheck,
} from 'lucide-react';

export const TUTORIAL_STEPS = [
  {
    icon: LayoutGrid,
    title: 'Six views of the same tasks',
    body: 'Calendar shows scheduled work day-by-day, Tasks is a flat sortable list, Board mirrors a Todoist-style kanban, Gantt shows burn-down bars across your planning horizon, and Stats summarizes capacity. Every view edits the same underlying tasks — pick whichever fits what you are doing.',
  },
  {
    icon: KeyRound,
    title: 'Connect your Todoist tasks',
    body: 'Open Settings → Integrations and paste in a personal API token to swap the sample tasks for your real ones. Get yours from Todoist\'s website: Settings → Integrations → Developer → copy the "API token" field, then paste it into TaskFlow and hit Connect. Two-way sync then keeps edits, completions, and new tasks in step with Todoist automatically.',
  },
  {
    icon: CalendarDays,
    title: 'Connect Google Calendar',
    body: 'Click "Connect Google Calendar" in Settings and approve the Google sign-in prompt — no password ever passes through TaskFlow. Your existing events (including calendars you subscribe to, like a shared timetable) populate the calendar grid, and "Push scheduled blocks to Google Calendar" writes your planned work back as real events.',
  },
  {
    icon: ShieldCheck,
    title: 'Your data stays with you',
    body: "TaskFlow is a static site with no server of its own — your Todoist token, tasks, routines, and settings are saved only in this browser's local storage, and every request goes straight from your browser to Todoist/Google. Nothing passes through, or is stored on, any third-party backend. Clearing your browser data or using Settings → Reset local data removes it all.",
  },
  {
    icon: Plus,
    title: 'Add a task, the fast way',
    body: 'Type naturally into the Title field: "Call dentist tomorrow p2 every month" auto-detects a due date, priority (Todoist\'s p1-p4 shorthand), and recurrence as dismissible chips underneath. Accept a chip by leaving it, or dismiss it if TaskFlow guessed wrong — nothing is applied silently.',
  },
  {
    icon: Link2,
    title: 'Dependencies, made deselectable',
    body: 'The "Depends on" field is a searchable picker — click a task to add it, click the × on its chip to remove it. A dependent task will not be auto-scheduled until everything it depends on is marked complete.',
  },
  {
    icon: Lock,
    title: 'Locking protects your plan',
    body: 'Lock a task or a scheduled block to keep Re-balance schedule from ever moving it — useful once you have manually placed something exactly where you want it.',
  },
  {
    icon: Undo2,
    title: 'Undo and redo, always available',
    body: 'Every scheduling action — adding a task, re-balancing, dragging a block — can be undone from the topbar. Experiment freely.',
  },
  {
    icon: Zap,
    title: 'Re-balance schedule',
    body: 'Whenever due dates, priorities, or capacity change, hit Re-balance schedule on the Calendar tab to re-plan all unlocked work across your configured work hours and buffer days.',
  },
];
