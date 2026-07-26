import React, { useMemo } from 'react';
import { useScheduler } from '../../context/SchedulerContext';
import { toISODate, getWeekRange, isBlockPast } from '../../utils/dateUtils';
import ProgressRingCard from './ProgressRingCard';

export default function WeeklyProgressRing() {
  const { blocks } = useScheduler();

  const { percent, completedHours, totalHours } = useMemo(() => {
    const now = new Date();
    const today = toISODate(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const { weekStart, weekEnd } = getWeekRange(today);

    const weekBlocks = blocks.filter((b) => b.date >= weekStart && b.date <= weekEnd);
    const total = weekBlocks.reduce((sum, b) => sum + b.durationHours, 0);
    const completed = weekBlocks
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
      title="This week's progress"
      percent={percent}
      completedHours={completedHours}
      totalHours={totalHours}
      emptyMessage="Nothing scheduled this week yet."
    />
  );
}
