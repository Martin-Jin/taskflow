import { describe, it, expect } from 'vitest';
import { getSignedLiveRemaining, getLiveRemaining, getSignedElapsedSeconds } from '../../src/context/TimerContext';

// A running timer started `startedAgoSeconds` ago, with `remainingSeconds`
// snapshotted at that start.
function runningTimer({ durationSeconds = 600, remainingSeconds = 600, startedAgoSeconds = 0 }) {
  return {
    durationSeconds,
    remainingSeconds,
    status: 'running',
    startedAt: Date.now() - startedAgoSeconds * 1000,
  };
}

function pausedTimer({ durationSeconds = 600, remainingSeconds }) {
  return { durationSeconds, remainingSeconds, status: 'paused', startedAt: null };
}

describe('getSignedLiveRemaining', () => {
  it('returns 0 for a missing timer', () => {
    expect(getSignedLiveRemaining(null)).toBe(0);
  });

  it('returns the snapshot directly for a paused timer, including a negative (overtime) snapshot', () => {
    expect(getSignedLiveRemaining(pausedTimer({ remainingSeconds: 120 }))).toBe(120);
    expect(getSignedLiveRemaining(pausedTimer({ remainingSeconds: -30 }))).toBe(-30);
  });

  it('subtracts elapsed wall-clock time from remainingSeconds for a running timer', () => {
    const timer = runningTimer({ remainingSeconds: 600, startedAgoSeconds: 100 });
    expect(getSignedLiveRemaining(timer)).toBeCloseTo(500, 0);
  });

  it('goes negative once a running timer runs past zero, instead of clamping', () => {
    const timer = runningTimer({ remainingSeconds: 60, startedAgoSeconds: 90 });
    expect(getSignedLiveRemaining(timer)).toBeCloseTo(-30, 0);
  });
});

describe('getLiveRemaining', () => {
  it('clamps overtime to 0 for display purposes', () => {
    const timer = runningTimer({ remainingSeconds: 60, startedAgoSeconds: 90 });
    expect(getLiveRemaining(timer)).toBe(0);
  });

  it('matches the signed value while time is still left', () => {
    const timer = runningTimer({ remainingSeconds: 600, startedAgoSeconds: 100 });
    expect(getLiveRemaining(timer)).toBeCloseTo(500, 0);
  });
});

describe('getSignedElapsedSeconds', () => {
  it('returns 0 for a missing timer', () => {
    expect(getSignedElapsedSeconds(null)).toBe(0);
  });

  it('equals durationSeconds - signed remaining, exceeding durationSeconds once in overtime', () => {
    const timer = runningTimer({ durationSeconds: 60, remainingSeconds: 60, startedAgoSeconds: 90 });
    // 30s past the original 60s duration.
    expect(getSignedElapsedSeconds(timer)).toBeCloseTo(90, 0);
  });

  it('reflects only time actually elapsed for a timer still within its duration', () => {
    const timer = runningTimer({ durationSeconds: 600, remainingSeconds: 600, startedAgoSeconds: 100 });
    expect(getSignedElapsedSeconds(timer)).toBeCloseTo(100, 0);
  });
});
