/**
 * Settings → Notifications — in-app/email channel toggles plus per-category
 * task-event toggles. See useNotificationChecker.js for where these settings
 * are actually read (local-only transient toasts, not a persisted inbox).
 */

import React from 'react';
import { useScheduler } from '../../../context/SchedulerContext';
import { useAuth } from '../../../context/AuthContext';
import { requestNotificationPermission } from '../../../services/notificationService';
import NumberField from '../../Common/NumberField';

// Email notifications go to ONE fixed recipient address configured in the
// notify-worker GitHub Actions secret (see notify-worker/index.js's SENDER
// comment) — there's no per-user email lookup. Restricted to this single
// account's uid so other users can't turn on a toggle that would silently
// email someone else's inbox instead of their own.
const EMAIL_NOTIFICATIONS_OWNER_UID = 'f053vFPMR1T95KX9WAZGWt9ioAq1';

export default function NotificationsSection({ sectionRef }) {
  const { notificationSettings, setNotificationSettings } = useScheduler();
  const { user } = useAuth();
  const canUseEmailNotifications = user?.uid === EMAIL_NOTIFICATIONS_OWNER_UID;

  // Updates a notificationSettings field, requesting browser Notification
  // permission right here if a toggle is being turned ON — this is a direct
  // user action, so prompting now (rather than on some later app load) is
  // never a surprise. requestNotificationPermission itself no-ops if the
  // API is unavailable or the user already granted/denied it previously.
  function updateNotificationSetting(field, value) {
    setNotificationSettings({ ...notificationSettings, [field]: value });
    if (value === true) requestNotificationPermission();
  }

  return (
    <div className="card settings-card" ref={sectionRef}>
      <h3>Notifications</h3>
      <p className="settings-hint">
        Choose which channels and task events can notify you. In-app notifications fire while TaskFlow
        is open, via your browser's notification popup (falling back to an in-app toast if that's not
        available/permitted). Email notifications require a one-time self-hosted setup of a GitHub
        Actions scheduled workflow (see notify-worker/README.md) — turning this on here does nothing
        until that's set up. That setup is single-recipient by design (no domain purchase needed):
        every email goes to one fixed address configured in the workflow, not to this account's own
        sign-in email.
      </p>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="notifInApp"
          checked={notificationSettings.inAppEnabled}
          onChange={(e) => updateNotificationSetting('inAppEnabled', e.target.checked)}
        />
        <label htmlFor="notifInApp">In-app notifications</label>
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="notifEmail"
          checked={notificationSettings.emailEnabled}
          disabled={!canUseEmailNotifications}
          onChange={(e) => setNotificationSettings({ ...notificationSettings, emailEnabled: e.target.checked })}
        />
        <label htmlFor="notifEmail" style={{ margin: 0, opacity: canUseEmailNotifications ? 1 : 0.5 }}>
          Email notifications
        </label>
      </div>
      {!canUseEmailNotifications && (
        <p className="settings-hint">
          Email notifications aren't available for this account — the self-hosted setup only supports
          sending to a single fixed recipient (see the note above).
        </p>
      )}
      <p className="settings-hint">Notify me when:</p>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="notifStartingSoon"
          checked={notificationSettings.taskStartingSoon}
          onChange={(e) => updateNotificationSetting('taskStartingSoon', e.target.checked)}
        />
        <label htmlFor="notifStartingSoon">A task is starting soon</label>
      </div>
      <div className="form-row" style={{ marginTop: 8, maxWidth: 220 }}>
        <label htmlFor="notifStartingSoonMinutes" style={{ opacity: notificationSettings.taskStartingSoon ? 1 : 0.5 }}>
          "Starting soon" threshold (minutes)
        </label>
        <NumberField
          id="notifStartingSoonMinutes"
          min={1}
          max={180}
          unitLabel="minutes"
          value={notificationSettings.startingSoonMinutes}
          disabled={!notificationSettings.taskStartingSoon}
          onCommit={(v) => setNotificationSettings({ ...notificationSettings, startingSoonMinutes: v })}
        />
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="notifOverdue"
          checked={notificationSettings.taskOverdue}
          onChange={(e) => updateNotificationSetting('taskOverdue', e.target.checked)}
        />
        <label htmlFor="notifOverdue">A task becomes overdue</label>
      </div>
      <div className="form-row settings-toggle-row">
        <input
          type="checkbox"
          id="notifDueToday"
          checked={notificationSettings.taskDueToday}
          onChange={(e) => updateNotificationSetting('taskDueToday', e.target.checked)}
        />
        <label htmlFor="notifDueToday">A task is due today</label>
      </div>
    </div>
  );
}
