/**
 * ============================================================================
 * MOCK DATA
 * ============================================================================
 * Provides realistic sample data so the full app is explorable with zero
 * configuration. Used automatically by todoistService/googleCalendarService
 * whenever real API credentials aren't configured.
 * ============================================================================
 */

import { addDays, toISODate } from '../utils/dateUtils';

const today = () => toISODate(new Date());

/**
 * Mock Projects — Todoist's top-level containers. Used to populate the
 * Board view's project filter dropdown when no Todoist token is configured.
 * `isDefault: true` marks these as sample data (as opposed to anything the
 * user created themselves) for anyone inspecting state/localStorage — the
 * Todoist load effect in SchedulerContext.jsx already drops all of it
 * unconditionally (a wholesale replace, not a filter) the moment a real
 * sync succeeds, and SettingsPanel's "Clear all data" button clears
 * everything rather than filtering by this flag.
 */
export function getMockProjects() {
  return [
    { id: 'work', name: 'Work', color: 'blue', order: 1, isDefault: true },
    { id: 'writing', name: 'Writing', color: 'green', order: 2, isDefault: true },
    { id: 'personal', name: 'Personal', color: 'grape', order: 3, isDefault: true },
  ];
}

/**
 * Mock Sections (Todoist board-view columns). Tasks reference these by
 * `sectionId`; tasks with `sectionId: null` fall into the "No Section"
 * bucket in Board view, matching Todoist's own behavior.
 */
export function getMockSections() {
  return [
    { id: 'sec_planning', name: 'Planning', projectId: 'work', order: 1, isDefault: true },
    { id: 'sec_in_progress', name: 'In Progress', projectId: 'work', order: 2, isDefault: true },
    { id: 'sec_review', name: 'Review', projectId: 'work', order: 3, isDefault: true },
  ];
}

