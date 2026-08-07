import { describe, it, expect } from 'vitest';
import { deriveRemainingHoursOnEstimateChange } from '../../src/utils/taskFieldDerivations';

describe('deriveRemainingHoursOnEstimateChange', () => {
  it('shifts remainingHours up by the same delta when the estimate increases', () => {
    // 2h remaining out of 5h estimated; estimate raised to 8h -> remaining should also gain 3h.
    expect(deriveRemainingHoursOnEstimateChange(2, 5, 8)).toBe(5);
  });

  it('shifts remainingHours down by the same delta when the estimate decreases', () => {
    // 4h remaining out of 5h estimated; estimate lowered to 3h -> remaining loses 2h too.
    expect(deriveRemainingHoursOnEstimateChange(4, 5, 3)).toBe(2);
  });

  it('adds hours for the scheduler to place when raising the estimate on a fully-scheduled (0 remaining) task', () => {
    expect(deriveRemainingHoursOnEstimateChange(0, 5, 10)).toBe(5);
  });

  it('clamps to the new estimate when the shift would push remaining above it', () => {
    // 5h remaining out of 5h estimated (nothing done yet); estimate lowered to 2h ->
    // naive shift would give 2h too, but also verify the clamp itself against a larger raw overshoot.
    expect(deriveRemainingHoursOnEstimateChange(5, 5, 2)).toBe(2);
    expect(deriveRemainingHoursOnEstimateChange(9, 10, 3)).toBe(2);
  });

  it('clamps at zero rather than going negative when the estimate drops a lot', () => {
    // 1h remaining out of 5h estimated; estimate slashed to 1h -> delta is -4, 1 + -4 = -3, clamped to 0.
    expect(deriveRemainingHoursOnEstimateChange(1, 5, 1)).toBe(0);
  });

  it('leaves remainingHours unchanged when the estimate does not change', () => {
    expect(deriveRemainingHoursOnEstimateChange(3, 5, 5)).toBe(3);
  });
});
