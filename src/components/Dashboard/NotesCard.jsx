import React, { useState } from 'react';
import { Plus, X, Clock, FolderPlus, Search, StickyNote } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { linkify, containsLink } from '../../utils/linkify';
import { nextLabelColor } from '../../utils/labelColor';
import { rankByNameSearch } from '../../utils/nameSearch';
import { stripMarkdown } from '../../utils/stripMarkdown';
import NoteEditorModal from '../Modals/NoteEditorModal';
import EmptyState from '../Common/EmptyState';
import { DEFAULT_FOLDER_ID, faviconUrl, recentNotes } from './notesModel';

/** First URL a note's body contains, or null — used to show a favicon hint next to a link-containing note. */
function firstLinkHref(text) {
  const seg = linkify(text).find((s) => s.type === 'link');
  return seg?.href ?? null;
}

/**
 * Folder-organized sticky notes: a folder-tab/search/"recently edited" list
 * of tiles, each a freeform title + markdown body edited via NoteEditorModal
 * (a mini WYSIWYG editor — clicking a tile or "Add note" opens it directly,
 * no separate hover-only Edit button or read-only view step). State lives in
 * SchedulerContext (not a local usePersistedState) so notes sync across
 * devices and survive a backup restore, like every other setting.
 */
export default function NotesCard() {
  const { notes: data, setNotes: setData } = useScheduler();
  const [activeFolderId, setActiveFolderId] = useState('all');
  const [isAdding, setIsAdding] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteQuery, setNoteQuery] = useState('');

  const visibleNotes =
    activeFolderId === 'all' ? data.notes : data.notes.filter((n) => n.folderId === activeFolderId);

  // Fuzzy — same prefix/substring/subsequence/typo-tolerant ranker every
  // other search box in the app uses (see nameSearch.js) — searched against
  // title + a plain-text (markdown stripped) rendering of the body, so a
  // query still matches text buried under formatting.
  const filteredNotes = noteQuery.trim()
    ? rankByNameSearch(noteQuery, visibleNotes.map((n) => ({ ...n, label: `${n.title} ${stripMarkdown(n.body)}` })))
    : visibleNotes;

  const editingNote = editingNoteId ? data.notes.find((n) => n.id === editingNoteId) || null : null;

  function createNote(title, body) {
    const folderId = activeFolderId === 'all' ? DEFAULT_FOLDER_ID : activeFolderId;
    const now = Date.now();
    setData((d) => ({
      ...d,
      notes: [...d.notes, { id: crypto.randomUUID(), title, body, folderId, color: nextLabelColor(d.notes.length), createdAt: now, updatedAt: now }],
    }));
    setIsAdding(false);
  }

  function updateNote(id, fields) {
    setData((d) => ({ ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, ...fields, updatedAt: Date.now() } : n)) }));
  }

  function removeNote(id) {
    setData((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
    if (editingNoteId === id) setEditingNoteId(null);
  }

  /** Jump to a note from the "Recently edited" strip regardless of which folder is currently selected. */
  function jumpToNote(note) {
    setNoteQuery('');
    setActiveFolderId('all');
    setEditingNoteId(note.id);
  }

  function addFolder(e) {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    setData((d) => ({ ...d, folders: [...d.folders, { id, name }] }));
    setNewFolderName('');
    setIsAddingFolder(false);
    setActiveFolderId(id);
  }

  function removeFolder(id) {
    if (id === DEFAULT_FOLDER_ID) return;
    setData((d) => ({
      folders: d.folders.filter((f) => f.id !== id),
      notes: d.notes.map((n) => (n.folderId === id ? { ...n, folderId: DEFAULT_FOLDER_ID } : n)),
    }));
    if (activeFolderId === id) setActiveFolderId('all');
  }

  const recent = recentNotes(data);

  return (
    <div className="card dashboard-card notes-card">
      <div className="dashboard-card-header">
        <h3>Notes</h3>
      </div>

      {data.notes.length === 0 && (
        <div className="notes-recent notes-recent-empty">Notes you add or edit will show up here.</div>
      )}

      {recent.length > 0 && (
        <div className="notes-recent">
          <div className="notes-recent-label">
            <Clock size={12} /> Recently edited
          </div>
          <div className="notes-recent-row">
            {recent.map((note) => (
              <button key={note.id} className="note-chip" onClick={() => jumpToNote(note)}>
                {containsLink(note.body) && <FaviconImg url={firstLinkHref(note.body)} />}
                {note.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="notes-search">
        <Search size={13} className="notes-search-icon" />
        <input
          className="notes-search-input"
          placeholder="Search notes…"
          value={noteQuery}
          onChange={(e) => setNoteQuery(e.target.value)}
        />
        {noteQuery && (
          <button className="notes-search-clear" onClick={() => setNoteQuery('')} title="Clear search">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="notes-folders">
        <button
          className={`note-folder-tab ${activeFolderId === 'all' ? 'active' : ''}`}
          onClick={() => setActiveFolderId('all')}
        >
          All
        </button>
        {data.folders
          .filter((folder) => folder.id !== DEFAULT_FOLDER_ID)
          .map((folder) => (
            <div key={folder.id} className={`note-folder-tab ${activeFolderId === folder.id ? 'active' : ''}`}>
              <button className="note-folder-tab-select" onClick={() => setActiveFolderId(folder.id)}>
                {folder.name}
              </button>
              <button
                className="note-folder-remove"
                onClick={() => removeFolder(folder.id)}
                aria-label={`Remove folder "${folder.name}"`}
                title={`Remove folder "${folder.name}"`}
              >
                <X size={11} />
              </button>
            </div>
          ))}

        {isAddingFolder ? (
          <form className="note-folder-add-form" onSubmit={addFolder}>
            <input
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={() => !newFolderName && setIsAddingFolder(false)}
            />
          </form>
        ) : (
          <button className="note-folder-tab note-folder-tab-add" onClick={() => setIsAddingFolder(true)} title="New folder">
            <FolderPlus size={13} />
          </button>
        )}
      </div>

      <div className="notes-grid">
        {filteredNotes.map((note) => (
          <button
            key={note.id}
            className="note-tile note-tile-clickable"
            style={{ '--note-accent': note.color }}
            onClick={() => setEditingNoteId(note.id)}
          >
            <div className="note-tile-title">{note.title}</div>
            {note.body && (
              <div className="note-tile-body-row">
                {containsLink(note.body) && <FaviconImg url={firstLinkHref(note.body)} size={12} />}
                <span className="note-tile-body">{stripMarkdown(note.body)}</span>
              </div>
            )}
          </button>
        ))}

        <button className="note-tile note-tile-add" onClick={() => setIsAdding(true)}>
          <Plus size={14} />
          <span>Add note</span>
        </button>

        {filteredNotes.length === 0 && (
          <EmptyState icon={StickyNote} className="notes-empty">
            {noteQuery ? 'No notes match your search.' : 'Jot down anything — click "Add note" to get started.'}
          </EmptyState>
        )}
      </div>

      {isAdding && <NoteEditorModal onClose={() => setIsAdding(false)} onCreate={createNote} />}
      {editingNote && (
        <NoteEditorModal note={editingNote} onClose={() => setEditingNoteId(null)} onUpdate={updateNote} onDelete={removeNote} />
      )}
    </div>
  );
}

function FaviconImg({ url, size = 14 }) {
  const src = faviconUrl(url);
  if (!src) return null;
  return <img src={src} alt="" width={size} height={size} className="note-favicon" />;
}
