/**
 * useMentionAutocomplete — live "@label" / "#project[/section]" popup while
 * typing into SmartTitleInput, on top of (not instead of) the existing
 * after-the-fact chip detection in smartParse.js (which only reports a
 * detection once a phrase already fully resolves). This hook instead
 * watches the caret position on every keystroke/click to find whether it
 * currently sits right at the end of an *in-progress*, unterminated
 * trigger span — one that hasn't yet been closed by whitespace, or, for
 * "#project/section", one whose section half is still being typed after a
 * confirmed "/" — and if so exposes a filtered candidate list plus the
 * keyboard/selection plumbing needed to splice a choice into the text.
 *
 * Deliberately reuses the same ranked/typo-tolerant matcher as every other
 * project-name search in the app (nameSearch.js's rankByNameSearch, see that
 * file) rather than requiring an exact/ambiguous match — an autocomplete
 * list is expected to show several loose candidates as the user narrows
 * them down, unlike the single confident-or-null resolution the chip
 * detector needs once typing is done. The one exception is resolving which
 * project a "#project/section" mention's section-half belongs to (see
 * `resolveProjectStrict` below) — that's a silent lookup, not a visible list
 * the user picks from, so it deliberately stays strict (no fuzzy typo
 * tolerance) to avoid quietly resolving to the wrong project mid-typing.
 *
 * Shares its caret-watching and splice-and-reposition-caret boilerplate with
 * useSmartKeywordSuggest via useCaretActiveSpan.js.
 */

import { useState } from 'react';
import { useEscapeLayer } from './useEscapeLayer';
import { useCaretActiveSpan, spliceTextAndMoveCaret } from './useCaretActiveSpan';
import { rankByNameSearch, scoreNameMatchStrict } from '../utils/nameSearch';

const MAX_SUGGESTIONS = 8;

/** Ranked/typo-tolerant filter for a visible suggestion dropdown (labels/projects/sections). */
function fuzzyFilter(query, items, getName) {
  return rankByNameSearch(query, items.map((item) => ({ ...item, label: getName(item) }))).slice(0, MAX_SUGGESTIONS);
}

/**
 * Resolves which project a "#project/section" mention's already-typed
 * project half refers to — an exact name match first, then the best strict
 * (prefix/substring/subsequence, no fuzzy) match. Silent/automatic rather
 * than a list the user picks from, so a fuzzy typo-match here could
 * surprise-resolve to the wrong project mid-typing — see this file's doc
 * comment.
 */
