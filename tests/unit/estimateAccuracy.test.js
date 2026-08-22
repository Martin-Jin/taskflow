/**
 * Coverage for estimate-vs-actual reporting.
 *
 * The property worth pinning hardest is the aggregate ratio: summing hours and
 * dividing once, rather than averaging per-task ratios. The mean-of-ratios
 * version is the more obvious implementation and is badly wrong on exactly the
 * data this app collects — short timer-tracked tasks, where a 5-minute job
 * overrunning to 15 would otherwise register as a 3.0× data point.
 */

import { describe, it, expect } from 'vitest';
import {
  computeEstimateAccuracy,
  computeAccuracyByProject,
  describeAccuracy,
  accuracyHeadline,
  MIN_RELIABLE_SAMPLE,
} from '../../src/utils/estimateAccuracy';

const task = (over = {}) => ({ id: Math.random().toString(36).slice(2), estimatedHours: 1, actualHours: 1, ...over });

describe('computeEstimateAccuracy — what counts as a sample', () => {
  it('ignores tasks with no tracked actual', () => {
    // The common case by far: actualHours is only set when a task is completed
    // with a running timer.
    const out = computeEstimateAccuracy([task({ actualHours: undefined }), task({ actualHours: null })]);
    expect(out.sampleSize).toBe(0);
    expect(out.ratio).toBeNull();
  });

  it('ignores tasks with no estimate to compare against', () => {
    expect(computeEstimateAccuracy([task({ estimatedHours: 0 })]).sampleSize).toBe(0);
    expect(computeEstimateAccuracy([task({ estimatedHours: undefined })]).sampleSize).toBe(0);
  });

  it('ignores a zero or negative tracked actual', () => {
    expect(computeEstimateAccuracy([task({ actualHours: 0 })]).sampleSize).toBe(0);
  });

  it('handles an empty or missing list', () => {
    expect(computeEstimateAccuracy([]).sampleSize).toBe(0);
    expect(computeEstimateAccuracy(undefined).ratio).toBeNull();
  });
});

describe('computeEstimateAccuracy — the ratio', () => {
  it('is actual over estimated, so above 1 means work runs long', () => {
    const out = computeEstimateAccuracy([task({ estimatedHours: 2, actualHours: 3 })]);
    expect(out.ratio).toBeCloseTo(1.5, 6);
  });

  it('is below 1 when work finishes faster than estimated', () => {
    expect(computeEstimateAccuracy([task({ estimatedHours: 4, actualHours: 2 })]).ratio).toBeCloseTo(0.5, 6);
  });

  it('aggregates hours rather than averaging per-task ratios', () => {
    /* The whole point. A 5-minute task that took 15 minutes is 10 minutes of
       evidence, not a 3.0x data point that swamps a well-estimated 10-hour
       task. Mean-of-ratios here would give (3.0 + 1.0) / 2 = 2.0. */
    const out = computeEstimateAccuracy([
      task({ estimatedHours: 5 / 60, actualHours: 15 / 60 }),
      task({ estimatedHours: 10, actualHours: 10 }),
    ]);
    expect(out.ratio).toBeCloseTo(10.25 / 10.083333, 3);
    expect(out.ratio).toBeLessThan(1.05);
  });

  it('reports the totals it derived the ratio from', () => {
    const out = computeEstimateAccuracy([task({ estimatedHours: 2, actualHours: 3 }), task({ estimatedHours: 1, actualHours: 1 })]);
    expect(out.totalEstimated).toBe(3);
    expect(out.totalActual).toBe(4);
    expect(out.sampleSize).toBe(2);
  });
});

