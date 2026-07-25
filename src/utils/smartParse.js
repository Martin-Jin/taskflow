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
 * kept local here since they have no other call site: priority (Todoist's
 * own p1-p4 shorthand only — no "urgent"/"!!" keyword matching), dependency
 * mentions ("after <task>" / "depends on <task>"), a "#project" mention
 * (fuzzy-matched against existing Projects, same idea as dependency), and
 * "@label" mentions (one or more — unlike the other detectors these don't
 * need to resolve against anything that already exists, since a new tag is
 * just created on save).
 *
 * Detection runs in sequence — due date, recurrence, priority, dependency,
 * project, then labels — stripping each match out of the working text
 * before the next detector runs. This keeps the dependency fragment (which
 * captures "everything after the trigger word") free of unrelated phrases
 * that were typed after it, e.g. "after Design review tomorrow p2" leaves
 * a clean "Design review" fragment to match against existing task titles
 * once "tomorrow" and "p2" have already been pulled out. Labels run last so
 * "@name" mentions aren't accidentally swallowed by an earlier detector's
 * fragment capture.
 * ============================================================================
 */

import { findDuePhrase } from './dateParse';
import { findRecurrencePhrase } from './recurrence';
import { findDurationPhrase } from './durationParser';

const PRIORITY_LEVELS = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

function removeMatch(text, matchedText) {
  if (!matchedText) return text;
  const idx = text.toLowerCase().indexOf(matchedText.toLowerCase());
  if (idx === -1) return text;
  return (text.slice(0, idx) + text.slice(idx + matchedText.length)).replace(/\s{2,}/g, ' ').trim();
}

/** Exported so callers can strip an individually-accepted match out of a title at save time. */
export { removeMatch as stripMatchedText };

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
  const m = text.match(/\b(?:after|depends on)\s+(.+)$/i);
  if (!m || !m[1].trim()) return null;
  const fragment = m[1].trim();
  const task = matchFragmentAgainstCandidates(fragment, existingTasks, (t) => t.title);
  return { task, fragment, matchedText: m[0], index: m.index };
}

/** "#project" shorthand — single-word fragment (project names can be multi-word, but a hashtag delimiter can't tell where it ends without one). */
function findProjectPhrase(text, projects) {
  const m = text.match(/#([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const fragment = m[1];
  const project = matchFragmentAgainstCandidates(fragment, projects, (p) => p.name);
  return { project, fragment, matchedText: m[0], index: m.index };
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
 * @param {{existingTasks?: Array<{id: string, title: string}>, projects?: Array<{id: string, name: string}>}} [options]
 * @returns {{
 *   cleanedTitle: string,
 *   detected: {
 *     dueDate?: {iso: string, matchedText: string},
 *     recurrence?: {rule: {unit: string, count: number}, recurrenceString: string, matchedText: string},
 *     priority?: {level: string, matchedText: string},
 *     dependency?: {task: object|null, fragment: string, matchedText: string},
 *     project?: {project: object|null, fragment: string, matchedText: string},
 *     labels?: Array<{name: string, matchedText: string}>,
 *   }
 * }}
 */
export function parseTaskText(text, { existingTasks = [], projects = [] } = {}) {
  if (!text || !text.trim()) return { cleanedTitle: text || '', detected: {} };

  let working = text;
  const detected = {};

  const dueMatch = findDuePhrase(working);
  if (dueMatch) {
    detected.dueDate = dueMatch;
    working = removeMatch(working, dueMatch.matchedText);
  }

  const recMatch = findRecurrencePhrase(working);
  if (recMatch) {
    const n = Math.max(1, recMatch.rule.count);
    detected.recurrence = { ...recMatch, recurrenceString: `every ${n} ${recMatch.rule.unit}${n === 1 ? '' : 's'}` };
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

  const depMatch = findDependencyPhrase(working, existingTasks);
  if (depMatch) {
    detected.dependency = depMatch;
    working = removeMatch(working, depMatch.matchedText);
  }

  const projectMatch = findProjectPhrase(working, projects);
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
