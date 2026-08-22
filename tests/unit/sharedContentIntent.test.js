/**
 * Coverage for parseSharedContentIntent — the pure half of
 * useSharedContentIntent, which maps the query string the app was LAUNCHED
 * with (PWA share target, or a home-screen shortcut) onto "open this modal,
 * prefilled".
 *
 * Worth unit testing rather than only clicking through: the inputs come from
 * other apps' share sheets, which fill title/text/url inconsistently and
 * can't be reproduced in a browser test. Android alone gives at least four
 * shapes — title+url from a browser tab, text only from a notes app, the URL
 * inside `text` with no `url` field, and the same URL duplicated across both.
 */

import { describe, it, expect } from 'vitest';
import { parseSharedContentIntent } from '../../src/hooks/useSharedContentIntent';

describe('parseSharedContentIntent — app shortcuts', () => {
  it('opens the note editor for ?add=note', () => {
    expect(parseSharedContentIntent('?add=note')).toEqual({ kind: 'note' });
  });

  it('opens an empty Add Task for ?add=task', () => {
    expect(parseSharedContentIntent('?add=task')).toEqual({ kind: 'task', title: '', notes: '' });
  });

  it('takes precedence over any share payload in the same URL', () => {
    // An explicit shortcut is unambiguous; a stray param shouldn't redirect it.
    expect(parseSharedContentIntent('?add=note&title=ignored')).toEqual({ kind: 'note' });
  });

  it('ignores an unrecognised ?add value rather than guessing', () => {
    expect(parseSharedContentIntent('?add=banana')).toBeNull();
  });
});

describe('parseSharedContentIntent — nothing to act on', () => {
  it('returns null for a plain launch', () => {
    expect(parseSharedContentIntent('')).toBeNull();
    expect(parseSharedContentIntent('?')).toBeNull();
  });

  it('returns null when the share params are present but empty', () => {
    expect(parseSharedContentIntent('?title=&text=&url=')).toBeNull();
  });

  it('returns null for whitespace-only shared content', () => {
    expect(parseSharedContentIntent('?title=%20%20&text=%0A')).toBeNull();
  });
});

describe('parseSharedContentIntent — share target payloads', () => {
  it('uses a real title as the title', () => {
    expect(parseSharedContentIntent('?title=Call+dentist')).toEqual({
      kind: 'task',
      title: 'Call dentist',
      notes: '',
    });
  });

  it('appends a shared url to the title, so smart-parse lifts it into `link`', () => {
    const intent = parseSharedContentIntent('?title=Read+this&url=https%3A%2F%2Fexample.com%2Fa');
    expect(intent).toEqual({ kind: 'task', title: 'Read this https://example.com/a', notes: '' });
  });

  it('does not duplicate a url that is already in the title', () => {
    const intent = parseSharedContentIntent(
      '?title=https%3A%2F%2Fexample.com%2Fa&url=https%3A%2F%2Fexample.com%2Fa'
    );
    expect(intent.title).toBe('https://example.com/a');
  });

  it('does not duplicate a url that is already in the shared text', () => {
    // Very common: apps put the same link in both `text` and `url`.
    const intent = parseSharedContentIntent(
      '?text=Look%20at%20https%3A%2F%2Fexample.com%2Fa&url=https%3A%2F%2Fexample.com%2Fa'
    );
    expect(intent.title).toBe('Look at https://example.com/a');
    expect(intent.notes).toBe('');
  });

  it('falls back to the text when there is no title', () => {
    expect(parseSharedContentIntent('?text=Buy+milk+tomorrow')).toEqual({
      kind: 'task',
      title: 'Buy milk tomorrow',
      notes: '',
    });
  });

  it('splits multi-line text into a title plus notes', () => {
    const intent = parseSharedContentIntent('?text=Fix+the+sink%0Acall+the+plumber%0Abring+cash');
    expect(intent.title).toBe('Fix the sink');
    expect(intent.notes).toBe('call the plumber\nbring cash');
  });

  it('keeps the shared text as notes when a title was also given', () => {
    const intent = parseSharedContentIntent('?title=Article&text=some+body+text');
    expect(intent).toEqual({ kind: 'task', title: 'Article', notes: 'some body text' });
  });

  it('puts a long single blob entirely in notes rather than making it the title', () => {
    // A shared paragraph makes a terrible task title; better to leave the
    // title empty and let the user name it.
    const long = 'x'.repeat(200);
    const intent = parseSharedContentIntent(`?text=${long}`);
    expect(intent.title).toBe('');
    expect(intent.notes).toBe(long);
  });

  it('handles a url-only share', () => {
    const intent = parseSharedContentIntent('?url=https%3A%2F%2Fexample.com%2Fa');
    expect(intent).toEqual({ kind: 'task', title: 'https://example.com/a', notes: '' });
  });

  it('preserves the natural-language phrasing smart-parse depends on', () => {
    // The whole point of routing shared text through the title field is that
    // it gets parsed like typed input — so the phrasing must survive intact.
    const intent = parseSharedContentIntent('?title=Call+dentist+tomorrow+p2+every+month');
    expect(intent.title).toBe('Call dentist tomorrow p2 every month');
  });
});
