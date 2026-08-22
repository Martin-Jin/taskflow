/**
 * ============================================================================
 * SEARCH QUERY OPERATORS
 * ============================================================================
 * Structured filters for the task search box, alongside the plain substring
 * matching it has always done: `due:friday p1 #work no:label`.
 *
 * Every operator is either colon-prefixed (`due:`, `is:`, `no:`) or carries a
 * sigil (`@tag`, `#project`, `p1`). That's deliberate rather than tidy — a bare
 * keyword like `overdue` would quietly stop finding a task actually called
 * "Overdue invoices", turning a search feature into a search bug. `p1`-`p4` are
 * the one concession, and only because smart-parse already claims that exact
 * shorthand when you type a title, so the app's vocabulary stays consistent.
 *
 * A query with no operators parses to pure free text and matches exactly as it
 * did before, so nothing regresses for anyone who never learns this exists.
 *
 * Date values go through dateParse's `findDuePhrase` — the same parser the
 * title field uses — so `due:tomorrow`, `due:friday`, `due:2026-09-01` and
 * `due:end of month` all work without a second, subtly-different date
 * vocabulary to keep in step.
 * ============================================================================
 */

import { findDuePhrase } from './dateParse';
import { toISODate } from './dateUtils';

/** Todoist's shorthand, matching smartParse.js's own mapping. */
const PRIORITY_BY_TOKEN = { p1: 'urgent', p2: 'high', p3: 'medium', p4: 'low' };

/** What `no:` / `is:` accept, and the aliases worth tolerating. */
const MISSING_ALIASES = {
  date: 'date',
  due: 'date',
  duedate: 'date',
  project: 'project',
  list: 'project',
  label: 'label',
  tag: 'label',
  section: 'section',
};

/**
 * Split a raw search string into structured filters plus leftover free text.
 *
 * @param {string} query
 * @param {{referenceDate?: Date}} [options] - referenceDate is injectable for tests.
 * @returns {{
 *   text: string, tags: string[], projects: string[], priorities: string[],
 *   dueOn: string|null, overdue: boolean, completed: boolean|null,
 *   missing: string[], hasOperators: boolean
 * }}
 */
export function parseSearchQuery(query, options = {}) {
  const referenceDate = options.referenceDate || new Date();
  const parsed = {
    text: '',
    tags: [],
    projects: [],
    priorities: [],
    dueOn: null,
    overdue: false,
    completed: null,
    missing: [],
    hasOperators: false,
  };
  if (!query || !query.trim()) return parsed;

  const textParts = [];
  const tokens = query.trim().toLowerCase().split(/\s+/);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.length > 1 && token.startsWith('@')) {
      parsed.tags.push(token.slice(1));
      parsed.hasOperators = true;
      continue;
    }
    if (token.length > 1 && token.startsWith('#')) {
      parsed.projects.push(token.slice(1));
      parsed.hasOperators = true;
      continue;
    }
    if (PRIORITY_BY_TOKEN[token]) {
      parsed.priorities.push(PRIORITY_BY_TOKEN[token]);
      parsed.hasOperators = true;
      continue;
    }

    const colonIdx = token.indexOf(':');
    if (colonIdx > 0) {
      const key = token.slice(0, colonIdx);
      const value = token.slice(colonIdx + 1);

      if (key === 'no') {
        const field = MISSING_ALIASES[value];
        if (field) {
          parsed.missing.push(field);
          parsed.hasOperators = true;
          continue;
        }
      }

      if (key === 'is') {
        if (value === 'overdue') {
          parsed.overdue = true;
          parsed.hasOperators = true;
          continue;
        }
        if (value === 'done' || value === 'completed') {
          parsed.completed = true;
          parsed.hasOperators = true;
          continue;
        }
        if (value === 'open' || value === 'active' || value === 'incomplete') {
          parsed.completed = false;
          parsed.hasOperators = true;
          continue;
        }
      }

      if (key === 'due') {
        /* A date phrase can be several words ("end of month", "next friday"),
           and splitting on whitespace has already broken it apart. Rejoin the
           rest of the query and let findDuePhrase take as much as it
           understands, then skip however many tokens it consumed. */
        const rest = [value, ...tokens.slice(i + 1)].join(' ');
        const phrase = findDuePhrase(rest, referenceDate);
        if (phrase && phrase.index === 0) {
          parsed.dueOn = phrase.iso;
          parsed.hasOperators = true;
          const consumedWords = phrase.matchedText.trim().split(/\s+/).length;
          // The first consumed word came from this token's own value.
          i += consumedWords - 1;
          continue;
        }
      }
    }

    textParts.push(token);
  }

  parsed.text = textParts.join(' ');
  return parsed;
}

/**
 * Does `task` satisfy an already-parsed query?
 *
 * Groups are AND'd together (`p1 #work` means urgent AND in Work). Within a
 * group the sensible combinator differs, and not arbitrarily:
 *   - tags AND, preserving the long-standing behaviour of the `@` filter — a
 *     task can carry several labels, so "both of these" is a real question.
 *   - projects OR, because a task has exactly ONE project; AND'ing two would
 *     always match nothing, which is a filter that can only disappoint.
 *   - priorities OR, same reasoning.
 *
 * @param {import('../types').Task} task
 * @param {ReturnType<typeof parseSearchQuery>} parsed
 * @param {{labels?: object[], projects?: object[], today?: string}} [ctx]
 */
export function taskMatchesParsedQuery(task, parsed, ctx = {}) {
  const labels = ctx.labels || [];
  const projects = ctx.projects || [];
  const today = ctx.today || toISODate(new Date());

  if (parsed.tags.length > 0) {
    const names = (task.labelIds || [])
      .map((id) => labels.find((l) => l.id === id)?.name?.toLowerCase())
      .filter(Boolean);
    if (!parsed.tags.every((tag) => names.some((name) => name.includes(tag)))) return false;
  }

  if (parsed.projects.length > 0) {
    const projectName = projects.find((p) => p.id === task.projectId)?.name?.toLowerCase() || '';
    if (!parsed.projects.some((needle) => projectName.includes(needle))) return false;
  }

  if (parsed.priorities.length > 0 && !parsed.priorities.includes(task.priority)) return false;

  if (parsed.dueOn && task.dueDate !== parsed.dueOn) return false;

  if (parsed.overdue) {
    // Matches the app's usual reading of overdue: past its date and not
    // finished. A completed task is history, not a problem.
    if (task.isCompleted) return false;
    if (!task.dueDate || task.dueDate >= today) return false;
  }

  if (parsed.completed !== null && !!task.isCompleted !== parsed.completed) return false;

  for (const field of parsed.missing) {
    if (field === 'date' && task.dueDate) return false;
    if (field === 'project' && task.projectId) return false;
    if (field === 'label' && (task.labelIds || []).length > 0) return false;
    if (field === 'section' && task.sectionId) return false;
  }

  if (!parsed.text) return true;
  const q = parsed.text;
  return !!(
    task.title?.toLowerCase().includes(q) ||
    task.notes?.toLowerCase().includes(q) ||
    task.sectionName?.toLowerCase().includes(q)
  );
}

/** The operators worth advertising in the UI, in the order they're shown. */
export const SEARCH_OPERATOR_HINTS = ['due:today', 'is:overdue', 'p1', '@tag', '#project', 'no:date'];
