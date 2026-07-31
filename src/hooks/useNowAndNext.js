import { useEffect, useMemo, useState } from 'react';
import { toISODate, timeToMinutes } from '../utils/dateUtils';
import { isBlockTaskCompleted } from '../utils/missedTasks';

/**
 * Derives "what should I be doing right now" from the scheduler's blocks:
 * the block currently in progress (if any) and the next one coming up
 * today or on the nearest future day with anything scheduled. Recomputes
 * every 30s (same cadence as WeekView's live now-line) so the dashboard's
 * progress bar/countdown stay accurate without re-rendering constantly.
 */
export function useNowAndNext(tasks, blocks) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  // Kept separate from the `now`-dependent memo below: tasks/blocks only
  // change on real data edits, but `now` ticks every 30s, and rebuilding
  // this map on every tick for data that hasn't changed is wasted work.
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  return useMemo(() => {
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Excludes blocks whose occurrence is already completed (e.g. a recurring
    // task finished early — see isBlockTaskCompleted) so a done task doesn't
    // still show up as "in progress" here.
    const isDone = (b) => isBlockTaskCompleted(b, taskById.get(b.taskId));

    const todaysBlocks = blocks
      .filter((b) => b.date === today && !isDone(b))
      .slice()
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    const currentBlock = todaysBlocks.find(
      (b) => timeToMinutes(b.startTime) <= nowMinutes && nowMinutes < timeToMinutes(b.endTime)
    );

    let nextBlock = todaysBlocks.find((b) => timeToMinutes(b.startTime) > nowMinutes);
    if (!nextBlock) {
      const future = blocks
        .filter((b) => b.date > today && !isDone(b))
        .slice()
        .sort((a, b) => (a.date === b.date ? timeToMinutes(a.startTime) - timeToMinutes(b.startTime) : a.date < b.date ? -1 : 1));
      nextBlock = future[0];
    }

    function withTask(block) {
      if (!block) return null;
      const task = taskById.get(block.taskId);
      const startMin = timeToMinutes(block.startTime);
      const endMin = timeToMinutes(block.endTime);
      const progress = block === currentBlock ? Math.min(1, Math.max(0, (nowMinutes - startMin) / (endMin - startMin))) : 0;
      return { block, task, progress };
    }

    return {
      now,
      current: withTask(currentBlock),
      next: withTask(nextBlock),
    };
  }, [taskById, blocks, now]);
}
