import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, X, Clock, FolderPlus, Rewind, ExternalLink, Pencil, Search, Upload } from 'lucide-react';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  DEFAULT_FOLDER_ID,
  DEFAULT_PINNED_LINKS,
  faviconUrl,
  normalizeUrl,
  dedupeKey,
  parseBookmarksHtml,
  recentLinks,
  jumpBackInLinks,
} from './pinnedLinksModel';

/**
 * Bookmark-bar-style pinned links: folders as chips to organize by, plus a
 * "Recently added" strip for quick access regardless of which folder is
 * selected — mirrors how browser bookmark managers separate "everything"
 * from "what did I just add".
 */
export default function PinnedLinks() {
  const [data, setData] = usePersistedState('pinnedLinks', DEFAULT_PINNED_LINKS);
  const [activeFolderId, setActiveFolderId] = useState('all');
  const [isAdding, setIsAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingLinkId, setRenamingLinkId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!importMessage) return;
    const timer = setTimeout(() => setImportMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [importMessage]);

  const visibleLinks =
    activeFolderId === 'all' ? data.links : data.links.filter((l) => l.folderId === activeFolderId);

  const filteredLinks = linkQuery.trim()
    ? visibleLinks.filter((l) => {
        const q = linkQuery.trim().toLowerCase();
        return l.label.toLowerCase().includes(q) || l.url.toLowerCase().includes(q);
      })
    : visibleLinks;

  function addLink(e) {
    e.preventDefault();
    const url = normalizeUrl(newUrl);
    if (!url || !newLabel.trim()) return;
    const folderId = activeFolderId === 'all' ? DEFAULT_FOLDER_ID : activeFolderId;
    setData((d) => ({
      ...d,
      links: [...d.links, { id: crypto.randomUUID(), label: newLabel.trim(), url, folderId, createdAt: Date.now() }],
    }));
    setNewLabel('');
    setNewUrl('');
    setIsAdding(false);
  }

  function removeLink(id) {
    setData((d) => ({ ...d, links: d.links.filter((l) => l.id !== id) }));
  }

  function renameLink(id, newLabel) {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    setData((d) => ({ ...d, links: d.links.map((l) => (l.id === id ? { ...l, label: trimmed } : l)) }));
  }

  function startRename(link) {
    setRenamingLinkId(link.id);
    setRenameValue(link.label);
  }

  function commitRename(id) {
    if (renameValue.trim()) renameLink(id, renameValue);
    setRenamingLinkId(null);
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
      const links = [...d.links];
      const existingKeys = new Set(links.map((l) => `${l.folderId}::${dedupeKey(l.url)}`));

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
        links.push({ id: crypto.randomUUID(), label, url, folderId, createdAt: Date.now() });
        added++;
      });

      return { folders, links };
    });

    setImportMessage(added > 0 ? `Imported ${added} link${added === 1 ? '' : 's'}.` : 'Nothing new to import — all links already exist.');
  }

  function recordOpen(id) {
    setData((d) => ({ ...d, links: d.links.map((l) => (l.id === id ? { ...l, lastOpenedAt: Date.now() } : l)) }));
  }

  function openAllVisible() {
    const now = Date.now();
    const ids = new Set(visibleLinks.map((l) => l.id));
    visibleLinks.forEach((link) => window.open(link.url, '_blank', 'noopener,noreferrer'));
    setData((d) => ({ ...d, links: d.links.map((l) => (ids.has(l.id) ? { ...l, lastOpenedAt: now } : l)) }));
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
      links: d.links.map((l) => (l.folderId === id ? { ...l, folderId: DEFAULT_FOLDER_ID } : l)),
    }));
    if (activeFolderId === id) setActiveFolderId('all');
  }

  const recent = recentLinks(data);
  const jumpBackIn = jumpBackInLinks(data);

  return (
    <div className="card dashboard-card pinned-links">
      <div className="dashboard-card-header">
        <h3>Pinned links</h3>
      </div>

      {data.links.length === 0 && (
        <div className="pinned-links-recent pinned-links-recent-empty">
          Links you open or add will show up here.
        </div>
      )}

      {jumpBackIn.length > 0 && (
        <div className="pinned-links-recent">
          <div className="pinned-links-recent-label">
            <Rewind size={12} /> Jump back in
          </div>
          <div className="pinned-links-recent-row">
            {jumpBackIn.map((link) => (
              <a
                key={link.id}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pinned-link-chip"
                onClick={() => recordOpen(link.id)}
              >
                <FaviconImg url={link.url} />
                {link.label}
              </a>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="pinned-links-recent">
          <div className="pinned-links-recent-label">
            <Clock size={12} /> Recently added
          </div>
          <div className="pinned-links-recent-row">
            {recent.map((link) => (
              <a
                key={link.id}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pinned-link-chip"
                onClick={() => recordOpen(link.id)}
              >
                <FaviconImg url={link.url} />
                {link.label}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="pinned-links-search">
        <Search size={13} className="pinned-links-search-icon" />
        <input
          className="pinned-links-search-input"
          placeholder="Search links…"
          value={linkQuery}
          onChange={(e) => setLinkQuery(e.target.value)}
        />
        {linkQuery && (
          <button className="pinned-links-search-clear" onClick={() => setLinkQuery('')} title="Clear search">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="pinned-links-folders">
        <button
          className={`pinned-folder-tab ${activeFolderId === 'all' ? 'active' : ''}`}
          onClick={() => setActiveFolderId('all')}
        >
          All
        </button>
        {data.folders
          .filter((folder) => folder.id !== DEFAULT_FOLDER_ID)
          .map((folder) => (
            <div key={folder.id} className={`pinned-folder-tab ${activeFolderId === folder.id ? 'active' : ''}`}>
              <button className="pinned-folder-tab-select" onClick={() => setActiveFolderId(folder.id)}>
                {folder.name}
              </button>
              <button
                className="pinned-folder-remove"
                onClick={() => removeFolder(folder.id)}
                aria-label={`Remove folder "${folder.name}"`}
                title={`Remove folder "${folder.name}"`}
              >
                <X size={11} />
              </button>
            </div>
          ))}

        {isAddingFolder ? (
          <form className="pinned-folder-add-form" onSubmit={addFolder}>
            <input
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={() => !newFolderName && setIsAddingFolder(false)}
            />
          </form>
        ) : (
          <button className="pinned-folder-tab pinned-folder-tab-add" onClick={() => setIsAddingFolder(true)} title="New folder">
            <FolderPlus size={13} />
          </button>
        )}
      </div>

      <div className="pinned-links-actions">
        {visibleLinks.length > 0 && (
          <button className="pinned-open-all-btn" onClick={openAllVisible} title="Open all links in new tabs">
            <ExternalLink size={12} /> Open all
          </button>
        )}
        <button className="pinned-open-all-btn" onClick={() => fileInputRef.current?.click()} title="Import bookmarks from a browser export">
          <Upload size={12} /> Import bookmarks
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html,.htm"
          onChange={handleImportFile}
          className="pinned-links-import-input"
        />
      </div>

      {importMessage && <div className="pinned-links-import-message">{importMessage}</div>}

      <div className="pinned-links-grid">
        {filteredLinks.map((link) => (
          // A <button> nested inside an <a> is invalid HTML and confuses
          // keyboard/screen-reader focus order, so the remove/edit buttons are
          // siblings absolutely-positioned over the tile (see .pinned-link-tile-link
          // in dashboard.css) rather than children of the link.
          <div key={link.id} className="pinned-link-tile">
            {renamingLinkId === link.id ? (
              <input
                autoFocus
                className="pinned-link-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(link.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(link.id);
                  if (e.key === 'Escape') setRenamingLinkId(null);
                }}
              />
            ) : (
              <>
                <button
                  className="pinned-link-remove"
                  onClick={() => removeLink(link.id)}
                  title="Remove"
                >
                  <X size={13} />
                </button>
                <button
                  className="pinned-link-edit"
                  onClick={() => startRename(link)}
                  title="Rename"
                  aria-label={`Rename "${link.label}"`}
                >
                  <Pencil size={12} />
                </button>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pinned-link-tile-link"
                  onClick={() => recordOpen(link.id)}
                >
                  <FaviconImg url={link.url} size={20} />
                  <MarqueeLabel text={link.label} />
                </a>
              </>
            )}
          </div>
        ))}

        {isAdding ? (
          <form className="pinned-link-add-form" onSubmit={addLink}>
            <input autoFocus placeholder="Label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            <input placeholder="URL" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
            <div className="pinned-link-add-actions">
              <button type="button" className="btn" onClick={() => setIsAdding(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Add
              </button>
            </div>
          </form>
        ) : (
          <button className="pinned-link-tile pinned-link-tile-add" onClick={() => setIsAdding(true)}>
            <Plus size={18} />
            <span>Add link</span>
          </button>
        )}

        {filteredLinks.length === 0 && !isAdding && (
          <div className="pinned-links-empty">
            {linkQuery ? 'No links match your search.' : 'Pin your frequently used sites for quick access.'}
          </div>
        )}
      </div>
    </div>
  );
}

function FaviconImg({ url, size = 14 }) {
  const src = faviconUrl(url);
  if (!src) return null;
  return <img src={src} alt="" width={size} height={size} className="pinned-link-favicon" />;
}

/**
 * MarqueeLabel — shows a link's name at full width, auto-scrolling
 * horizontally (no user interaction) only when the name is actually too
 * long to fit its tile. Measures the single-copy text against its
 * container via ResizeObserver (grid tiles resize with the viewport/column
 * count), and only then renders a second, aria-hidden copy of the text so
 * the CSS marquee animation (see .pinned-link-label in dashboard.css) can
 * loop seamlessly by translating exactly one copy-width.
 */
function MarqueeLabel({ text }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return undefined;

    function measure() {
      setIsOverflowing(textEl.scrollWidth > container.clientWidth + 1);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text]);

  return (
    <span className={`pinned-link-label ${isOverflowing ? 'is-marquee' : ''}`} ref={containerRef}>
      <span className="pinned-link-label-track">
        <span className="pinned-link-label-text" ref={textRef}>
          {text}
        </span>
        {isOverflowing && (
          <span className="pinned-link-label-text" aria-hidden="true">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}