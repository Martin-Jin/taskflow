/**
 * ============================================================================
 * ATTACHMENT SERVICE
 * ============================================================================
 * Uploads/deletes files attached to task comments, stored in Firebase
 * Storage. Two path shapes, chosen by `buildAttachmentPath` based on whether
 * the task belongs to a shared project:
 *   - Personal task: `users/{uid}/attachments/{taskId}/...` — mirrors the
 *     uid-scoped ownership model already used for Firestore (see
 *     firestore.rules and storage.rules).
 *   - Shared-project task: `sharedProjects/{sharedProjectId}/attachments/
 *     {taskId}/...` — uploading under the uploader's own uid would put the
 *     file outside the project owner's control (owner can't delete it, and
 *     it vanishes if the uploader is removed or deletes their account), so
 *     shared-task attachments live under the project instead. See
 *     storage.rules for what that path can and cannot enforce.
 *
 *     CURRENTLY UNREACHABLE FROM THE UI: Firebase Storage has never been
 *     provisioned for this project (likely requires the paid Blaze plan,
 *     which hasn't been adopted), so storage.rules — including the
 *     sharedProjects/... block above — has never been deployed. Every
 *     upload to this path would fail at runtime. TaskDetailModal hides the
 *     attach-file control for shared tasks, and SchedulerContext's
 *     addComment refuses a file for a shared task before ever calling
 *     uploadCommentAttachment, so this branch is dead code from the UI's
 *     perspective today. It's kept (not deleted) because it's the easiest
 *     part to re-enable: once Storage is provisioned and `firebase deploy
 *     --only storage` has been run, remove the two guards above and this
 *     path starts working immediately. See docs/DEVELOPMENT.md for the
 *     full re-enable checklist.
 * Called from SchedulerContext's addComment/deleteComment so every write to
 * task.comments and the underlying file happens together.
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
 * Returns a user-facing error string if a file attachment should be refused
 * for this task, or null if it's fine to proceed to validateAttachment/
 * upload. Currently refuses any shared-project task, since Storage isn't
 * provisioned and every such upload would fail at runtime anyway (see the
 * "CURRENTLY UNREACHABLE FROM THE UI" note on buildAttachmentPath above).
 * Kept as its own pure check — rather than inlined in SchedulerContext's
 * addComment — so it's unit-testable and there's exactly one place to
 * delete when Storage is provisioned and this is re-enabled.
 * @param {string|null|undefined} sharedProjectId - The task's `sharedProjectId`, if any.
 * @returns {string|null}
 */
export function checkAttachmentAllowed(sharedProjectId) {
  if (sharedProjectId) {
    return 'Attachments aren\'t available on shared project tasks yet.';
  }
  return null;
}

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
 * Pure path-builder, kept separate from the upload call so it's unit
 * testable without touching Firebase. `sharedProjectId` should be the
 * uploading task's own `task.sharedProjectId` (undefined/null for a
 * personal task) — NOT re-derived here, since this module has no access to
 * the tasks/sharedProjects state to look it up itself.
 * @param {string} uid
 * @param {string} taskId
 * @param {string} fileName
 * @param {string|null|undefined} sharedProjectId
 * @returns {string}
 */
export function buildAttachmentPath(uid, taskId, fileName, sharedProjectId) {
  const base = sharedProjectId
    ? `sharedProjects/${sharedProjectId}/attachments/${taskId}`
    : `users/${uid}/attachments/${taskId}`;
  return `${base}/${Date.now()}_${fileName}`;
}

/**
 * Uploads a comment's attachment and returns the metadata persisted on the
 * Comment object. `path` is kept (not just `url`) so deleteCommentAttachment
 * can address the exact Storage object later without re-deriving it.
 * @param {string} uid
 * @param {string} taskId
 * @param {File} file
 * @param {string|null|undefined} sharedProjectId - The task's `sharedProjectId`, if it belongs to a
 *   shared project; omit/null for a personal task's attachment.
 */
export async function uploadCommentAttachment(uid, taskId, file, sharedProjectId) {
  const path = buildAttachmentPath(uid, taskId, file.name, sharedProjectId);
  const storageRef = ref(storage, path);
  const timeoutMessage = 'Upload timed out — check your connection and try again.';
  await withTimeout(uploadBytes(storageRef, file, { contentType: file.type || undefined }), UPLOAD_TIMEOUT_MS, timeoutMessage);
  let url;
  try {
    url = await withTimeout(getDownloadURL(storageRef), UPLOAD_TIMEOUT_MS, timeoutMessage);
  } catch (err) {
    // The file itself already landed in Storage — without a URL nothing will
    // ever reference it, so clean it up now rather than leaving it orphaned.
    await deleteCommentAttachment(path);
    throw err;
  }
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
