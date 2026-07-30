/**
 * useMotionEnabled — the single "is motion allowed right now?" check for
 * JS-driven animation (framer-motion), mirroring what the CSS already does
 * for keyframes/transitions via `:root[data-animations='off']` and the
 * `prefers-reduced-motion` query in global.css.
 *
 * CSS gating can't reach framer-motion, which writes transforms straight to
 * inline styles frame by frame — so any motion component has to consult this
 * and drop its `layout`/`exit`/`transition` props itself when it returns
 * false (at which point `motion.div` behaves exactly like a plain `div`).
 * Same two inputs as useAnimatedUnmount's own check, so there's one notion
 * of "motion is off" across the app: the user's Settings → Interface
 * animations toggle, and the OS-level reduced-motion preference.
 */

import { useReducedMotion } from 'framer-motion';
import { useScheduler } from '../context/SchedulerContext';

export function useMotionEnabled() {
  const { animationsEnabled } = useScheduler();
  const prefersReducedMotion = useReducedMotion();
  return animationsEnabled && !prefersReducedMotion;
}
