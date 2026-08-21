/**
 * NoteEditorModal — replaces NoteViewModal (a read-only popup) with a real
 * mini markdown editor: clicking "Add note" or an existing note tile opens
 * this directly in an editable state — there's no separate hover "Edit"
 * button or read-only view step anymore (see NotesCard).
 *
 * Built on Tiptap (WYSIWYG — typing "**bold**" actually renders bold, same
 * idea as Obsidian's Live Preview) with tiptap-markdown so the note's
 * `body` field stays a plain markdown string in storage/sync, unaffected by
 * the richer editing experience on top of it.
 *
 * Create vs. edit follow the same split EventDetailModal already
 * established for events: creating a note needs an explicit "Add" (an
 * abandoned create shouldn't leave a junk note behind), while editing an
 * EXISTING note autosaves — debounced while typing, and flushed immediately
 * on close (X/Escape/backdrop) so the last few keystrokes before closing
 * are never lost. The "⋯" menu (existing-note only) currently just holds
 * Delete, which — matching this feature's pre-existing behavior — deletes
 * immediately with no confirmation prompt.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Link as LinkIcon,
  Code as CodeIcon,
  Braces,
  MoreHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import Modal from '../Common/Modal';
import FieldRejectionHint from '../Common/FieldRejectionHint';
import { useFieldRejection } from '../../hooks/useFieldRejection';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useIsMobile } from '../../hooks/useIsMobile';

const AUTOSAVE_DELAY_MS = 500;

function ToolbarButton({ onClick, isActive, label, icon: Icon }) {
  return (
    <button
      type="button"
      className={`note-editor-toolbar-btn ${isActive ? 'is-active' : ''}`}
      // Commands read the editor's current selection — a plain click already
      // fires after mousedown-triggered focus/selection changes, but this
      // stops the toolbar button itself from ever stealing focus first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <Icon size={14} />
    </button>
  );
}

function NoteEditorToolbar({ editor }) {
  if (!editor) return null;
  return (
    <div className="note-editor-toolbar">
      <ToolbarButton label="Bold" icon={BoldIcon} isActive={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
      <ToolbarButton
        label="Italic"
        icon={ItalicIcon}
        isActive={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="Strikethrough"
        icon={Strikethrough}
        isActive={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="note-editor-toolbar-divider" aria-hidden="true" />
      <ToolbarButton
        label="Heading 1"
        icon={Heading1}
        isActive={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      />
      <ToolbarButton
        label="Heading 2"
        icon={Heading2}
        isActive={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        label="Heading 3"
        icon={Heading3}
        isActive={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <span className="note-editor-toolbar-divider" aria-hidden="true" />
      <ToolbarButton
        label="Bullet list"
        icon={List}
        isActive={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Numbered list"
        icon={ListOrdered}
        isActive={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        label="Checklist"
        icon={ListTodo}
        isActive={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <span className="note-editor-toolbar-divider" aria-hidden="true" />
      <ToolbarButton
        label="Link"
        icon={LinkIcon}
        isActive={editor.isActive('link')}
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const url = window.prompt('Link URL');
          if (!url) return;
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }}
      />
      <ToolbarButton label="Inline code" icon={CodeIcon} isActive={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
      <ToolbarButton
        label="Code block"
        icon={Braces}
        isActive={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
    </div>
  );
}

export default function NoteEditorModal({ note, onClose, onCreate, onUpdate, onDelete }) {
  const isCreate = !note;
  const isMobile = useIsMobile();
  const [title, setTitle] = useState(note?.title || '');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef(null);
  const requestCloseRef = useRef(() => {});
  const saveTimeoutRef = useRef(null);
  // Read inside the (possibly-delayed) debounce/flush callbacks instead of
  // closing over `title` directly, so a save that fires after several more
  // keystrokes still writes the latest value, not whatever `title` was when
  // that particular timeout was scheduled.
  const titleRef = useRef(title);
  titleRef.current = title;

  const titleRejection = useFieldRejection();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Write anything…' }),
      Markdown.configure({ html: false }),
    ],
    content: note?.body || '',
    onUpdate: () => {
      if (!isCreate) scheduleSave();
    },
  });

  function currentMarkdown() {
    return editor ? editor.storage.markdown.getMarkdown() : '';
  }

  function scheduleSave() {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      onUpdate(note.id, { title: titleRef.current.trim() || note.title, body: currentMarkdown() });
    }, AUTOSAVE_DELAY_MS);
  }

  function flushSave() {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    onUpdate(note.id, { title: titleRef.current.trim() || note.title, body: currentMarkdown() });
  }

  // Catches the unmount case (e.g. the whole Dashboard tab is navigated away
  // from while a debounce is still pending) — handleModalClose covers every
  // *normal* close path (X/Escape/backdrop), but an unmount skips that.
  useEffect(
    () => () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    },
    []
  );

  function handleTitleChange(value) {
    setTitle(value);
    titleRejection.clear();
    if (!isCreate) scheduleSave();
  }

  function handleTitleKeyDown(e) {
    if (isCreate && e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    }
  }

  // Passed to <Modal onClose={...}> — the one funnel every dismissal
  // (X/Escape/backdrop) goes through, same technique as EventDetailModal's
  // own handleModalClose. Only edit mode has anything to flush; an
  // abandoned create intentionally saves nothing.
  function handleModalClose() {
    if (!isCreate) flushSave();
    onClose();
  }

  function handleCreate() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      titleRejection.reject('Give the note a title before saving.');
      return;
    }
    onCreate(trimmedTitle, currentMarkdown());
    requestCloseRef.current();
  }

  function handleDelete() {
    setMenuOpen(false);
    onDelete(note.id);
    requestCloseRef.current();
  }

  const {
    menuRef,
    mode: menuMode,
    style: menuStyle,
  } = useMenuPosition({
    isOpen: menuOpen,
    anchorRef: menuTriggerRef,
    onClose: () => setMenuOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => ({
      left: anchorRect.right - menuRect.width,
      top: anchorRect.bottom + 4,
    }),
  });

  return (
    <Modal onClose={handleModalClose} ariaLabel={isCreate ? 'Add note' : 'Edit note'} size="lg" variantClassName="modal-note-editor">
      {({ requestClose }) => {
        requestCloseRef.current = requestClose;
        return (
          <>
            <FieldRejectionHint message={titleRejection.message} className="note-editor-hint" />

            <div className="detail-header note-editor-header">
              <input
                autoFocus={isCreate}
                className={`note-editor-title-input ${titleRejection.shakeProps.className}`.trim()}
                onAnimationEnd={titleRejection.shakeProps.onAnimationEnd}
                placeholder="Title"
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
                onKeyDown={handleTitleKeyDown}
              />
              <div className="note-editor-header-actions">
                {!isCreate && (
                  <button
                    type="button"
                    ref={menuTriggerRef}
                    className="btn btn-icon menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label="Note actions"
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                )}
                <button type="button" className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
                  <X size={16} />
                </button>
              </div>

              {menuOpen &&
                createPortal(
                  <>
                    {menuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setMenuOpen(false)} />}
                    <div
                      ref={menuRef}
                      className={`project-actions-dropdown ${menuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      role="menu"
                      style={menuMode === 'anchored' ? menuStyle : undefined}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="project-actions-item project-actions-item-danger"
                        onClick={handleDelete}
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </div>
                  </>,
                  document.body
                )}
            </div>

            <NoteEditorToolbar editor={editor} />
            <EditorContent editor={editor} className="note-editor-content" />

            {isCreate && (
              <div className="note-editor-footer">
                <button type="button" className="btn" onClick={requestClose}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={handleCreate}>
                  Add
                </button>
              </div>
            )}
          </>
        );
      }}
    </Modal>
  );
}
