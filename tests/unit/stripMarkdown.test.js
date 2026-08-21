/**
 * Unit tests for src/utils/stripMarkdown.js — the collapsed note-tile
 * preview relies on this turning markdown syntax into clean prose rather
 * than showing raw "## " / "**" / "- [ ] " characters.
 */

import { describe, expect, it } from 'vitest';
import { stripMarkdown } from '../../src/utils/stripMarkdown';

describe('stripMarkdown', () => {
  it('strips a heading marker', () => {
    expect(stripMarkdown('## Groceries')).toBe('Groceries');
  });

  it('strips bold and italic markers', () => {
    expect(stripMarkdown('**bold** and _italic_ and *also italic*')).toBe('bold and italic and also italic');
  });

  it('strips strikethrough markers', () => {
    expect(stripMarkdown('~~done~~ not done')).toBe('done not done');
  });

  it('strips a task-list checkbox and its list marker', () => {
    expect(stripMarkdown('- [ ] milk\n- [x] eggs')).toBe('milk\neggs');
  });

  it('strips bullet and ordered list markers', () => {
    expect(stripMarkdown('- one\n* two\n1. three')).toBe('one\ntwo\nthree');
  });

  it('reduces a link to its link text', () => {
    expect(stripMarkdown('see [the docs](https://example.com) for more')).toBe('see the docs for more');
  });

  it('reduces an image to its alt text', () => {
    expect(stripMarkdown('![a photo](https://example.com/x.png)')).toBe('a photo');
  });

  it('strips inline code and fenced code blocks', () => {
    expect(stripMarkdown('run `npm install`')).toBe('run npm install');
    expect(stripMarkdown('```\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> a quoted line')).toBe('a quoted line');
  });

  it('strips a horizontal rule line', () => {
    expect(stripMarkdown('above\n---\nbelow')).toBe('above\n\nbelow');
  });

  it('leaves plain text untouched', () => {
    expect(stripMarkdown('just a plain sentence.')).toBe('just a plain sentence.');
  });

  it('returns an empty string for empty/nullish input', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
  });
});
