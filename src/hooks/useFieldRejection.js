/**
 * useFieldRejection — shared "that input wasn't accepted" feedback for a
 * single field, so a rejecting handler can say why instead of silently
 * returning (pressing Enter on an empty note title used to just do nothing).
 *
 * Two parts, both deliberately small: a one-shot shake on the input itself
 * (the app's existing .shake-error idiom, see global.css) and a short message
 * rendered next to it via <FieldRejectionHint>. The message clears itself
 * after MESSAGE_TTL_MS so a stale warning never sits under a field the user
 * has since fixed; wire `clear` to onChange to dismiss it on the first
 * keystroke instead of waiting that out.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * WHICH REJECTION MECHANISM TO USE
 *
 * There are deliberately two, for two different jobs:
 *
 *  - This hook (+ <FieldRejectionHint>) is for a FIELD rejecting a value as
 *    you interact with it: out of range, unparseable, a note with no title.
 *    It shakes the offending input and prints a message directly above it, and
 *    clears itself. Use it wherever one control can say "not that" on its own.
 *
 *  - A modal's own `error` state (see AddTaskModal's handleSubmit) is for FORM
 *    validation at submit time, where the problem is a relationship between
 *    fields rather than one bad value — "a recurring task needs a starting due
 *    date", "pick a time, or turn off Fixed time". There's no single input to
 *    shake, and the message belongs near the submit button.
 *
 * If a new case fits both, prefer this hook: field-level feedback arrives while
 * the user is still looking at the control that caused it.
 */

const MESSAGE_TTL_MS = 4500;

export function useFieldRejection() {
  const [message, setMessage] = useState(null);
  const [isShaking, setIsShaking] = useState(false);

  const reject = useCallback((text) => {
    setMessage(text);
    setIsShaking(true);
  }, []);

  const clear = useCallback(() => setMessage(null), []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return {
    message,
    reject,
    clear,
    /* Spread onto the input being rejected. The class is dropped on
       animationend rather than left in place, so a second rejection of the
       same field replays the shake instead of being a no-op re-render. */
    shakeProps: {
      className: isShaking ? 'shake-error' : '',
      onAnimationEnd: () => setIsShaking(false),
    },
  };
}
