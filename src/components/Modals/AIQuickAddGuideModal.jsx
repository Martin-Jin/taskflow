/**
 * AIQuickAddGuideModal — static reference explaining the AI Quick Add
 * feature (bring-your-own-key Claude/Gemini task+event extraction). Opened
 * from the "?" button in AIQuickAddModal's header — purely informational,
 * no state or actions of its own, same pattern as SmartParseGuideModal.
 */

import { X, ExternalLink } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';

const SECTIONS = [
  {
    title: 'What it does',
    body: 'Type a free-form description — or attach/paste a screenshot of an email, text message, or flyer — and AI reads it and creates a Task or Event for you, instead of filling in the form field by field. "Lunch with Sam at 1pm Friday" becomes a calendar Event; "renew car rego" becomes a Task. It fills in the due date, time, priority, duration, and project it can figure out along the way.',
  },
  {
    title: 'Bring your own key',
    body: 'This feature uses your own Anthropic and/or Gemini API key — added once in Settings → Integrations → AI Quick Add. Your key is saved only in this browser and sent straight through to whichever provider you pick, never to the app developer.',
  },
  {
    title: 'Getting a free API key',
    body: 'Google AI Studio (aistudio.google.com/app/apikey) offers a genuinely free tier for Gemini — no billing required to get started. Anthropic (console.anthropic.com/settings/keys) typically requires adding a small amount of prepaid credit before its API will respond, so it isn\'t free the same way — pick whichever provider matches what you already have, or use Gemini if you just want to try this out without paying anything.',
  },
  {
    title: 'How to use it',
    body: 'Click the sparkle button next to "Add task" (Tasks list or Board view), type or paste your description — or attach/paste a screenshot — pick Claude or Gemini, then click Create. Review the result and edit it like any other task or event afterwards.',
  },
];

export default function AIQuickAddGuideModal({ onClose }) {
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
        aria-label="AI Quick Add guide"
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>AI Quick Add</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <ul className="missed-tasks-list stat-list-modal-list">
          {SECTIONS.map((section) => (
            <li key={section.title} className="missed-tasks-item scheduled-today-item" style={{ background: 'var(--color-bg-page)', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <span className="missed-tasks-title" style={{ fontWeight: 600 }}>{section.title}</span>
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{section.body}</span>
            </li>
          ))}
        </ul>
        <p className="form-hint" style={{ marginTop: 10, marginBottom: 0 }}>
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
          >
            console.anthropic.com <ExternalLink size={11} />
          </a>
          {' · '}
          <a
            href="https://aistudio.google.com/app/apikey"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
          >
            aistudio.google.com <ExternalLink size={11} />
          </a>
        </p>
      </div>
    </div>
  );
}
