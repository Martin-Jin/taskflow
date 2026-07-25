/**
 * useIsMobile — small matchMedia-backed hook for the rare cases where
 * layout branching has to happen in JS rather than pure CSS (choosing shell
 * nav markup, Calendar day-count/drag-gating, Gantt column width). Pure
 * visual/spacing changes should stay in CSS media queries using the same
 * breakpoint values (see the doc block atop global.css).
 */

import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 639px)';

export function useIsMobile() {
  const [matches, setMatches] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const listener = (e) => setMatches(e.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, []);

  return matches;
}
