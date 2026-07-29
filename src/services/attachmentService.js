/**
 * ============================================================================
 * ATTACHMENT SERVICE
 * ============================================================================
 * Uploads/deletes files attached to task comments, stored in Firebase
 * Storage under `users/{uid}/attachments/{taskId}/...` — mirrors the
 * uid-scoped ownership model already used for Firestore (see firestore.rules
 * and storage.rules). Called from SchedulerContext's addComment/deleteComment
 * so every write to task.comments and the underlying file happens together.
 * ============================================================================
 */

import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';

// MUST stay in sync with the size cap in storage.rules (a client-side-only
// check is easy to bypass, and a server-side-only one lets an oversized
// upload run to completion before failing) — bump both together.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

// Images (for the inline thumbnail preview) plus common document types —
// intentionally not "any file", since Storage is unauthenticated-readable
// once a download URL exists and this keeps that surface predictable. Each
// entry pairs the MIME type (used for validation) with its extension (used
// for the file-picker's `accept` filter) so the two can't drift apart.
const ALLOWED_FILE_TYPES = [
  { mime: 'image/png', ext: '.png' },
  { mime: 'image/jpeg', ext: '.jpg,.jpeg' },
  { mime: 'image/gif', ext: '.gif' },
  { mime: 'image/webp', ext: '.webp' },
  { mime: 'image/svg+xml', ext: '.svg' },
  { mime: 'application/pdf', ext: '.pdf' },
  { mime: 'application/msword', ext: '.doc' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  { mime: 'application/vnd.ms-excel', ext: '.xls' },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  { mime: 'application/vnd.ms-powerpoint', ext: '.ppt' },
  { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  { mime: 'text/plain', ext: '.txt' },
  { mime: 'text/csv', ext: '.csv' },
];

const ALLOWED_TYPES = new Set(ALLOWED_FILE_TYPES.map((t) => t.mime));

export const ATTACHMENT_ACCEPT = ALLOWED_FILE_TYPES.flatMap((t) => [t.mime, ...t.ext.split(',')]).join(',');

/**
 * Returns a user-facing error string if `file` can't be attached, or null
 * if it's fine to upload. Checked before ever touching Storage so a
 * rejected file fails instantly instead of after a slow upload starts.
 */
export function validateAttachment(file) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `"${file.name}" is over the 10MB attachment limit.`;
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    return `"${file.name}" isn't a supported file type — images, PDFs, and common office docs only.`;
  }
  return null;
}

// Firebase's Storage SDK has no built-in upload timeout — on a dead/stalled
// connection the request can sit unresolved indefinitely, which reads to the
// user as the comment box being permanently "stuck" with no error and no way
// to retry. This caps how long we wait before giving up with a clear error.
const UPLOAD_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Uploads a comment's attachment and returns the metadata persisted on the
 * Comment object. `path` is kept (not just `url`) so deleteCommentAttachment
 * can address the exact Storage object later without re-deriving it.
 */
export async function uploadCommentAttachment(uid, taskId, file) {
  const path = `users/${uid}/attachments/${taskId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  const timeoutMessage = 'Upload timed out — check your connection and try again.';
  await withTimeout(uploadBytes(storageRef, file, { contentType: file.type || undefined }), UPLOAD_TIMEOUT_MS, timeoutMessage);
  const url = await withTimeout(getDownloadURL(storageRef), UPLOAD_TIMEOUT_MS, timeoutMessage);
  return { url, path, name: file.name, size: file.size, type: file.type || '' };
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Best-effort delete — called when a comment (or its parent task) is
 * deleted. Swallows errors (e.g. object already gone) since this is cleanup,
 * not the primary action the user is waiting on.
 */
export async function deleteCommentAttachment(path) {
  if (!path) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (err) {
    console.warn('[attachmentService] Failed to delete attachment', path, err);
  }
}
