import { describe, it, expect } from 'vitest';
import { findDurationPhrase, extractDurationHours } from '../../src/utils/durationParser';
import { BASE_WORD_NUMBERS } from '../../src/utils/wordNumbers';

describe('findDurationPhrase', () => {
  it('parses "2 hours" as 2 hours', () => {
    // The optional approximation-marker prefix ends in "\s*", which greedily
    // absorbs the preceding whitespace into matchedText even with no marker
    // present — so matchedText includes the leading space.
    const result = findDurationPhrase('Design review 2 hours');
    expect(result).toEqual({ hours: 2, matchedText: ' 2 hours', index: 13 });
  });

  it('parses "90 minutes" converted to hours', () => {
    const result = findDurationPhrase('Cook dinner 90 minutes');
    expect(result).toEqual({ hours: 1.5, matchedText: ' 90 minutes', index: 11 });
  });

  it('parses "1.5h" (compact, no space) as 1.5 hours', () => {
    const result = findDurationPhrase('Write report 1.5h');
    expect(result).toEqual({ hours: 1.5, matchedText: ' 1.5h', index: 12 });
  });

  it('parses EU-style decimal comma ("1,5 hours") the same as a decimal point', () => {
    const result = findDurationPhrase('Write report 1,5 hours');
    expect(result.hours).toBe(1.5);
  });

  it('parses a simple fraction ("1/2 hour")', () => {
    const result = findDurationPhrase('Quick call 1/2 hour');
    expect(result.hours).toBe(0.5);
  });

  it('parses a combined "1h 30m" form as 1.5 hours', () => {
    const result = findDurationPhrase('Workshop 1h 30m');
    expect(result.hours).toBe(1.5);
  });

  it('parses a combined "1 hour 30 minutes" form the same way', () => {
    const result = findDurationPhrase('Workshop 1 hour 30 minutes');
    expect(result.hours).toBe(1.5);
  });

  it('parses "45m" (compact minutes) rounded to the nearest minute in hours', () => {
    const result = findDurationPhrase('Standup 45m');
    expect(result.hours).toBeCloseTo(0.75, 5);
  });

  it('parses "half an hour" as 0.5 hours', () => {
    const result = findDurationPhrase('Nap half an hour');
    expect(result.hours).toBe(0.5);
  });

  it('parses "an hour" as 1 hour', () => {
    const result = findDurationPhrase('Meeting an hour');
    expect(result.hours).toBe(1);
  });

  it('parses "a few hours" using word-number vocabulary', () => {
    const result = findDurationPhrase('Errands a few hours');
    expect(result.hours).toBe(3);
  });

  it('honors an "~" approximation marker prefix', () => {
    const result = findDurationPhrase('Call ~2 hours');
    expect(result.hours).toBe(2);
  });

  it('honors an "approx" marker prefix', () => {
    const result = findDurationPhrase('Call approx 2 hours');
    expect(result.hours).toBe(2);
  });

  it('honors an "est:" marker prefix without matching mid-word ("estimate" itself)', () => {
    const result = findDurationPhrase('Call est: 2 hours');
    expect(result.hours).toBe(2);
  });

  it('does not treat "est" inside an unrelated word as a marker ("testing 5 min")', () => {
    // The "est" marker requires a leading \b so it can't match mid-word; the
    // "5 min" duration itself should still be found correctly.
    const result = findDurationPhrase('testing 5 min');
    expect(result.hours).toBeCloseTo(5 / 60, 5);
    expect(result.matchedText).toBe(' 5 min');
  });

  it('ignores an unrelated number with no adjacent duration unit', () => {
    expect(findDurationPhrase('Buy 5 apples')).toBeNull();
  });

  it('does not match a decimal number immediately followed by a duration unit as a date ("3.5 hours")', () => {
    const result = findDurationPhrase('Task takes 3.5 hours');
    expect(result.hours).toBe(3.5);
  });

  it('returns null for text with no duration mention', () => {
    expect(findDurationPhrase('Buy milk and eggs')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(findDurationPhrase('')).toBeNull();
    expect(findDurationPhrase(null)).toBeNull();
    expect(findDurationPhrase(undefined)).toBeNull();
  });
});

describe('extractDurationHours', () => {
  it('returns just the numeric hours for a matching phrase', () => {
    expect(extractDurationHours('Task 2 hours')).toBe(2);
  });

  it('returns null when no duration phrase is found', () => {
    expect(extractDurationHours('No duration here')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(extractDurationHours('')).toBeNull();
    expect(extractDurationHours(null)).toBeNull();
  });
});

describe('BASE_WORD_NUMBERS (wordNumbers.js)', () => {
  it('maps single small word-numbers to their integer values', () => {
    expect(BASE_WORD_NUMBERS.one).toBe(1);
    expect(BASE_WORD_NUMBERS.two).toBe(2);
    expect(BASE_WORD_NUMBERS.three).toBe(3);
    expect(BASE_WORD_NUMBERS.ten).toBe(10);
  });

  it('maps "a"/"an" to 1', () => {
    expect(BASE_WORD_NUMBERS.a).toBe(1);
    expect(BASE_WORD_NUMBERS.an).toBe(1);
  });

  it('maps "few" and its multi-word "a few" form to 3', () => {
    expect(BASE_WORD_NUMBERS.few).toBe(3);
    expect(BASE_WORD_NUMBERS['a few']).toBe(3);
  });

  it('no longer recognizes "couple" — removed for being too easily confused with real words like "course"', () => {
    expect(BASE_WORD_NUMBERS.couple).toBeUndefined();
    expect(BASE_WORD_NUMBERS['a couple']).toBeUndefined();
  });

  it('does not support numbers beyond ten or compound forms like "twenty-one"', () => {
    // This vocabulary is deliberately small (see its doc comment) — it does
    // not attempt full English number-word parsing.
    expect(BASE_WORD_NUMBERS['twenty-one']).toBeUndefined();
    expect(BASE_WORD_NUMBERS.eleven).toBeUndefined();
  });
});
