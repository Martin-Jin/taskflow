/**
 * useFirstLoadSkeleton — "should this surface show a loading placeholder
 * instead of its empty state right now?"
 *
 * One hook rather than the same condition written into three pages, because the
 * condition is easy to get subtly wrong in a way that's worse than not having
 * it at all.
 */

import { useScheduler } from '../context/SchedulerContext';

/**
 * The decision, as a pure function — exported separately because the
 * interesting cases are the ones that must NOT show a skeleton, and those are
 * awkward to reach through the UI (the positive case needs a signed-in cloud
 * pull mid-flight).
 *
 * Both halves are required:
 *   - `isPullingCloud`: a signed-in cloud pull is actually in flight. Local
 *     state is read from localStorage synchronously, so a signed-out user has
 *     no loading window at all and must never see a skeleton.
 *   - `isEmpty`: there's nothing to show yet. Once even one item has arrived,
 *     the real data beats a placeholder drawn over the top of it.
 *
 * Dropping `isEmpty` would flash a skeleton over populated pages on every
 * background pull. Dropping `isPullingCloud` would leave a genuinely new user
 * watching a placeholder that never resolves — strictly worse than the honest
 * "nothing here yet" it replaced.
 *
 * @param {{isPullingCloud?: boolean, isEmpty?: boolean}} state
 * @returns {boolean}
 */
export function shouldShowFirstLoadSkeleton({ isPullingCloud, isEmpty }) {
  return !!isPullingCloud && !!isEmpty;
}

/**
 * @param {boolean} isEmpty - whether the calling surface currently has nothing to render
 * @returns {boolean}
 */
export function useFirstLoadSkeleton(isEmpty) {
  const { isPullingCloud } = useScheduler();
  return shouldShowFirstLoadSkeleton({ isPullingCloud, isEmpty });
}