describe('computeEstimateAccuracy — reliability', () => {
  it('is not reliable below the minimum sample', () => {
    const few = Array.from({ length: MIN_RELIABLE_SAMPLE - 1 }, () => task({ estimatedHours: 1, actualHours: 2 }));
    const out = computeEstimateAccuracy(few);
    // The ratio is still computed — the caller decides how to present it — but
    // it is flagged, because one long task should not read as a trend.
    expect(out.ratio).toBeCloseTo(2, 6);
    expect(out.isReliable).toBe(false);
  });

  it('becomes reliable at the minimum sample', () => {
    const enough = Array.from({ length: MIN_RELIABLE_SAMPLE }, () => task({ estimatedHours: 1, actualHours: 2 }));
    expect(computeEstimateAccuracy(enough).isReliable).toBe(true);
  });
});

describe('computeAccuracyByProject', () => {
  const projects = [
    { id: 'p1', name: 'Work' },
    { id: 'p2', name: 'Personal' },
  ];

  it('splits by project and names each one', () => {
    const rows = computeAccuracyByProject(
      [
        task({ projectId: 'p1', estimatedHours: 1, actualHours: 2 }),
        task({ projectId: 'p2', estimatedHours: 2, actualHours: 1 }),
      ],
      projects
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.projectId === 'p1').ratio).toBeCloseTo(2, 6);
    expect(rows.find((r) => r.projectId === 'p2').ratio).toBeCloseTo(0.5, 6);
  });

  it('groups tasks with no project under a readable label', () => {
    const rows = computeAccuracyByProject([task({ projectId: null })], projects);
    expect(rows[0].projectId).toBeNull();
    expect(rows[0].projectName).toBe('No project');
  });

  it('omits projects with nothing measurable', () => {
    const rows = computeAccuracyByProject([task({ projectId: 'p1' }), task({ projectId: 'p2', actualHours: undefined })], projects);
    expect(rows.map((r) => r.projectId)).toEqual(['p1']);
  });

  it('orders by sample size so the best-evidenced project leads', () => {
    const rows = computeAccuracyByProject(
      [
        task({ projectId: 'p2' }),
        task({ projectId: 'p1' }),
        task({ projectId: 'p1' }),
        task({ projectId: 'p1' }),
      ],
      projects
    );
    expect(rows[0].projectId).toBe('p1');
    expect(rows[0].sampleSize).toBe(3);
  });

  it('survives an unknown projectId rather than showing undefined', () => {
    const rows = computeAccuracyByProject([task({ projectId: 'deleted' })], projects);
    expect(rows[0].projectName).toBe('No project');
  });
});

describe('describeAccuracy', () => {
  it('has a dead band around parity, so near-perfect reads as correct', () => {
    // Without this, 1.03 reads as "you underestimate" — untrue, and the kind
    // of false precision that makes the whole panel untrustworthy.
    expect(describeAccuracy(1)).toBe('about right');
    expect(describeAccuracy(1.05)).toBe('about right');
    expect(describeAccuracy(0.95)).toBe('about right');
  });

  it('describes running long in multiples of the estimate', () => {
    expect(describeAccuracy(1.5)).toBe('1.5× longer');
  });

  it('inverts the ratio when work finishes early, so the number stays above 1', () => {
    // "0.7x" would make the reader work out whether that is good news.
    expect(describeAccuracy(0.5)).toBe('2.0× faster');
  });

  it('returns null when there is nothing to describe', () => {
    expect(describeAccuracy(null)).toBeNull();
    expect(describeAccuracy(undefined)).toBeNull();
  });
});

describe('accuracyHeadline', () => {
  it('reads as a sentence, unlike the table fragment', () => {
    // The bug this exists to prevent: "Your estimates are" + "1.1x longer
    // than estimated" repeats itself and reads as nonsense.
    expect(accuracyHeadline(1.5)).toBe('Work takes 1.5× longer than you estimate');
    expect(accuracyHeadline(0.5)).toBe('You finish 2.0× faster than you estimate');
    expect(accuracyHeadline(1)).toBe('Your estimates are about right');
  });

  it('returns null with no ratio', () => {
    expect(accuracyHeadline(null)).toBeNull();
  });
});
