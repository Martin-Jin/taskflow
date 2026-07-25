/** Display label for each priority value, shared across the Add/Edit task modals. */
export const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

/** Maps a task's priority to its CSS custom-property color, shared across Board/Gantt/Calendar. */
export function priorityColor(priority) {
  switch (priority) {
    case 'urgent':
      return 'var(--color-priority-urgent)';
    case 'high':
      return 'var(--color-priority-high)';
    case 'medium':
      return 'var(--color-priority-medium)';
    default:
      return 'var(--color-priority-low)';
  }
}
