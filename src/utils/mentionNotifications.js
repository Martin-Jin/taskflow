/**
 * ============================================================================
 * MENTION NOTIFICATIONS — pure logic (Collaborative Projects, Phase 4)
 * ============================================================================
 * When someone @-mentions a collaborator in a shared task's comment, the
 * mentioned person gets an entry in their in-app inbox. The inbox lives in
 * Firestore at `notifications/{recipientUid}/items/{notificationId}` and is
 * written by the COMMENTER's own browser (see services/mentionInboxService.js
 * and the `notifications` block in firestore.rules). This file holds the
 * decisions, with no React or Firebase, so they can be unit tested:
 *
 *   - buildMentionNotifications: which documents to write for one comment.
 *   - planInboxPrune: which stored notifications to delete to keep the
 *     inbox from growing forever.
 *
 * RETENTION (CLAUDE.md requires a policy for any new Firestore data):
 *   - Read notifications are deleted after READ_RETENTION_DAYS.
 *   - Unread ones are kept longer (UNREAD_RETENTION_DAYS) so a holiday does
 *     not silently eat what you never saw, but not forever.
 *   - The inbox is capped at MAX_INBOX_ITEMS newest items regardless of age,
 *     so a burst of mentions cannot grow it without limit.
 *   The prune runs in the RECIPIENT's browser each time their inbox loads
 *   (a recipient may delete their own notifications under the rules).
 * ============================================================================
 */

import { parseCommentBody } from './commentMentions';

export const READ_RETENTION_DAYS = 30;
export const UNREAD_RETENTION_DAYS = 90;
export const MAX_INBOX_ITEMS = 100;

/** Most recipients one comment will notify; a comment mentioning more is almost certainly a mistake or abuse. */
export const MAX_RECIPIENTS_PER_COMMENT = 20;

/** Field size limits. Mirrored in firestore.rules, so keep the two in step. */
export const MAX_SNIPPET_LENGTH = 200;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NAME_LENGTH = 120;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A comment body as plain text: each stored `@[Name](uid)` token becomes
 * "@Name", whitespace is collapsed, and the result is cut to the snippet size.
 * @param {string} text
 * @returns {string}
 */
export function buildSnippet(text) {
  const plain = parseCommentBody(text)
    .map((seg) => (seg.type === 'mention' ? `@${seg.displayName}` : seg.value))
    .join('');
  return truncate(plain, MAX_SNIPPET_LENGTH);
}

/**
 * Work out the notification documents to write for one posted comment.
 *
 * `comment.mentions` is trusted as-is: it was already checked against real
 * project membership when the comment was posted (extractValidMentionUids),
 * so the comment body is deliberately never re-parsed for uids here. The
 * security rule re-checks membership on the server anyway.
 *
 * The document id is the comment id, so posting the same comment twice can
 * only ever overwrite one notification, never create a second.
 *
 * @param {{ comment: {id: string, text?: string, mentions?: string[]}, senderUid: string, senderName: string, projectId: string, taskId: string, taskTitle: string }} args
 * @returns {Array<{recipientUid: string, id: string, data: object}>} `data` has no `createdAt` — the service stamps it with the server clock.
 */
export function buildMentionNotifications({ comment, senderUid, senderName, projectId, taskId, taskTitle }) {
  if (!comment?.id || !senderUid || !projectId || !taskId) return [];
  const recipients = [...new Set(comment.mentions || [])]
    .filter((uid) => typeof uid === 'string' && uid && uid !== senderUid)
    .slice(0, MAX_RECIPIENTS_PER_COMMENT);
  if (!recipients.length) return [];
  const data = {
    type: 'mention',
    senderUid,
    senderName: truncate(senderName || 'Someone', MAX_NAME_LENGTH) || 'Someone',
    projectId,
    taskId,
    commentId: comment.id,
    taskTitle: truncate(taskTitle || 'Untitled task', MAX_TITLE_LENGTH) || 'Untitled task',
    snippet: buildSnippet(comment.text),
    read: false,
  };
  return recipients.map((recipientUid) => ({ recipientUid, id: comment.id, data: { ...data } }));
}

/**
 * Which stored notifications should be deleted. Pure, so the retention rules
 * are testable without Firestore.
 *
 * @param {Array<{id: string, read?: boolean, createdAtMs: number|null}>} items
 * @param {number} nowMs
 * @returns {string[]} ids to delete
 */
export function planInboxPrune(items, nowMs) {
  const readCutoff = nowMs - READ_RETENTION_DAYS * MS_PER_DAY;
  const unreadCutoff = nowMs - UNREAD_RETENTION_DAYS * MS_PER_DAY;
  const toDelete = [];
  const kept = [];
  for (const item of items || []) {
    // A null timestamp is a write still pending on this device; never prune it.
    if (item.createdAtMs == null) {
      kept.push(item);
      continue;
    }
    const cutoff = item.read ? readCutoff : unreadCutoff;
    if (item.createdAtMs < cutoff) toDelete.push(item.id);
    else kept.push(item);
  }
  kept.sort((a, b) => (b.createdAtMs ?? Infinity) - (a.createdAtMs ?? Infinity));
  for (const item of kept.slice(MAX_INBOX_ITEMS)) toDelete.push(item.id);
  return toDelete;
}

/**
 * Whether the mention category is on. A settings object saved before the
 * category existed has no `mentions` key, which counts as on.
 * @param {{mentions?: boolean}|null|undefined} notificationSettings
 */
export function areMentionNotificationsEnabled(notificationSettings) {
  return notificationSettings?.mentions !== false;
}
