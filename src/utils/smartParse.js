/**
 * ============================================================================
 * SMART PARSE
 * ============================================================================
 * Todoist-style inline detection of due date / recurrence / priority /
 * dependency / project / label mentions typed directly into a task's Title
 * field, e.g. "Call dentist tomorrow p2 every month after Book appointment
 * #Health @errand".
 *
 * Composes the existing hand-rolled parsers (findDuePhrase from
 * dateParse.js, findRecurrencePhrase from recurrence.js) plus detectors
 * kept local here since they have no other call site: a plain URL (reusing
 * utils/linkify.js's regex, becomes the task's `link` field), priority
 * (Todoist's own p1-p4 shorthand only — no "urgent"/"!!" keyword matching),
 * dependency mentions ("after <task>" / "depends on <task>"), a "#project"
 * mention (fuzzy-matched against existing Projects, same idea as
 * dependency) optionally followed by "/ section" (Todoist's own
 * #Project/Section syntax, fuzzy-matched against that project's Sections),
 * and "@label" mentions (one or more — unlike the other detectors these
 * don't need to resolve against anything that already exists, since a new
 * tag is just created on save).
 *
 * Detection runs in sequence — link, due date, recurrence, priority,
 * duration, "can run unattended", "on the day"/enforce due date, dependency,
 * project, then labels — stripping each match out of the working text
 * before the next detector runs. This keeps the dependency fragment (which
 * captures "everything after the trigger word", up to the next "@"/"#" or
 * the end of the string) free of unrelated phrases typed after it, e.g.
 * "after Design review tomorrow p2" leaves a clean "Design review" fragment
 * to match against existing task titles once "tomorrow" and "p2" have
 * already been pulled out — and the same "@"/"#" boundary means a trailing
 * "#project"/"@label" mention (e.g. "after Design review #Writing") is left
 * alone for the detectors that run after it, rather than being swallowed
 * into the dependency match. Labels run last so "@name" mentions aren't
 * accidentally swallowed by an earlier detector's fragment capture.
 * ============================================================================
 */

import { findDuePhrase, findFixedTimePhrase } from './dateParse';
import { findRecurrencePhrase, WEEKDAY_LABELS } from './recurrence';
import { findDurationPhrase } from './durationParser';
import { URL_PATTERN_SOURCE, needsScheme } from './linkify';

const PRIORITY_LEVELS = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

function removeMatch(text, matchedText) {
  if (!matchedText) return text;
  const idx = text.toLowerCase().indexOf(matchedText.toLowerCase());
  if (idx === -1) return text;
  return (text.slice(0, idx) + text.slice(idx + matchedText.length)).replace(/\s{2,}/g, ' ').trim();
}

/** Exported so callers can strip an individually-accepted match out of a title at save time. */
export { removeMatch as stripMatchedText };

// Reuses utils/linkify.js's URL pattern (used to render links inside notes
// text) so the two can't silently drift apart. The non-global regex keeps the
// single-match title detector simple; the global variant is used for the
// notes-field multi-link detector below.
const LINK_REGEX = new RegExp(URL_PATTERN_SOURCE, 'i');
const LINK_REGEX_GLOBAL = new RegExp(URL_PATTERN_SOURCE, 'gi');

/** Return every URL-like phrase found in text, preserving their indexes. */
export function findLinkPhrases(text) {
  if (!text || !text.trim()) return [];
  const matches = [];
  LINK_REGEX_GLOBAL.lastIndex = 0;
  let m;
  while ((m = LINK_REGEX_GLOBAL.exec(text)) !== null) {
    const matchedText = m[0];
    const url = needsScheme(matchedText) ? `https://${matchedText}` : matchedText;
    matches.push({ url, matchedText, index: m.index });
  }
  LINK_REGEX_GLOBAL.lastIndex = 0;
  return matches;
}

/** A plain URL typed into the title — becomes the task's `link` field, stripped out of the displayed title. */
function findLinkPhrase(text) {
  const m = text.match(LINK_REGEX);
  if (!m) return null;
  const matchedText = m[0];
  const url = needsScheme(matchedText) ? `https://${matchedText}` : matchedText;
  return { url, matchedText, index: m.index };
}

