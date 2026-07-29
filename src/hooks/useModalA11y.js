/**
 * useModalA11y — shared keyboard/focus behavior for every modal in the app
 * (AddTaskModal, TaskDetailModal, BlockDetailModal, EventDetailModal, and
 * the rest of src/components/Modals/, plus GuidedTour). None of these
 * trapped focus or closed on Escape before, so Tab could leak out to the
 * page behind the overlay and screen readers had no dialog context — this
 * centralizes the fix instead of repeating it in every modal.
 *
 * Usage: const modalRef = useModalA11y(requestClose); then attach modalRef
 * to the `.modal` element and add role="dialog" aria-modal="true" in JSX
 * (kept explicit per-call since the accessible name differs per modal).
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Modals can nest (e.g. TaskDetailModal's own "..." menu opening
// SmartParseGuideModal on top of it — a sub-task's TaskDetailModal instead
// reuses the same modal in place, see that component's doc comment). Every
// open modal's close handler lives here in mount order, so Escape can always
// resolve to "close only the topmost one" instead of every open handler
// racing to interpret the same keypress.
const openModalStack = [];

export function useModalA11y(onClose) {
  const modalRef = useRef(null);
  // `onClose` is typically `requestClose` from useAnimatedUnmount, a plain
  // closure that gets a new identity every render — if the effect below
  // depended on `onClose` directly, it would tear down and re-run on every
  // re-render of the modal (e.g. every keystroke in a controlled field),
  // which re-focuses the modal's first focusable element each time and
  // makes any field after it un-typeable. A ref sidesteps that: the effect
  // only depends on mount/unmount, and reads the latest onClose through
  // the ref when it actually needs to call it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const modalEl = modalRef.current;
    const previouslyFocused = document.activeElement;
    const entry = { onClose: () => onCloseRef.current() };
    openModalStack.push(entry);

    const focusable = () => Array.from(modalEl?.querySelectorAll(FOCUSABLE_SELECTOR) || []);
    const first = focusable()[0];
    (first || modalEl)?.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (openModalStack[openModalStack.length - 1] !== entry) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const [firstEl, lastEl] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      openModalStack.splice(openModalStack.indexOf(entry), 1);
      previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return modalRef;
}
