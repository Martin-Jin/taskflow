/**
 * MarqueeText — renders text clipped to its box with a plain ellipsis, but
 * auto-scrolls (pause / scroll left to reveal the tail / pause / reset) when
 * the text actually overflows. Overflow is measured via `scrollWidth >
 * clientWidth` on the wrapper (recomputed on resize and whenever `text`
 * changes, via ResizeObserver) rather than guessed from character count,
 * since font size, zoom, and available width all move where the real
 * cutoff falls — short text that already fits is never animated.
 *
 * The scroll itself is a plain CSS @keyframes animation (see
 * .marquee-text-inner in global.css), driven only by this measurement plus a
 * `--marquee-overflow` custom property — no per-frame JS — so it
 * automatically respects `prefers-reduced-motion` and the app's "Interface
 * animations" off-switch, both of which already collapse every animation's
 * duration to ~0 (see global.css's rules right after the :root token block).
 */

import { useEffect, useRef, useState } from 'react';

export default function MarqueeText({ text, className = '' }) {
  const ref = useRef(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    function measure() {
      setOverflowPx(Math.max(0, el.scrollWidth - el.clientWidth));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const isOverflowing = overflowPx > 0;

  return (
    <span ref={ref} className={`marquee-text ${className}`}>
      {isOverflowing ? (
        <span className="marquee-text-inner" style={{ '--marquee-overflow': `${overflowPx}px` }}>
          {text}
        </span>
      ) : (
        text
      )}
    </span>
  );
}
