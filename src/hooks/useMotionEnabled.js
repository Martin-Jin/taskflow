/**
 * useMotionEnabled — the single "is motion allowed right now?" check for
 * JS-driven animation (framer-motion), mirroring what the CSS already does
 * for keyframes/transitions via `:root[data-animations='off']` in global.css.
 *
 * The Settings → Interface animations toggle is an explicit user choice, so
 * it always wins over the OS-level reduced-motion preference — someone who
 * turns it on wants motion in this app specifically, even if they run with
 * OS-wide reduced motion for other apps/vestibular reasons. CSS gating can't
 * reach framer-motion, which writes transforms straight to inline styles
 * frame by frame — so any motion component has to consult this and drop its
 * `layout`/`exit`/`transition` props itself when it returns false (at which
 * point `motion.div` behaves exactly like a plain `div`).
 */

import { useScheduler } from '../context/SchedulerContext';

export function useMotionEnabled() {
  const { animationsEnabled } = useScheduler();
  return animationsEnabled;
}