export function getMockTasks() {
  const base = today();
  return [
    {
      id: 'task_1',
      title: 'Finish Q3 investor deck',
      notes: 'Focus on the growth metrics slide + competitive landscape.',
      estimatedHours: 6,
      remainingHours: 6,
      priority: 'urgent',
      dueDate: addDays(base, 2),
      isRecurring: false,
      recurrenceString: null,
      projectId: 'work',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 1,
      maxChunkHours: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [
        { id: 'sub_1_1', title: 'Pull latest growth metrics from BI dashboard', isCompleted: true },
        { id: 'sub_1_2', title: 'Draft competitive landscape slide', isCompleted: false },
        { id: 'sub_1_3', title: 'Review with finance', isCompleted: false },
      ],
    },
    {
      id: 'task_2',
      title: 'Write blog post: scheduling algorithms',
      notes: '',
      estimatedHours: 4,
      remainingHours: 4,
      priority: 'medium',
      dueDate: addDays(base, 10),
      isRecurring: false,
      recurrenceString: null,
      projectId: 'writing',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.5,
      maxChunkHours: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_3',
      title: 'Refactor auth module',
      notes: 'Migrate to new session token format.',
      estimatedHours: 8,
      remainingHours: 8,
      priority: 'high',
      dueDate: addDays(base, 5),
      isRecurring: false,
      recurrenceString: null,
      projectId: 'work',
      sectionId: 'sec_in_progress',
      sectionName: 'In Progress',
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 1,
      maxChunkHours: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [
        { id: 'sub_3_1', title: 'Migrate token model', isCompleted: false },
        { id: 'sub_3_2', title: 'Update integration tests', isCompleted: false },
      ],
    },
    {
      id: 'task_4',
      title: 'Read "Deep Work" — chapters 3-5',
      notes: '',
      estimatedHours: 3,
      remainingHours: 3,
      priority: 'low',
      dueDate: addDays(base, 21),
      isRecurring: false,
      recurrenceString: null,
      projectId: 'personal',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.5,
      maxChunkHours: 1.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_5',
      title: 'Plan Q4 roadmap',
      notes: 'Coordinate with product + design leads first.',
      estimatedHours: 5,
      remainingHours: 5,
      priority: 'high',
      dueDate: addDays(base, 14),
      isRecurring: false,
      recurrenceString: null,
      projectId: 'work',
      sectionId: 'sec_planning',
      sectionName: 'Planning',
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 1,
      maxChunkHours: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [{ id: 'sub_5_1', title: 'Coordinate with product + design leads', isCompleted: false }],
    },
    {
      id: 'task_6',
      title: 'Grocery run + meal prep',
      notes: '',
      estimatedHours: 2,
      remainingHours: 2,
      priority: 'medium',
      dueDate: addDays(base, 3),
      isRecurring: true,
      recurrenceString: 'every week',
      projectId: 'personal',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 1,
      maxChunkHours: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_7',
      title: 'Review pull requests from the team',
      notes: 'Focus on the two PRs waiting longest.',
      estimatedHours: 1.5,
      remainingHours: 1.5,
      priority: 'medium',
      dueDate: base,
      isRecurring: false,
      recurrenceString: null,
      projectId: 'work',
      sectionId: 'sec_review',
      sectionName: 'Review',
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.5,
      maxChunkHours: 1.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_8',
      title: 'Update onboarding documentation',
      notes: 'Write up recent process changes for future reference.',
      estimatedHours: 0.5,
      remainingHours: 0.5,
      priority: 'low',
      dueDate: null,
      isRecurring: false,
      recurrenceString: null,
      projectId: 'work',
      sectionId: 'sec_review',
      sectionName: 'Review',
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.5,
      maxChunkHours: 0.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_9',
      title: 'Someday: learn to solder',
      notes: 'No due date — should still show up in Boards/Tasks, just never gets auto-scheduled onto the calendar.',
      estimatedHours: 2,
      remainingHours: 2,
      priority: 'low',
      dueDate: null,
      isRecurring: false,
      recurrenceString: null,
      projectId: 'personal',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.5,
      maxChunkHours: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
    {
      id: 'task_10',
      title: 'Daily standup notes',
      notes: 'Recurring — completing it advances the due date instead of marking it done.',
      estimatedHours: 0.25,
      remainingHours: 0.25,
      priority: 'low',
      dueDate: base,
      isRecurring: true,
      recurrenceString: 'every day',
      projectId: 'work',
      sectionId: null,
      sectionName: null,
      source: 'todoist',
      isLocked: false,
      isCompleted: false,
      minChunkHours: 0.25,
      maxChunkHours: 0.25,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
      subtasks: [],
    },
  ];
}

export function getMockEvents(startIso, endIso) {
  const base = today();
  return [
    {
      id: 'evt_standup',
      title: 'Daily Standup',
      date: base,
      startTime: '09:00',
      endTime: '09:15',
      isFreeTime: false,
      isRecurring: true,
      googleEventId: null,
      source: 'google',
    },
    {
      id: 'evt_lecture',
      title: 'Optional: Design Systems Lecture',
      date: addDays(base, 1),
      startTime: '14:00',
      endTime: '15:30',
      isFreeTime: true, // marked as "ignore" override — schedulable over
      isRecurring: true,
      googleEventId: null,
      source: 'google',
    },
    {
      id: 'evt_1on1',
      title: '1:1 with Manager',
      date: addDays(base, 2),
      startTime: '11:00',
      endTime: '11:30',
      isFreeTime: false,
      isRecurring: true,
      googleEventId: null,
      source: 'google',
    },
    {
      id: 'evt_dentist',
      title: 'Dentist Appointment',
      date: addDays(base, 4),
      startTime: '15:00',
      endTime: '16:00',
      isFreeTime: false,
      isRecurring: false,
      googleEventId: null,
      source: 'google',
    },
  ];
}

export function getDefaultRoutines() {
  const weekdays = [1, 2, 3, 4, 5];
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  return [
    { id: 'rt_sleep', label: 'Sleep', startTime: '23:00', endTime: '23:59', daysOfWeek: allDays, isActive: true },
    { id: 'rt_sleep_am', label: 'Sleep (overnight)', startTime: '00:00', endTime: '07:00', daysOfWeek: allDays, isActive: true },
    { id: 'rt_hygiene_am', label: 'Morning routine', startTime: '07:00', endTime: '08:00', daysOfWeek: allDays, isActive: true },
    { id: 'rt_commute_am', label: 'Commute (AM)', startTime: '08:00', endTime: '08:30', daysOfWeek: weekdays, isActive: true },
    { id: 'rt_lunch', label: 'Lunch', startTime: '12:30', endTime: '13:15', daysOfWeek: allDays, isActive: true },
    { id: 'rt_commute_pm', label: 'Commute (PM)', startTime: '17:30', endTime: '18:00', daysOfWeek: weekdays, isActive: true },
    { id: 'rt_dinner', label: 'Dinner', startTime: '18:30', endTime: '19:30', daysOfWeek: allDays, isActive: true },
  ];
}

export function getDefaultRules() {
  return {
    bufferDays: 1,
    workDayStart: '07:00',
    workDayEnd: '23:00',
    maxDailyDeepWorkHours: 8,
    horizonWeeks: 4,
    frontLoadUrgent: true,
    minGapBetweenBlocksMins: 10,
  };
}