function findPriorityPhrase(text) {
  const m = text.match(/\bp([1-4])\b/i);
  if (!m) return null;
  return { level: PRIORITY_LEVELS[m[1]], matchedText: m[0], index: m.index };
}

/** Bare "unattended" mention — no symbol needed, matches useSmartTaskTitle's isPassive field. */
function findUnattendedPhrase(text) {
  const m = text.match(/\bunattended\b/i);
  if (!m) return null;
  return { matchedText: m[0], index: m.index };
}

/**
 * A handful of plain-English ways to say "this must happen ON the due date,
 * not early" — matches the allocator's `enforceDueDate` flag (see
 * allocator.js: it collapses the whole scheduling window onto the due date
 * itself instead of allowing earlier placement).
 */
function findEnforceDueDatePhrase(text) {
  const m = text.match(/\b(?:on (?:the|that) day|hard deadline|strict(?:ly)? due|no earlier)\b/i);
  if (!m) return null;
  return { matchedText: m[0], index: m.index };
}

/**
 * Fuzzy-match a captured fragment against a list of named candidates
 * (existing tasks for "after/depends on <fragment>", Projects for
 * "#fragment"). An exact (case-insensitive) match wins outright; otherwise
 * a substring match — either direction, so a short fragment can match a
 * longer name and vice versa — is accepted only if exactly one candidate
 * qualifies. An absent or ambiguous match returns null so the caller can
 * show a neutral "no match" hint instead of guessing. Single-pass so
 * scanning the same candidate list repeatedly (once per keystroke, via
 * parseTaskText) doesn't cost two full array scans.
 */
function matchFragmentAgainstCandidates(fragment, candidates, getName) {
  const f = fragment.trim().toLowerCase();
  if (!f) return null;

  let exactMatch = null;
  let exactCount = 0;
  let partialMatch = null;
  let partialCount = 0;

  for (const candidate of candidates) {
    const name = getName(candidate).trim().toLowerCase();
    if (name === f) {
      exactMatch = candidate;
      exactCount += 1;
    } else if (name.length > 0 && (name.includes(f) || f.includes(name))) {
      partialMatch = candidate;
      partialCount += 1;
    }
  }

  if (exactCount === 1) return exactMatch;
  if (partialCount === 1) return partialMatch;
  return null; // no confident match, or ambiguous (multiple candidates)
}

