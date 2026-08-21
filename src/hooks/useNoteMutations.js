/**
 * useNoteMutations — the create/update/delete half of the notes model, split
 * out of NotesCard so a second entry point can drive NoteEditorModal without
 * the Dashboard being on screen at all (the command palette's "Add note",
 * see App.jsx). Notes themselves live in SchedulerContext, so both callers
 * write to the same synced/backed-up state.
 */

import { useCallback } from 'react';
import { useScheduler } from '../context/SchedulerContext';
import { nextLabelColor } from '../utils/labelColor';
import { DEFAULT_FOLDER_ID } from '../components/Dashboard/notesModel';

export function useNoteMutations() {
  const { notes: data, setNotes: setData } = useScheduler();

  const createNote = useCallback(
    (title, body, folderId = DEFAULT_FOLDER_ID) => {
      const now = Date.now();
      setData((d) => ({
        ...d,
        notes: [
          ...d.notes,
          {
            id: crypto.randomUUID(),
            title,
            body,
            folderId,
            color: nextLabelColor(d.notes.length),
            createdAt: now,
            updatedAt: now,
          },
        ],
      }));
    },
    [setData]
  );

  const updateNote = useCallback(
    (id, fields) => {
      setData((d) => ({ ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, ...fields, updatedAt: Date.now() } : n)) }));
    },
    [setData]
  );

  const removeNote = useCallback(
    (id) => {
      setData((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
    },
    [setData]
  );

  return { data, setData, createNote, updateNote, removeNote };
}
