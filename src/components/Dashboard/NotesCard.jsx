import React, { useEffect, useRef, useState } from 'react';
import { Plus, X, Clock, FolderPlus, Pencil, Search, Upload, StickyNote } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { linkify, containsLink } from '../../utils/linkify';
import { nextLabelColor } from '../../utils/labelColor';
import Linkified from '../Common/Linkified';
import NoteViewModal from '../Modals/NoteViewModal';
import {
  DEFAULT_FOLDER_ID,
  faviconUrl,
  dedupeKey,
  parseBookmarksHtml,
  recentNotes,
} from './notesModel';

/** First URL a note's body contains, or null — used to show a favicon hint next to an auto-linkified body. */
function firstLinkHref(text) {
  const seg = linkify(text).find((s) => s.type === 'link');
  return seg?.href ?? null;
}

/**
 * Folder-organized sticky notes: same folder-tab/search/"recently edited"
 * layout as the pinned-links feature this replaced, but each tile is a
 * freeform title + text body instead of a label + URL. A note that's just a
 * pasted link still renders (and stays clickable) via the same auto-linkify
 * path used for task descriptions — see Common/Linkified.jsx. State lives in
 * SchedulerContext (not a local usePersistedState) so notes sync across
 * devices and survive a backup restore, like every other setting.
 */
