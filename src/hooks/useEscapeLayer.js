/**
 * useEscapeLayer — one shared stack deciding who handles Escape.
 *
 * THE BUG THIS FIXES. Escape used to be handled independently by whoever
 * happened to be listening, and the modal always won. `useModalA11y` listened
 * at `document` in the CAPTURE phase and called `stopPropagation()`, so the
 * event never reached its actual target — which killed every
 * Escape-to-dismiss-this-inner-thing handler inside a modal. Pressing Escape
 * with a SelectMenu dropdown open in AddTaskModal, or mid-word in its label
 * picker, threw away the whole draft task instead of just closing the popup
 * the user was looking at. Measured, not theorised: both discarded the modal
 * in one keypress.
 *
 * There is no ordering trick that fixes this. Capture phase means the outermost
 * listener wins, which is backwards; bubble phase at `document` still loses to
 * nothing in particular, since same-node listeners fire in registration order
 * and `stopPropagation` doesn't stop siblings. So ordering can't come from the
 * DOM — it has to be explicit. `useModalA11y` already knew this for the
 * modal-on-modal case and kept a private `openModalStack`; this generalises
 * that one idea to every dismissible layer, which is all a modal ever was.
 *
 * THE RULE: Escape resolves to exactly one layer, the innermost open one.
 * Registration order is the nesting order, and it comes out right for free —
 * modals register on mount, while transient layers (an open dropdown, an
 * inline edit) register only while they're actually active, hence later than
 * the modal containing them. A layer that registered on mount inside a modal
 * would be wrong (child effects run before parent ones), so don't: register
 * on the state that makes the layer dismissible, not on mount.
 *
 * Consequence for new code: an inner control does NOT need to fight for the
 * event. If it wants Escape, it registers a layer; if it doesn't, Escape
 * correctly falls through to the modal. Element-level `onKeyDown` Escape
 * branches inside a modal still don't fire — the stack stops propagation, same
 * as before — so a control converting to this must move its logic into the
 * registered callback rather than leaving it on the input.
 */

import { useEffect, useRef } from 'react';

// Innermost layer last. Module-level, because "who is innermost" is a
// question about the whole page, not about any one component subtree.
const layers = [];
let isListening = false;

/**
 * The decision, separated from the listener that feeds it so the ordering
 * logic — the part that was actually wrong — is testable without a DOM (the
 * same reason useCloudSync's merge decisions were pulled out as pure
 * functions).
 *
 * @param {{key: string, stopPropagation: () => void}} e
 * @returns {boolean} whether a layer claimed the keypress
 */
export function dispatchEscape(e) {
  if (e.key !== 'Escape') return false;
  const top = layers[layers.length - 1];
  if (!top) return false;
  // Capture phase + stopPropagation so no other handler also acts on this
  // keypress. Deliberately NOT preventDefault: a native <select> with its
  // OS-rendered option list open needs the browser's own Escape behaviour to
  // keep working, and that list isn't ours to close.
  e.stopPropagation();
  top.onEscape();
  return true;
}

/**
 * Imperative form, for callers already inside a mount effect (see
 * `useModalA11y`, which registers alongside its focus-trap setup).
 *
 * @param {() => void} onEscape
 * @returns {() => void} unregister
 */
export function registerEscapeLayer(onEscape) {
  const layer = { onEscape };
  layers.push(layer);
  if (!isListening && typeof document !== 'undefined') {
    document.addEventListener('keydown', dispatchEscape, true);
    isListening = true;
  }
  return function unregister() {
    // Guard indexOf === -1: splice treats a negative index as "count back from
    // the end", so splice(-1, 1) on any non-empty stack would silently drop
    // the topmost layer — someone else's — instead of no-op'ing when this one
    // is already gone (a double cleanup, or the stack falling out of sync).
    const index = layers.indexOf(layer);
    if (index !== -1) layers.splice(index, 1);
  };
}

/**
 * Hook form. Registers only while `active`, which is what keeps the stack
 * order equal to the nesting order — see the note above.
 *
 * `onEscape` is read through a ref, so an inline closure (the normal way to
 * call this) doesn't re-register on every render.
 *
 * @param {boolean} active - whether this layer is currently dismissible
 * @param {() => void} onEscape
 */
export function useEscapeLayer(active, onEscape) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    return registerEscapeLayer(() => onEscapeRef.current());
  }, [active]);
}

/** Test-only: how many layers are currently registered. */
export function escapeLayerCount() {
  return layers.length;
}