function findDependencyPhrase(text, existingTasks) {
  // Bounded at the next "@"/"#" (or end of string) rather than swallowing to
  // the literal end of the text — otherwise a "#project"/"@label" mention
  // typed *after* the dependency phrase (e.g. "after Design review #Writing")
  // gets folded into the dependency fragment and never reaches the project/
  // label detectors that run later in parseTaskText.
  const m = text.match(/\b(?:after|depends on)\s+([^@#]+?)(?=\s*[@#]|$)/i);
  if (!m || !m[1].trim()) return null;
  const fragment = m[1].trim();
  const task = matchFragmentAgainstCandidates(fragment, existingTasks, (t) => t.title);
  return { task, fragment, matchedText: m[0], index: m.index };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "#project" shorthand, optionally followed by "/ section" — Todoist's own
 * "#Project/Section" syntax, tolerant of spaces around the slash ("#Tasks /
 * section one"). The section fragment, once a "/" is typed, can contain
 * spaces, running until the next "@"/"#" token or the end of the string.
 *
 * The project fragment itself first tries every existing project's FULL
 * name (longest name first) as a literal, word-bounded prefix of whatever
 * follows "#" — this is what lets multi-word project names ("Work Trip")
 * resolve correctly instead of always stopping at the first word, and is
 * essential for two projects that share a leading word ("Work" / "Work
 * Trip"): trying the longest name first means "#Work Trip" resolves to
 * "Work Trip" rather than silently matching the shorter "Work" and leaving
 * "Trip" behind as stray title text (see useMentionAutocomplete, which
 * inserts a selected project's full name this way). Only when no project's
 * full name is spelled out does this fall back to the original single fuzzy
 * word (matchFragmentAgainstCandidates) — so a typo or abbreviation like
 * "#Groc" for "Groceries List" still resolves via substring match.
 */
function findProjectPhrase(text, projects, sections) {
  const hashMatch = text.match(/#([^@#]*)/);
  if (!hashMatch) return null;
  const tail = hashMatch[1];
  if (!tail.trim()) return null;
  const hashIndex = hashMatch.index;

  const byNameLengthDesc = [...projects].sort((a, b) => b.name.length - a.name.length);
  for (const project of byNameLengthDesc) {
    const name = project.name.trim();
    if (!name) continue;
    const prefixMatch = tail.match(new RegExp(`^${escapeRegExp(name)}(?=\\s|/|$)`, 'i'));
    if (!prefixMatch) continue;

    const consumed = prefixMatch[0];
    const rest = tail.slice(consumed.length);
    const slashLead = rest.match(/^\s*\/\s*/);
    let sectionFragment;
    let section = null;
    let matchedTail = consumed;
    if (slashLead) {
      const afterSlash = rest.slice(slashLead[0].length);
      // Same longest-full-name-first approach as the project match above —
      // stop at the end of whichever known section name is actually spelled
      // out, rather than swallowing every character up to the next "@"/"#"/
      // end of string. Without this bound, once a section resolves, any
      // further words typed on the same line (a new sentence, another
      // "#project" mention with no "@"/"#" yet before it, etc.) kept getting
      // folded into the match and highlighted/stripped as if they were still
      // part of the section name.
      const projectSections = sections.filter((s) => s.projectId === project.id);
      const sectionsByNameLengthDesc = [...projectSections].sort((a, b) => b.name.length - a.name.length);
      let sectionConsumed = null;
      for (const candidate of sectionsByNameLengthDesc) {
        const candidateName = candidate.name.trim();
        if (!candidateName) continue;
        const sectionPrefixMatch = afterSlash.match(new RegExp(`^${escapeRegExp(candidateName)}(?=\\s|$)`, 'i'));
        if (sectionPrefixMatch) {
          sectionConsumed = sectionPrefixMatch[0];
          section = candidate;
          break;
        }
      }
      if (sectionConsumed !== null) {
        sectionFragment = sectionConsumed.trim() || undefined;
        matchedTail = consumed + slashLead[0] + sectionConsumed;
      } else {
        // No known section name is fully spelled out yet — fall back to a
        // single fuzzy-matchable word (mirrors the project fallback below)
        // instead of the unbounded rest-of-string capture.
        const wordFallback = afterSlash.match(/^[^\s@#]*/);
        sectionFragment = wordFallback[0].trim() || undefined;
        matchedTail = consumed + slashLead[0] + wordFallback[0];
        if (sectionFragment) {
          section = matchFragmentAgainstCandidates(sectionFragment, projectSections, (s) => s.name);
        }
      }
    }
    return { project, section, fragment: name, sectionFragment, matchedText: `#${matchedTail}`, index: hashIndex };
  }

  const wordMatch = text.match(/#([a-zA-Z0-9_-]+)(?:\s*\/\s*([^@#]+?)(?=\s*[@#]|$))?/);
  if (!wordMatch) return null;
  const fragment = wordMatch[1];
  const project = matchFragmentAgainstCandidates(fragment, projects, (p) => p.name);
  const sectionFragment = wordMatch[2] ? wordMatch[2].trim() : undefined;
  let section = null;
  if (sectionFragment && project) {
    const projectSections = sections.filter((s) => s.projectId === project.id);
    section = matchFragmentAgainstCandidates(sectionFragment, projectSections, (s) => s.name);
  }
  return { project, section, fragment, sectionFragment, matchedText: wordMatch[0], index: wordMatch.index };
}

/**
 * "@label" shorthand — every occurrence in the text, not just the first,
 * since a task can carry several tags at once. Unlike project/dependency
 * matching, a label with no existing match isn't a dead end: it's simply a
 * brand new tag, created on save (see SchedulerContext.getOrCreateLabelIds).
 */
function findLabelPhrases(text) {
  return [...text.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => ({ name: m[1], matchedText: m[0], index: m.index }));
}

/**
 * Parse a task title's free text for due date / recurrence / priority /
 * dependency mentions.
 *
 * @param {string} text
 * @param {{existingTasks?: Array<{id: string, title: string}>, projects?: Array<{id: string, name: string}>, sections?: Array<{id: string, name: string, projectId: string}>}} [options]
 * @returns {{
 *   cleanedTitle: string,
 *   detected: {
 *     link?: {url: string, matchedText: string},
 *     dueDate?: {iso: string, matchedText: string},
 *     fixedTime?: {time: string, matchedText: string},
 *     recurrence?: {rule: {unit: string, count: number}, recurrenceString: string, matchedText: string},
 *     priority?: {level: string, matchedText: string},
 *     enforceDueDate?: {matchedText: string},
 *     dependency?: {task: object|null, fragment: string, matchedText: string},
 *     project?: {project: object|null, section: object|null, fragment: string, sectionFragment: string|undefined, matchedText: string},
 *     labels?: Array<{name: string, matchedText: string}>,
 *   }
 * }}
 */
export function parseTaskText(text, { existingTasks = [], projects = [], sections = [] } = {}) {
  if (!text || !text.trim()) return { cleanedTitle: text || '', detected: {} };

  let working = text;
  const detected = {};

  // Runs first — a URL's own text (query strings, paths) could otherwise
  // confuse the dependency/project detectors below.
  const linkMatch = findLinkPhrase(working);
  if (linkMatch) {
    detected.link = linkMatch;
    working = removeMatch(working, linkMatch.matchedText);
  }

  const dueMatch = findDuePhrase(working);
  if (dueMatch) {
    detected.dueDate = dueMatch;
    working = removeMatch(working, dueMatch.matchedText);
  }

  // Independent of the due-date match above — a title can carry a date, a
  // time, both, or neither (see findFixedTimePhrase's doc comment).
  const fixedTimeMatch = findFixedTimePhrase(working);
  if (fixedTimeMatch) {
    detected.fixedTime = fixedTimeMatch;
    working = removeMatch(working, fixedTimeMatch.matchedText);
  }

  const recMatch = findRecurrencePhrase(working);
  if (recMatch) {
    const n = Math.max(1, recMatch.rule.count);
    // Weekday-specific matches ("every sat and sun", "every second sun") carry a `days`
    // array — show which day(s) were detected instead of collapsing to a generic
    // "every N week(s)" that would silently drop that detail.
    const recurrenceString =
      recMatch.rule.days && recMatch.rule.days.length
        ? `every ${n === 1 ? '' : `${n} `}week${n === 1 ? '' : 's'} on ${recMatch.rule.days.map((d) => WEEKDAY_LABELS[d]).join(', ')}`
        : `every ${n} ${recMatch.rule.unit}${n === 1 ? '' : 's'}`;
    detected.recurrence = { ...recMatch, recurrenceString };
    working = removeMatch(working, recMatch.matchedText);
  }

  const priMatch = findPriorityPhrase(working);
  if (priMatch) {
    detected.priority = priMatch;
    working = removeMatch(working, priMatch.matchedText);
  }

  const durationMatch = findDurationPhrase(working);
  if (durationMatch) {
    detected.estimatedHours = durationMatch;
    working = removeMatch(working, durationMatch.matchedText);
  }

  const unattendedMatch = findUnattendedPhrase(working);
  if (unattendedMatch) {
    detected.unattended = unattendedMatch;
    working = removeMatch(working, unattendedMatch.matchedText);
  }

  const enforceDueDateMatch = findEnforceDueDatePhrase(working);
  if (enforceDueDateMatch) {
    detected.enforceDueDate = enforceDueDateMatch;
    working = removeMatch(working, enforceDueDateMatch.matchedText);
  }

  const depMatch = findDependencyPhrase(working, existingTasks);
  if (depMatch) {
    detected.dependency = depMatch;
    working = removeMatch(working, depMatch.matchedText);
  }

  const projectMatch = findProjectPhrase(working, projects, sections);
  if (projectMatch) {
    detected.project = projectMatch;
    working = removeMatch(working, projectMatch.matchedText);
  }

  const labelMatches = findLabelPhrases(working);
  if (labelMatches.length > 0) {
    detected.labels = labelMatches;
    labelMatches.forEach((m) => {
      working = removeMatch(working, m.matchedText);
    });
  }

  return { cleanedTitle: working, detected };
}
