/**
 * useAIQuickAddGate — shared "is AI Quick Add usable right now" check, used by
 * every entry point that can open AIQuickAddModal (AddTaskFabGroup,
 * CalendarPage's FAB group, App.jsx's standalone FAB, CommandPalette). The
 * feature is considered "shown" whenever `isAIQuickAddConfigured()` (a worker
 * URL is set at build time) regardless of whether the user has actually
 * pasted a provider API key into Settings yet — in that case the entry point
 * stays visible but tapping it surfaces a toast pointing at Settings instead
 * of opening the modal, rather than the button silently disappearing.
 *
 * `requestOpen(onOpen)` runs the key check and only calls `onOpen()` when a
 * key is present; callers that need to run something else on failure (e.g.
 * shaking a mini-FAB) can inspect the boolean it returns instead.
 */
import { useScheduler } from '../context/SchedulerContext';
import { isAIQuickAddConfigured, getStoredApiKey } from '../services/aiQuickAddService';

export function useAIQuickAddGate() {
  const { setNotification, requestSettingsSection } = useScheduler();
  const aiConfigured = isAIQuickAddConfigured();

  function hasStoredKey() {
    return !!getStoredApiKey('anthropic') || !!getStoredApiKey('gemini');
  }

  /** Runs `onOpen()` only if a provider key is saved; otherwise shows the toast. Returns whether it opened. */
  function requestOpen(onOpen) {
    if (!hasStoredKey()) {
      setNotification({
        type: 'error',
        message: 'Add an Anthropic or Gemini API key in Settings → Integrations first.',
        actionLabel: 'Open Settings',
        onAction: () => requestSettingsSection('integrations'),
      });
      return false;
    }
    onOpen();
    return true;
  }

  return { aiConfigured, hasStoredKey, requestOpen };
}
