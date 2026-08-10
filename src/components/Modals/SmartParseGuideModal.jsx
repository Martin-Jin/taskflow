/**
 * SmartParseGuideModal — static reference explaining every phrase Smart
 * Parse recognizes when typed into a task's Title field (see
 * utils/smartParse.js, which this list is kept in sync with by hand since
 * the parser itself has no user-facing metadata to render from). Opened
 * from the "..." menu in both AddTaskModal and TaskDetailModal — purely
 * informational, no state or actions of its own.
 */

import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

const SECTIONS = [
  {
    title: 'Due date',
    examples: ['tomorrow', 'next friday', 'in 3 days', '24/03/2025', '24 March', 'end of month', 'a fortnight'],
    description: 'Relative or absolute dates set the task\'s due date.',
  },
  {
    title: 'Fixed time',
    examples: ['at 5pm', 'at 9am', 'at 12:30', 'at 17:00', '5pm', '9:10pm'],
    description:
      'Pins the task to start at exactly that time of day, independent of any due date — same as the "Fixed time" field. The "at" is optional, but a bare hour with no am/pm and no minutes (e.g. just "9") is never read as a time.',
  },
  {
    title: 'Recurrence',
    examples: ['every day', 'daily', 'every 2 weeks', 'every sat and sun', 'every other monday', 'every second sunday'],
    description: 'Makes the task repeat on that schedule.',
  },
  {
    title: 'Priority',
    examples: ['p1', 'p2', 'p3', 'p4'],
    description: 'Todoist-style shorthand — p1 is urgent, p4 is low.',
  },
  {
    title: 'Duration',
    examples: ['1h30m', '~2 hours', '45 min', 'half an hour', '1/2 hour'],
    description: 'Sets the estimated time the task will take.',
  },
  {
    title: 'Unattended',
    examples: ['unattended'],
    description: 'Marks the task as something that can run without you actively working on it.',
  },
  {
    title: 'On the day',
    examples: ['on the day', 'hard deadline', 'strictly due', 'no earlier'],
    description: 'Forces scheduling right on the due date instead of earlier.',
  },
  {
    title: 'Exclude from auto-schedule',
    examples: ['!noauto', '!manual'],
    description: 'Keeps the task off Re-balance schedule entirely — you can still drag it onto the calendar yourself.',
  },
  {
    title: 'Dependency',
    examples: ['after Book appointment', 'depends on Design review'],
    description: 'Links this task to run after another task, matched by title.',
  },
  {
    title: 'Project',
    examples: ['#Health', '#Tasks/Errands'],
    description: 'Assigns the task to a project, optionally a section within it.',
  },
  {
    title: 'Label',
    examples: ['@errand', '@calls'],
    description: 'Tags the task — any number of "@tag" mentions are picked up, creating new tags as needed.',
  },
  {
    title: 'Link',
    examples: ['https://example.com', 'example.com'],
    description: 'A plain URL is pulled out and saved as the task\'s link.',
  },
];

export default function SmartParseGuideModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Smart parse guide"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>Smart parse</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="form-hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Type any of these straight into a task's title — they're detected as you type and stripped
          out of the title once accepted.
        </p>
        <ul className="missed-tasks-list stat-list-modal-list">
          {SECTIONS.map((section) => (
            <li key={section.title} className="missed-tasks-item scheduled-today-item" style={{ background: 'var(--color-bg-page)', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <span className="missed-tasks-title" style={{ fontWeight: 600 }}>{section.title}</span>
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{section.description}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                {section.examples.map((ex) => (
                  <code
                    key={ex}
                    style={{
                      background: 'var(--color-bg-surface-raised)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '2px 6px',
                      fontSize: 12,
                    }}
                  >
                    {ex}
                  </code>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
