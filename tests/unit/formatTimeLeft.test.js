import { describe, it, expect } from 'vitest';
import { formatTimeLeft } from '../../src/utils/formatHours';

describe('formatTimeLeft', () => {
  it('uses minutes under an hour and hours otherwise', () => {
    expect(formatTimeLeft(1 / 60, 5 / 60)).toBe('1min / 5min');
    expect(formatTimeLeft(0.5, 4)).toBe('30min / 4h');
    expect(formatTimeLeft(1, 3)).toBe('1h / 3h');
    expect(formatTimeLeft(1.5, 3)).toBe('1.5h / 3h');
  });

  it('shows nothing left as 0min', () => {
    expect(formatTimeLeft(0, 2)).toBe('0min / 2h');
  });
});
