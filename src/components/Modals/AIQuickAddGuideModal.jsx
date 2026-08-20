/**
 * AIQuickAddGuideModal — static reference explaining the AI Quick Add
 * feature (bring-your-own-key Claude/Gemini task+event extraction). Opened
 * from the "?" button in AIQuickAddModal's header — purely informational,
 * no state or actions of its own, same pattern as SmartParseGuideModal.
 */

import { ExternalLink } from 'lucide-react';
import Modal from '../Common/Modal';

const SECTIONS = [
  {
    title: 'What it does',
    body: 'Type a free-form description — or attach/paste up to 5 screenshots and/or PDFs (an email, text message, flyer, or document) — and the AI proposes a plan of changes: creating tasks/events, breaking a task into subtasks, setting up dependencies ("do X after Y"), moving things between projects/sections, even renaming or deleting things. Nothing is applied straight away — you always get a review screen listing every proposed change with a checkbox, so you can uncheck anything you don\'t want before applying.',
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
    body: 'Click the sparkle button next to "Add task" (Tasks list or Board view), type or paste your description — or attach/paste screenshots or PDFs — pick Claude or Gemini, then click "Plan changes". Review every proposed change on the next screen, uncheck anything you don\'t want, then Apply.',
  },
];

export default function AIQuickAddGuideModal({ onClose }) {
  return (
    <Modal onClose={onClose} ariaLabel="AI Quick Add guide" variantClassName="modal-stat-list" title="AI Quick Add">
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
    </Modal>
  );
}
