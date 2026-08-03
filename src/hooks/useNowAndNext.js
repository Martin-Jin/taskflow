import { useEffect, useMemo, useState } from 'react';
import { toISODate, timeToMinutes } from '../utils/dateUtils';
import { isBlockTaskCompleted } from '../utils/missedTasks';
import { expandEventsForRange } from '../utils/recurrenceExpansion';

/**
 * Pure "what should I be doing right now" decision, extracted out of the
 * `now`-ticking hook below so it can be unit tested without mounting a
 * component (see tests/unit/useNowAndNext.test.js). Derives the item
 * currently in progress (if any, task block or event) and the next one
 * coming up today or on the nearest future day with anything scheduled.
 *
 * When more than one item overlaps the current/next slot, `current`/`next`
 * surface only the earliest-starting one (ties broken by array order,
 * blocks before events) — `current.overlapCount`/`next.overlapCount` report
 * how many OTHER items share that same moment, so callers can render a
 * "+N more" affordance instead of silently hiding them.
 */
export function computeNowAndNext(tasks, blocks, events, now) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const today = toISODate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Excludes blocks whose occurrence is already completed (e.g. a recurring
  // task finished early — see isBlockTaskCompleted) so a done task doesn't
  // still show up as "in progress" here.
  const isDone = (b) => isBlockTaskCompleted(b, taskById.get(b.taskId));

  function toItem(block) {
    const task = taskById.get(block.taskId);
    return { kind: 'block', block, task, date: block.date, startTime: block.startTime, endTime: block.endTime };
  }
  function eventToItem(evt) {
    return { kind: 'event', event: evt, date: evt.date, startTime: evt.startTime, endTime: evt.endTime };
  }

  const todaysItems = [
    ...blocks.filter((b) => b.date === today && !isDone(b)).map(toItem),
    ...expandEventsForRange(events || [], today, today).filter((e) => e.date === today).map(eventToItem),
  ].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  const isNowItem = (item) => timeToMinutes(item.startTime) <= nowMinutes && nowMinutes < timeToMinutes(item.endTime);
  const currentItems = todaysItems.filter(isNowItem);
  const currentItem = currentItems[0];

  const upcomingToday = todaysItems.filter((item) => timeToMinutes(item.startTime) > nowMinutes);
  let nextItem = upcomingToday[0];
  let nextOverlapCount = nextItem ? upcomingToday.filter((item) => item.startTime === nextItem.startTime).length - 1 : 0;
  if (!nextItem) {
    const future = blocks
      .filter((b) => b.date > today && !isDone(b))
      .map(toItem)
      .sort((a, b) => (a.date === b.date ? timeToMinutes(a.startTime) - timeToMinutes(b.startTime) : a.date < b.date ? -1 : 1));
    nextItem = future[0];
    nextOverlapCount = nextItem ? future.filter((item) => item.date === nextItem.date && item.startTime === nextItem.startTime).length - 1 : 0;
  }

  function withProgress(item, overlapCount) {
    if (!item) return null;
    const startMin = timeToMinutes(item.startTime);
    const endMin = timeToMinutes(item.endTime);
    const progress = item === currentItem ? Math.min(1, Math.max(0, (nowMinutes - startMin) / (endMin - startMin))) : 0;
    return { ...item, progress, overlapCount };
  }

  return {
    now,
    current: withProgress(currentItem, Math.max(0, currentItems.length - 1)),
    next: withProgress(nextItem, nextOverlapCount),
  };
}

/**
 * Recomputes every 30s (same cadence as WeekView's live now-line) so the
 * dashboard's progress bar/countdown stay accurate without re-rendering
 * constantly. See computeNowAndNext above for the actual selection logic.
 */
export function useNowAndNext(tasks, blocks, events) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => computeNowAndNext(tasks, blocks, events, now), [tasks, blocks, events, now]);
}

