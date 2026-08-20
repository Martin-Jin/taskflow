/**
 * NoteViewModal — read-only expanded view of a note, opened by clicking a
 * tile's body in NotesCard (tiles clamp to 2 lines, so this is the only way
 * to read a longer note without entering edit mode). Reuses Linkified the
 * same way the tile itself does so link-containing notes stay clickable.
 */

import Modal from '../Common/Modal';
import { containsLink } from '../../utils/linkify';
import Linkified from '../Common/Linkified';

export default function NoteViewModal({ note, onClose }) {
  return (
    <Modal onClose={onClose} ariaLabel={note.title} variantClassName="modal-stat-list modal-note-view" title={note.title}>
      {note.body &&
        (containsLink(note.body) ? (
          <Linkified text={note.body} className="note-view-body" />
        ) : (
          <div className="note-view-body">{note.body}</div>
        ))}
    </Modal>
  );
}
