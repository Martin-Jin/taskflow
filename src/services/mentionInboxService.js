/**
 * ============================================================================
 * MENTION INBOX SERVICE — Firestore I/O for in-app mention notifications
 * ============================================================================
 * Thin I/O layer; every decision is in utils/mentionNotifications.js.
 *
 * DATA SHAPE: `notifications/{recipientUid}/items/{commentId}` with fields
 * type ('mention'), senderUid, senderName, projectId, taskId, commentId,
 * taskTitle, snippet, read, createdAt (server timestamp).
 *
 * WHO WRITES WHAT (enforced by firestore.rules, not by this file):
 *   - The commenter's browser CREATES a notification for each mentioned
 *     person, only if both are members of the shared project.
 *   - The recipient reads, marks read (only the `read` flag), and deletes.
 *
 * RETENTION: see utils/mentionNotifications.js's header. The recipient's
 * browser prunes old and excess items each time the inbox loads.
 * ============================================================================
 */

import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Newest items the inbox listens to. Deliberately above MAX_INBOX_ITEMS so the
 * prune can see (and delete) the overflow; a query that stopped at the cap
 * would leave anything past it permanently invisible and un-prunable.
 */
const INBOX_QUERY_LIMIT = 300;

const itemsRef = (uid) => collection(db, 'notifications', uid, 'items');
const itemRef = (uid, id) => doc(db, 'notifications', uid, 'items', id);

/**
 * Write the notification docs built by buildMentionNotifications. One failed
 * recipient must not block the others, so each is its own write.
 * @returns {Promise<PromiseSettledResult[]>}
 */
export function sendMentionNotifications(notifications) {
  return Promise.allSettled(
    notifications.map(({ recipientUid, id, data }) =>
      setDoc(itemRef(recipientUid, id), { ...data, createdAt: serverTimestamp() })
    )
  );
}

/**
 * Live listener on the signed-in user's own inbox, newest first.
 * @param {string} uid
 * @param {(items: Array<object>) => void} onItems - each item has `id` and `createdAtMs` (null while a write is pending)
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unsubscribe
 */
export function subscribeInbox(uid, onItems, onError) {
  const q = query(itemsRef(uid), orderBy('createdAt', 'desc'), limit(INBOX_QUERY_LIMIT));
  return onSnapshot(
    q,
    (snap) =>
      onItems(
        snap.docs.map((d) => {
          const data = d.data();
          return { ...data, id: d.id, createdAtMs: data.createdAt?.toMillis?.() ?? null };
        })
      ),
    onError
  );
}

export function markNotificationRead(uid, id) {
  return updateDoc(itemRef(uid, id), { read: true });
}

/** Mark several read / delete several, in batches under Firestore's 500-op limit. */
async function batched(uid, ids, apply) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    ids.slice(i, i + 400).forEach((id) => apply(batch, itemRef(uid, id)));
    await batch.commit();
  }
}

export const markNotificationsRead = (uid, ids) => batched(uid, ids, (b, ref) => b.update(ref, { read: true }));
export const deleteNotifications = (uid, ids) => batched(uid, ids, (b, ref) => b.delete(ref));
