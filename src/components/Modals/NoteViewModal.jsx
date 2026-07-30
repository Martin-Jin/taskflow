/**
 * NoteViewModal — read-only expanded view of a note, opened by clicking a
 * tile's body in NotesCard (tiles clamp to 2 lines, so this is the only way
 * to read a longer note without entering edit mode). Reuses Linkified the
 * same way the tile itself does so link-containing notes stay clickable.
 */

import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { containsLink } from '../../utils/linkify';
import Linkified from '../Common/Linkified';

export default function NoteViewModal({ note, onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-stat-list modal-note-view"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={note.title}
        tabIndex={-1}
      >
        <div className="stat-list-modal-header">
          <h3>{note.title}</h3>
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {note.body &&
          (containsLink(note.body) ? (
            <Linkified text={note.body} className="note-view-body" />
          ) : (
            <div className="note-view-body">{note.body}</div>
          ))}
      </div>
    </div>
  );
}
