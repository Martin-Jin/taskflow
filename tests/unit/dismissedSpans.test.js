import { describe, it, expect } from 'vitest';
import { shiftSpans, maskSpans, findLiveIndex, removeRanges } from '../../src/utils/dismissedSpans';
import { parseTaskText } from '../../src/utils/smartParse';

const friday = [{ start: 16, end: 22, text: 'friday' }];
const title = 'Change time for friday';

describe('dismissedSpans', () => {
  it('keeps a cancelled span when a space and a new word are typed after it', () => {
    let spans = shiftSpans(friday, title, title + ' ');
    expect(spans).toEqual(friday);
    spans = shiftSpans(spans, title + ' ', title + ' monday');
    expect(spans).toEqual(friday);
  });

  it('shifts a span when text is inserted before it', () => {
    expect(shiftSpans(friday, title, 'X' + title)).toEqual([{ start: 17, end: 23, text: 'friday' }]);
  });

  it('drops the span once the cancelled text is edited (second backspace)', () => {
    expect(shiftSpans(friday, title, 'Change time for frida')).toEqual([]);
  });

  it('drops the span when word characters are glued onto it', () => {
    expect(shiftSpans(friday, title, title + 's')).toEqual([]);
  });

  it('masks only the cancelled occurrence', () => {
    expect(maskSpans(title + ' friday', friday)).toBe('Change time for ______ friday');
    expect(findLiveIndex(title + ' friday', 'friday', friday)).toBe(23);
  });

  it('lets the parser reach a second date after the first is cancelled', () => {
    const text = 'Change time for friday monday';
    const masked = maskSpans(text, friday);
    expect(parseTaskText(text).detected.dueDate.matchedText.toLowerCase()).toBe('friday');
    expect(parseTaskText(masked).detected.dueDate.matchedText.toLowerCase()).toBe('monday');
  });

  it('removes ranges from the right places', () => {
    expect(removeRanges('friday friday', [{ start: 7, end: 13 }])).toBe('friday');
  });
});
