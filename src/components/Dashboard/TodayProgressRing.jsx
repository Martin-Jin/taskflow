import React, { useMemo } from 'react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, isBlockPast } from '../../utils/dateUtils';
import ProgressRingCard from './ProgressRingCard';

export default function TodayProgressRing() {
  const { blocks } = useScheduler();

  const { percent, completedHours, totalHours } = useMemo(() => {
    const now = new Date();
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayBlocks = blocks.filter((b) => b.date === today);
    const total = todayBlocks.reduce((sum, b) => sum + b.durationHours, 0);
    const completed = todayBlocks
      .filter((b) => isBlockPast(b, today, nowMinutes))
      .reduce((sum, b) => sum + b.durationHours, 0);

    return {
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      completedHours: completed,
      totalHours: total,
    };
  }, [blocks]);

  return (
    <ProgressRingCard
      title="Today's progress"
      percent={percent}
      completedHours={completedHours}
      totalHours={totalHours}
      emptyMessage="Nothing scheduled today yet."
    />
  );
}
