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
