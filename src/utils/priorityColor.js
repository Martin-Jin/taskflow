/** Display label for each priority value, shared across the Add/Edit task modals. */
export const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

/** Maps a task's priority to its CSS custom-property color, shared across Board/Gantt/Calendar. */
export function priorityColor(priority) {
  switch (priority) {
    case 'urgent':
      return 'var(--priority-urgent)';
    case 'high':
      return 'var(--priority-high)';
    case 'medium':
      return 'var(--priority-medium)';
    default:
      return 'var(--priority-low)';
  }
}