export default function NotesCard() {
  const { notes: data, setNotes: setData } = useScheduler();
  const [activeFolderId, setActiveFolderId] = useState('all');
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [noteQuery, setNoteQuery] = useState('');
  const [viewingNote, setViewingNote] = useState(null);
  const [importMessage, setImportMessage] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!importMessage) return;
    const timer = setTimeout(() => setImportMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [importMessage]);

  const visibleNotes =
    activeFolderId === 'all' ? data.notes : data.notes.filter((n) => n.folderId === activeFolderId);

  const filteredNotes = noteQuery.trim()
    ? visibleNotes.filter((n) => {
        const q = noteQuery.trim().toLowerCase();
        return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
      })
    : visibleNotes;

  function addNote(e) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const folderId = activeFolderId === 'all' ? DEFAULT_FOLDER_ID : activeFolderId;
    const now = Date.now();
    setData((d) => ({
      ...d,
      notes: [
        ...d.notes,
        { id: crypto.randomUUID(), title, body: newBody.trim(), folderId, color: nextLabelColor(d.notes.length), createdAt: now, updatedAt: now },
      ],
    }));
    setNewTitle('');
    setNewBody('');
    setIsAdding(false);
  }

  function removeNote(id) {
    setData((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
    if (editingNoteId === id) setEditingNoteId(null);
  }

  function startEdit(note) {
    setEditingNoteId(note.id);
    setEditTitle(note.title);
    setEditBody(note.body);
  }

  function commitEdit(e) {
    e.preventDefault();
    const title = editTitle.trim();
    if (!title) {
      setEditingNoteId(null);
      return;
    }
    setData((d) => ({
      ...d,
      notes: d.notes.map((n) => (n.id === editingNoteId ? { ...n, title, body: editBody.trim(), updatedAt: Date.now() } : n)),
    }));
    setEditingNoteId(null);
  }

  /** Jump to a note from the "Recently edited" strip regardless of which folder is currently selected. */
  function jumpToNote(note) {
    setNoteQuery('');
    setActiveFolderId('all');
    startEdit(note);
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file later
    if (!file) return;
    const text = await file.text();
    const parsed = parseBookmarksHtml(text);
    if (parsed.length === 0) {
      setImportMessage('No bookmarks found in that file.');
      return;
    }

    let added = 0;
    setData((d) => {
      const folders = [...d.folders];
      const notes = [...d.notes];
      const existingKeys = new Set(
        notes.filter((n) => containsLink(n.body)).map((n) => `${n.folderId}::${dedupeKey(n.body)}`)
      );

      function folderIdFor(name) {
        if (!name) return DEFAULT_FOLDER_ID;
        const match = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
        if (match) return match.id;
        const id = crypto.randomUUID();
        folders.push({ id, name });
        return id;
      }

      parsed.forEach(({ label, url, folderName }) => {
        const folderId = folderIdFor(folderName);
        const key = `${folderId}::${dedupeKey(url)}`;
        if (existingKeys.has(key)) return;
        existingKeys.add(key);
        const now = Date.now();
        notes.push({ id: crypto.randomUUID(), title: label, body: url, folderId, color: nextLabelColor(notes.length), createdAt: now, updatedAt: now });
        added++;
      });

      return { folders, notes };
    });

    setImportMessage(added > 0 ? `Imported ${added} bookmark${added === 1 ? '' : 's'} as notes.` : 'Nothing new to import — all bookmarks already exist.');
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

      <div className="notes-actions">
        <button className="notes-import-btn" onClick={() => fileInputRef.current?.click()} title="Import bookmarks from a browser export as notes">
          <Upload size={12} /> Import bookmarks
        </button>
        <input ref={fileInputRef} type="file" accept=".html,.htm" onChange={handleImportFile} className="notes-import-input" />
      </div>

      {importMessage && <div className="notes-import-message">{importMessage}</div>}

      <div className="notes-grid">
        {filteredNotes.map((note) => (
          <div key={note.id} className="note-tile" style={{ '--note-accent': note.color }}>
            {editingNoteId === note.id ? (
              <form className="note-edit-form" onSubmit={commitEdit}>
                <input
                  autoFocus
                  className="note-edit-title"
                  placeholder="Title"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setEditingNoteId(null)}
                />
                <textarea
                  className="note-edit-body"
                  placeholder="Write anything — paste a link to make it clickable."
                  rows={3}
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setEditingNoteId(null)}
                />
                <div className="note-edit-actions">
                  <button type="button" className="btn" onClick={() => setEditingNoteId(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <>
                <button className="note-tile-remove" onClick={() => removeNote(note.id)} title="Remove">
                  <X size={13} />
                </button>
                <button
                  className="note-tile-edit"
                  onClick={() => startEdit(note)}
                  title="Edit"
                  aria-label={`Edit "${note.title}"`}
                >
                  <Pencil size={12} />
                </button>
                <div
                  className="note-tile-content note-tile-content-clickable"
                  onClick={(e) => {
                    if (e.target.closest('a')) return; // let link clicks open the link, not the modal
                    setViewingNote(note);
                  }}
                >
                  <div className="note-tile-title">{note.title}</div>
                  {note.body &&
                    (containsLink(note.body) ? (
                      <div className="note-tile-body-row">
                        <FaviconImg url={firstLinkHref(note.body)} size={12} />
                        <Linkified text={note.body} className="note-tile-body" />
                      </div>
                    ) : (
                      <div className="note-tile-body">{note.body}</div>
                    ))}
                </div>
              </>
            )}
          </div>
        ))}

        {isAdding ? (
          <form className="note-add-form" onSubmit={addNote}>
            <input autoFocus placeholder="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <textarea
              placeholder="Write anything — paste a link to make it clickable."
              rows={3}
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
            />
            <div className="note-add-actions">
              <button type="button" className="btn" onClick={() => setIsAdding(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Add
              </button>
            </div>
          </form>
        ) : (
          <button className="note-tile note-tile-add" onClick={() => setIsAdding(true)}>
            <Plus size={18} />
            <span>Add note</span>
          </button>
        )}

        {filteredNotes.length === 0 && !isAdding && (
          <div className="notes-empty">
            <StickyNote size={20} className="empty-state-icon" aria-hidden="true" />
            {noteQuery ? 'No notes match your search.' : 'Jot down anything — paste a link to keep it clickable.'}
          </div>
        )}
      </div>

      {viewingNote && <NoteViewModal note={viewingNote} onClose={() => setViewingNote(null)} />}
    </div>
  );
}

function FaviconImg({ url, size = 14 }) {
  const src = faviconUrl(url);
  if (!src) return null;
  return <img src={src} alt="" width={size} height={size} className="note-favicon" />;
}
