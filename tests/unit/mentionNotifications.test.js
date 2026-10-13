import { describe, it, expect } from 'vitest';
import {
  buildMentionNotifications,
  buildSnippet,
  planInboxPrune,
  areMentionNotificationsEnabled,
  MAX_INBOX_ITEMS,
  MAX_RECIPIENTS_PER_COMMENT,
  MAX_SNIPPET_LENGTH,
  READ_RETENTION_DAYS,
  UNREAD_RETENTION_DAYS,
} from '../../src/utils/mentionNotifications';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13);

function base(overrides = {}) {
  return {
    comment: { id: 'c1', text: 'hi @[Bob](bob) and @[Cy](cy)', mentions: ['bob', 'cy'] },
    senderUid: 'amy',
    senderName: 'Amy',
    projectId: 'p1',
    taskId: 't1',
    taskTitle: 'Ship it',
    ...overrides,
  };
}

describe('buildSnippet', () => {
  it('renders mention tokens as @Name and collapses whitespace', () => {
    expect(buildSnippet('hey @[Bob](bob)\n\n  look')).toBe('hey @Bob look');
  });
  it('truncates to the snippet limit', () => {
    const out = buildSnippet('x'.repeat(500));
    expect(out.length).toBe(MAX_SNIPPET_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildMentionNotifications', () => {
  it('writes one doc per mentioned uid, keyed by the comment id', () => {
    const out = buildMentionNotifications(base());
    expect(out.map((n) => n.recipientUid)).toEqual(['bob', 'cy']);
    expect(out.every((n) => n.id === 'c1')).toBe(true);
    expect(out[0].data).toEqual({
      type: 'mention',
      senderUid: 'amy',
      senderName: 'Amy',
      projectId: 'p1',
      taskId: 't1',
      commentId: 'c1',
      taskTitle: 'Ship it',
      snippet: 'hi @Bob and @Cy',
      read: false,
    });
  });

  it('skips self-mentions and duplicates', () => {
    const out = buildMentionNotifications(base({ comment: { id: 'c1', text: '', mentions: ['amy', 'bob', 'bob'] } }));
    expect(out.map((n) => n.recipientUid)).toEqual(['bob']);
  });

  it('trusts the mentions array, not the body text', () => {
    const out = buildMentionNotifications(base({ comment: { id: 'c1', text: '@[Zed](zed)', mentions: ['bob'] } }));
    expect(out.map((n) => n.recipientUid)).toEqual(['bob']);
  });

  it('returns nothing without mentions or without a shared project/task', () => {
    expect(buildMentionNotifications(base({ comment: { id: 'c1', text: 'x' } }))).toEqual([]);
    expect(buildMentionNotifications(base({ projectId: undefined }))).toEqual([]);
    expect(buildMentionNotifications(base({ comment: { text: 'x', mentions: ['bob'] } }))).toEqual([]);
  });

  it('caps the recipient count', () => {
    const mentions = Array.from({ length: 50 }, (_, i) => `u${i}`);
    const out = buildMentionNotifications(base({ comment: { id: 'c1', text: '', mentions } }));
    expect(out).toHaveLength(MAX_RECIPIENTS_PER_COMMENT);
  });

  it('falls back to placeholders and respects size limits for name and title', () => {
    const out = buildMentionNotifications(base({ senderName: '', taskTitle: 'T'.repeat(500) }));
    expect(out[0].data.senderName).toBe('Someone');
    expect(out[0].data.taskTitle.length).toBe(200);
  });
});

describe('planInboxPrune', () => {
  const item = (id, ageDays, read) => ({ id, read, createdAtMs: NOW - ageDays * DAY });

  it('deletes read items past the read retention window only', () => {
    const ids = planInboxPrune([item('old-read', READ_RETENTION_DAYS + 1, true), item('new-read', READ_RETENTION_DAYS - 1, true)], NOW);
    expect(ids).toEqual(['old-read']);
  });

  it('keeps unread items longer than read ones, then deletes them', () => {
    const ids = planInboxPrune(
      [item('unread-60d', 60, false), item('unread-old', UNREAD_RETENTION_DAYS + 1, false)],
      NOW
    );
    expect(ids).toEqual(['unread-old']);
  });

  it('caps the inbox at the newest MAX_INBOX_ITEMS', () => {
    const items = Array.from({ length: MAX_INBOX_ITEMS + 5 }, (_, i) => item(`n${i}`, i * 0.01, false));
    const ids = planInboxPrune(items, NOW);
    expect(ids).toHaveLength(5);
    // The oldest (largest age) are the ones dropped.
    expect(ids).toEqual(expect.arrayContaining([`n${MAX_INBOX_ITEMS}`, `n${MAX_INBOX_ITEMS + 4}`]));
    expect(ids).not.toContain('n0');
  });

  it('never prunes an item whose server timestamp has not arrived yet', () => {
    expect(planInboxPrune([{ id: 'pending', read: true, createdAtMs: null }], NOW)).toEqual([]);
  });

  it('handles an empty or missing list', () => {
    expect(planInboxPrune([], NOW)).toEqual([]);
    expect(planInboxPrune(undefined, NOW)).toEqual([]);
  });
});

describe('areMentionNotificationsEnabled', () => {
  it('treats a missing key (settings saved before this existed) as enabled', () => {
    expect(areMentionNotificationsEnabled({ inAppEnabled: true })).toBe(true);
    expect(areMentionNotificationsEnabled(undefined)).toBe(true);
  });
  it('is off only when explicitly false', () => {
    expect(areMentionNotificationsEnabled({ mentions: false })).toBe(false);
    expect(areMentionNotificationsEnabled({ mentions: true })).toBe(true);
  });
});
