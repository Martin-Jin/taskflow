/**
 * The signed-in user's mention inbox: a live list from Firestore, an unread
 * count, and mark-read actions. See utils/mentionNotifications.js for what the
 * inbox is and its retention policy.
 *
 * Only real accounts have an inbox. A signed-out visitor or an anonymous guest
 * (see isGuestUser) never subscribes, and anonymous people cannot be mentioned
 * in the first place.
 *
 * PRUNING: the first time a listener delivers items for a given sign-in, the
 * overflow and expired entries are deleted (planInboxPrune). Doing it once per
 * subscription keeps it cheap and means an item that ages out while the app is
 * closed still goes the next time it is opened.
 *
 * The mentions toggle in Settings hides the list and the count on THIS device;
 * it cannot stop delivery, because a sender's browser cannot read the
 * recipient's settings.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useScheduler } from '../context/SchedulerContext';
import { isGuestUser } from '../utils/sharedProjectAccess';
import { areMentionNotificationsEnabled, planInboxPrune } from '../utils/mentionNotifications';
import {
  deleteNotifications,
  markNotificationRead,
  markNotificationsRead,
  subscribeInbox,
} from '../services/mentionInboxService';

export default function useMentionInbox() {
  const { user } = useAuth();
  const { notificationSettings } = useScheduler();
  const [items, setItems] = useState([]);
  const uid = user && !isGuestUser(user) ? user.uid : null;
  const enabled = areMentionNotificationsEnabled(notificationSettings);

  useEffect(() => {
    if (!uid) {
      setItems([]);
      return undefined;
    }
    let pruned = false;
    const unsubscribe = subscribeInbox(
      uid,
      (next) => {
        setItems(next);
        if (pruned) return;
        pruned = true;
        const stale = planInboxPrune(next, Date.now());
        if (stale.length) deleteNotifications(uid, stale).catch((err) => console.warn('Inbox prune failed', err));
      },
      (err) => console.warn('Mention inbox listener failed', err)
    );
    return unsubscribe;
  }, [uid]);

  const visible = useMemo(() => (enabled ? items : []), [enabled, items]);
  const unreadCount = useMemo(() => visible.filter((n) => !n.read).length, [visible]);

  const markRead = useCallback((id) => uid && markNotificationRead(uid, id).catch(() => {}), [uid]);
  const markAllRead = useCallback(() => {
    const ids = visible.filter((n) => !n.read).map((n) => n.id);
    if (uid && ids.length) markNotificationsRead(uid, ids).catch(() => {});
  }, [uid, visible]);

  return { available: !!uid, items: visible, unreadCount, markRead, markAllRead };
}
