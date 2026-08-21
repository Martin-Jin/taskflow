/**
 * downloadTextFile — trigger a browser download of an in-memory string, via
 * a Blob URL and a throwaway <a download>. No server round trip.
 *
 * Shared by the JSON backup export (backupService.downloadBackupFile) and the
 * note editor's "Export as Markdown", which only differ in filename, MIME
 * type, and how they serialize their content.
 */

export function downloadTextFile(filename, text, mimeType = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Turn arbitrary user text into something safe to use as a filename on every
 * platform — Windows is the strict one (`\ / : * ? " < > |` are all illegal).
 * Falls back to `fallback` when a title is empty or entirely punctuation.
 */
export function toSafeFilename(name, fallback = 'untitled') {
  const cleaned = (name || '')
    .replace(/[\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
