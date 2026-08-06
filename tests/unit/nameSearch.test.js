import { describe, it, expect } from 'vitest';
import { rankByNameSearch, scoreNameMatch, scoreNameMatchStrict } from '../../src/utils/nameSearch';

describe('scoreNameMatch / rankByNameSearch — shared name search', () => {
  function items(names) {
    return names.map((label, i) => ({ id: `p${i}`, label }));
  }

  it('empty query matches everything with score 0 and preserves original order', () => {
    expect(scoreNameMatch('', 'Anything')).toBe(0);
    const list = items(['Zebra', 'Apple', 'Mango']);
    expect(rankByNameSearch('', list)).toEqual(list);
    expect(rankByNameSearch('   ', list)).toEqual(list);
  });

  it('is case-insensitive', () => {
    expect(scoreNameMatch('WORK', 'work stuff')).toBe(0);
    expect(scoreNameMatch('work', 'WORK STUFF')).toBe(0);
  });

  it('ranks a prefix match above a substring match above a fuzzy match', () => {
    const list = items(['Homework', 'Work', 'Wrok Notes']); // "Homework" substring, "Work" prefix, "Wrok Notes" typo
    const ranked = rankByNameSearch('work', list);
    expect(ranked.map((i) => i.label)).toEqual(['Work', 'Homework', 'Wrok Notes']);
  });

  it('matches emoji-suffixed project names normally ("lists" finds "Lists 📄")', () => {
    const list = items(['Lists 📄', 'Tasks 📋', 'Personal']);
    const ranked = rankByNameSearch('lists', list);
    expect(ranked.map((i) => i.label)).toEqual(['Lists 📄']);

    const ranked2 = rankByNameSearch('tasks', list);
    expect(ranked2.map((i) => i.label)).toEqual(['Tasks 📋']);
  });

  it('returns no matches for a query that matches nothing, even fuzzily', () => {
    const list = items(['Alpha', 'Beta']);
    expect(rankByNameSearch('zzzzz', list)).toEqual([]);
  });

  it('tolerates a one-letter typo on a short word (fuzzy tier) but not on a very short query', () => {
    // "wrok" (one adjacent-transposition typo of "work") should still match "Work".
    expect(scoreNameMatch('wrok', 'Work')).not.toBeNull();
    expect(scoreNameMatch('wrok', 'Work')).toBeGreaterThanOrEqual(3);
    // A 1-2 char query is too short to fuzzy-match anything not already a prefix/substring.
    expect(scoreNameMatch('w', 'Zebra')).toBeNull();
    expect(scoreNameMatch('zx', 'Zebra')).toBeNull();
  });

  it('fuzzy tolerance scales with query length — a longer word tolerates a 2-edit typo that a short word would not', () => {
    // "restaraunt" vs "Restaurant" is edit-distance 2 (not a substring or
    // subsequence of it) — only matches because the query is long enough to
    // get the higher fuzzy threshold; a short query stays at distance-1 only
    // (see the "w"/"zx" case above, which fuzzy-matches nothing at all).
    expect(scoreNameMatch('restaraunt', 'Restaurant')).not.toBeNull();
    expect(scoreNameMatch('restaraunt', 'Restaurant')).toBeGreaterThanOrEqual(3);
  });

  it('a subsequence/initials-style query ranks below prefix/substring but can still match', () => {
    const list = items(['Assignments Backlog', 'Backend Auth']);
    const ranked = rankByNameSearch('ab', list);
    // "ab" is a subsequence of "Assignments Backlog" ("A"..."B"...) and not
    // a prefix/substring of either — just assert it's found, without pinning
    // down exact tier since fuzzy could also plausibly catch "Backend Auth".
    expect(ranked.map((i) => i.label)).toContain('Assignments Backlog');
  });

  it('preserves original relative order for equally-scored matches', () => {
    const list = items(['Work A', 'Work B', 'Work C']);
    const ranked = rankByNameSearch('work', list);
    expect(ranked.map((i) => i.label)).toEqual(['Work A', 'Work B', 'Work C']);
  });

  it('breaks ties using whatever order the caller pre-sorted items into (e.g. pinned/recency)', () => {
    // Simulates Sidebar/ManageProjectsModal passing in sortProjectsForSidebar's
    // output rather than raw creation order — two equal-tier prefix matches
    // should keep the pre-sorted (pinned-first) relative order, not their
    // original array order.
    const pinnedFirstOrder = items(['Work Zeta', 'Work Alpha']); // already reordered by the caller
    const ranked = rankByNameSearch('work', pinnedFirstOrder);
    expect(ranked.map((i) => i.label)).toEqual(['Work Zeta', 'Work Alpha']);
  });
});

describe('scoreNameMatchStrict — used for silent (non-visible-list) resolution', () => {
  it('matches prefix/substring/subsequence same as the full matcher', () => {
    expect(scoreNameMatchStrict('work', 'Work stuff')).toBe(0);
    expect(scoreNameMatchStrict('work', 'Homework')).toBe(1);
    expect(scoreNameMatchStrict('ab', 'Assignments Backlog')).toBe(2);
  });

  it('does NOT fuzzy-match a typo, unlike scoreNameMatch', () => {
    expect(scoreNameMatch('wrok', 'Work')).not.toBeNull(); // full matcher fuzzy-matches this
    expect(scoreNameMatchStrict('wrok', 'Work')).toBeNull(); // strict matcher does not
  });

  it('empty query matches everything, non-matching text returns null', () => {
    expect(scoreNameMatchStrict('', 'Anything')).toBe(0);
    expect(scoreNameMatchStrict('zzz', 'Work')).toBeNull();
  });
});