function resolveProjectStrict(projectQuery, projects) {
  const q = projectQuery.trim().toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact;
  const ranked = projects
    .map((p) => ({ project: p, score: scoreNameMatchStrict(projectQuery, p.name) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.project ?? null;
}

/**
 * Find the active trigger span ending at `caret`, or null if the caret
 * isn't currently inside one. Scans backward from the caret for the most
 * recent "@", "#" or "%" — whichever is closer wins, since a title can
 * contain more than one kind of mention.
 */
function findActiveSpan(text, caret) {
  const upToCaret = text.slice(0, caret);
  const lastAt = upToCaret.lastIndexOf('@');
  const lastHash = upToCaret.lastIndexOf('#');
  const lastPercent = upToCaret.lastIndexOf('%');

  if (lastHash !== -1 && lastHash >= lastAt && lastHash >= lastPercent) {
    const afterHash = upToCaret.slice(lastHash + 1);
    const slashIndex = afterHash.indexOf('/');
    if (slashIndex === -1) {
      // Still typing the project name itself — a bare space here means
      // this "#word" was already finished as its own token (e.g. "#Tasks
      // tomorrow"), not a mention still being composed.
      if (/\s/.test(afterHash)) return null;
      return { trigger: '#', start: lastHash, projectQuery: afterHash, sectionQuery: null };
    }
    const projectQuery = afterHash.slice(0, slashIndex).trim();
    const sectionQuery = afterHash.slice(slashIndex + 1).replace(/^\s+/, '');
    // A newline or another trigger char inside the section half means
    // we've drifted past this mention entirely.
    if (/[\n@#]/.test(sectionQuery)) return null;
    return { trigger: '#', start: lastHash, projectQuery, sectionQuery };
  }

  if (lastAt !== -1 && lastAt >= lastPercent) {
    const afterAt = upToCaret.slice(lastAt + 1);
    if (/\s/.test(afterAt)) return null;
    return { trigger: '@', start: lastAt, query: afterAt };
  }

  if (lastPercent !== -1) {
    const afterPercent = upToCaret.slice(lastPercent + 1);
    // Same "a bare space finishes the token" rule as "#" above — the
    // "%section" shorthand (see findSectionShorthandPhrase in smartParse.js)
    // has no "/" continuation to worry about, so this is simpler than "#".
    if (/\s/.test(afterPercent)) return null;
    return { trigger: '%', start: lastPercent, query: afterPercent };
  }

  return null;
}

export function useMentionAutocomplete({ inputRef, value, onChange, projects = [], sections = [], labels = [] }) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [span, setSpan, refresh, dismiss] = useCaretActiveSpan(inputRef, value, findActiveSpan, () => setHighlightedIndex(0));

  let mode = null; // 'label' | 'project' | 'section' | 'sectionShorthand'
  let matches = [];
  let query = '';
  if (span?.trigger === '@') {
    mode = 'label';
    query = span.query;
    matches = fuzzyFilter(query, labels, (l) => l.name);
  } else if (span?.trigger === '#' && span.sectionQuery == null) {
    mode = 'project';
    query = span.projectQuery;
    matches = fuzzyFilter(query, projects, (p) => p.name);
  } else if (span?.trigger === '#' && span.sectionQuery != null) {
    mode = 'section';
    query = span.sectionQuery;
    const project = resolveProjectStrict(span.projectQuery, projects);
    const projectSections = project ? sections.filter((s) => s.projectId === project.id) : [];
    matches = fuzzyFilter(query, projectSections, (s) => s.name);
  } else if (span?.trigger === '%') {
    // "%section" shorthand — searches every section across every project,
    // same "no project context yet" scope as findSectionShorthandPhrase in
    // smartParse.js. Duplicate section names across projects are kept
    // distinct here (fuzzyFilter/rankByNameSearch dedupes by id, not name),
    // so the dropdown can offer either one to disambiguate.
    mode = 'sectionShorthand';
    query = span.query;
    matches = fuzzyFilter(query, sections, (s) => s.name);
  }

  // Labels can always be created on the fly — offer that as a trailing
  // pseudo-row whenever the typed name isn't already an exact match, same
  // "create on the fly" affordance LabelPicker already gives.
  const showCreateOption = mode === 'label' && query.trim().length > 0 && !labels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase());

  const isOpen = !!span && (matches.length > 0 || showCreateOption);

  // Escape dismisses this popup, and only this popup. It goes through the
  // shared layer stack because the title field usually sits inside a modal,
  // and a plain keydown branch here never fired — one Escape with the
  // suggestion list open discarded the whole draft instead (see
  // src/hooks/useEscapeLayer.js).
  useEscapeLayer(isOpen, dismiss);

  /** Splice `insertText` in place of the active trigger span, then move the caret right after it. */
  function selectMatch(insertText) {
    if (!span) return;
    const el = inputRef.current;
    const caret = el ? el.selectionStart : value.length;
    const needsTrailingSpace = !/^\s/.test(value.slice(caret));
    dismiss();
    spliceTextAndMoveCaret({
      inputRef,
      value,
      onChange,
      start: span.start,
      end: caret,
      replacement: `${insertText}${needsTrailingSpace ? ' ' : ''}`,
    });
  }

  /** Select row `index` — either a candidate (< matches.length) or the trailing "Create" pseudo-row. */
  function selectByIndex(index) {
    if (index >= matches.length) {
      if (showCreateOption) selectMatch(`@${query.trim()}`);
      return;
    }
    const chosen = matches[index];
    if (!chosen) return;
    if (mode === 'label') selectMatch(`@${chosen.name}`);
    else if (mode === 'project') selectMatch(`#${chosen.name}`);
    else if (mode === 'section') selectMatch(`#${span.projectQuery.trim()}/${chosen.name}`);
    else if (mode === 'sectionShorthand') selectMatch(`%${chosen.name}`);
  }

  /** Returns true if it handled the key (caller should preventDefault/stop). */
  function handleKeyDown(e) {
    if (!isOpen) return false;
    const rowCount = matches.length + (showCreateOption ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, Math.max(rowCount - 1, 0)));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    // Escape is claimed by the escape layer registered above, so a keydown
    // on the input never sees it (see useEscapeLayer).
    if (e.key === 'Tab') {
      // Cycles the highlight instead of accepting — matches
      // useSmartKeywordSuggest's Tab-cycles/Enter-accepts split, so the two
      // autocomplete popups in this same title field behave consistently.
      // Shift+Tab cycles backward; wraps in both directions.
      e.preventDefault();
      const direction = e.shiftKey ? -1 : 1;
      setHighlightedIndex((i) => (i + direction + rowCount) % rowCount);
      return true;
    }
    if (e.key === 'Enter') {
      if (highlightedIndex >= rowCount) return false;
      e.preventDefault();
      selectByIndex(highlightedIndex);
      return true;
    }
    return false;
  }

  return {
    isOpen,
    mode,
    query,
    matches,
    showCreateOption,
    highlightedIndex,
    setHighlightedIndex,
    spanStart: span?.start ?? null,
    selectByIndex,
    handleKeyDown,
    refresh,
    dismiss,
  };
}
