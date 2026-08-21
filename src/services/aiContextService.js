/**
 * ============================================================================
 * AI ASSISTANT CONTEXT BUILDER
 * ============================================================================
 * Builds `context.md` — the single standardized snapshot of the user's
 * workspace sent to the AI on every AI Assistant request (see
 * TODO.md's "AI Assistant upgrade" entry, Stage A). This is the contract
 * both sides share:
 *   - The AI reads this to know what already exists (so it can reference
 *     real ids instead of guessing names).
 *   - The shape of each entity here is reused verbatim as the shape of a
 *     `create_*`/`update_*` operation's fields in the plan the AI returns
 *     (see Stage B/C) — e.g. a `create_task` operation has the same fields
 *     as a `task` entry below — so there is exactly one schema per entity,
 *     not a slightly-different one for "describing" vs. "creating".
 *
 * Local-id contract (the main defense against typo'd/hallucinated ids):
 *   - Every entity below carries its REAL id. The AI must use these ids
 *     verbatim when referencing existing projects/sections/labels/tasks —
 *     never a name, never a guess.
 *   - Anything the AI creates in the same plan (a new project, a new label,
 *     a new parent task with new subtasks, etc.) does not have a real id
 *     yet, so the AI invents a LOCAL id of the form `new:<n>` (n = a small
 *     integer unique within that single response) and uses that same local
 *     id anywhere else in the plan it needs to refer back to the thing it
 *     just created (e.g. a subtask's `parentId: "new:1"`). The client
 *     resolves every `new:<n>` to a real id at apply time (Stage C/D).
 *   - Any id referenced in a plan that is neither a real existing id nor a
 *     declared `new:<n>` local id is a validation error (Stage C) — it is
 *     surfaced on the confirm screen, never silently coerced or dropped.
 * ============================================================================
 */

// Rough chars-per-token heuristic for the pre-flight cost estimate shown in
// the UI (Stage A.5) — deliberately not an exact tokenizer dependency, since
// this only needs to be "in the right ballpark", and is labeled as
// approximate wherever it's shown.
const APPROX_CHARS_PER_TOKEN = 4;

/** Rough token estimate for an arbitrary string of prompt content. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

const INSTRUCTIONS = `# Instructions

You are planning changes to this user's task/project workspace. You do not
apply anything directly — you return a set of operations (via tool calls)
that the user will review and approve/reject individually before anything is
written. Because of that review step, propose everything genuinely useful for
the request, including destructive operations (delete/move) when they're
actually implied — the user is the safety check, not you.

Critical rules — follow these exactly, mistakes here are not auto-corrected:

1. **Ids, not names.** Every reference to an existing project, section,
   label, or task below is (or is not) given by an exact "id" string in this
   document. When your operation needs to point at one of these, use that
   exact id string, character-for-character. Never invent an id. Never use a
   display name where an id is expected. If nothing in this document clearly
   matches what the user meant, leave the reference empty/omitted rather than
   guessing.
2. **Local ids for new things.** If your plan creates a new project, section,
   label, or task that another operation in the SAME plan needs to reference
   (e.g. three new subtasks that belong under a new parent task you're also
   creating), invent a local id of the exact form \`new:1\`, \`new:2\`, \`new:3\`
   (small unique integers, starting at 1, unique across this whole plan) for
   the thing being created, and use that same string as the reference in the
   other operation. Never reuse a local id for two different new things.
   Never use \`new:<n>\` to refer to something that already exists — existing
   things always use their real id from this document.
3. **Prefer reuse over duplication.** Before creating a new label or project,
   check the "Existing labels"/"Existing projects" list below for an
   exact or near-exact match (case-insensitive, singular/plural, common
   abbreviation). Reuse the existing id instead of creating a near-duplicate.
   Only propose a new label/project when nothing reasonably matches.
4. **Exact spelling.** When you DO create a new label/project/section name,
   copy the wording the user actually used as closely as sensible — don't
   silently pluralize, abbreviate, or re-case it.
5. **Dependencies (\`dependsOn\`) and subtasks (\`parentId\`).** \`dependsOn\` is a
   list of task ids (real or \`new:<n>\`) that must be completed before this
   task is eligible to be scheduled — use it for "do X after Y" requests.
   \`parentId\` is a single task id (real or \`new:<n>\`) marking this task as a
   subtask of another — use it when the user wants a task broken down into
   steps. Never create a dependency cycle (a task cannot depend, directly or
   transitively, on itself or on one of its own subtasks).
6. **Dates.** Resolve every relative date/time mention ("tomorrow", "next
   Friday", "in 2 weeks") against the reference date given below. Always
   emit ISO \`YYYY-MM-DD\` dates and 24-hour \`HH:MM\` times.
7. **Estimate durations.** When a task you're creating has no explicit
   duration stated by the user, set \`estimatedHours\` yourself to a
   realistic value for that task's nature and complexity (e.g. a few minutes
   for a quick errand, several hours for a substantial project task) — don't
   leave it unset expecting the client to fill in something sensible.
8. **Group related tasks into sections.** When creating a batch of related
   tasks for a new or existing project, propose \`create_section\` operations
   to group them by theme/phase (e.g. "plan a birthday party" → "Venue",
   "Food", "Invitations") whenever there's a sensible grouping. Don't force
   sections onto a single task or a small handful of unrelated asks just
   because the capability exists.
9. **Notes are freeform, tasks are not.** \`create_note\` is for reference
   material the user wants to keep and read later — meeting notes, a packing
   list they'll tick off by hand, a summary, a snippet. It is NOT a substitute
   for \`create_task\`: anything with a deadline, a duration, or a "get this
   done" shape is a task. A note's \`body\` is Markdown (headings, lists,
   \`- [ ]\` checkboxes, links, code fences all render), so use it. Only
   propose notes when the user actually asked for something note-shaped.
10. **Don't touch what wasn't asked.** Only propose operations that serve the
   user's actual request — do not "clean up" or reorganize unrelated tasks
   the user didn't mention, even if you notice something that looks messy.
`;

// Addendum appended to INSTRUCTIONS whenever the user has chosen a reduced
// context scope (see buildAIContext's `scope` param / AIQuickAddModal's
// context-scope picker) — explains what's been deliberately left out and how
// to behave without it, since the base INSTRUCTIONS above assume a full
// workspace snapshot is always present. Kept as one shared paragraph (not
// per-scope variants) since the guidance is identical whether nothing was
// sent or a project/date-range subset was: you can only reference what's
// actually listed below.
const REDUCED_CONTEXT_ADDENDUM = `
## Limited context

Some or all of the existing workspace (projects, sections, labels, tasks,
and/or calendar events) was deliberately left out of this request by the
user's own choice, so anything omitted below does NOT mean it doesn't
exist — it means you cannot see it and must not assume it. Concretely:

- Only reference an existing project/section/label/task/event id if it
  actually appears in a list below — never invent or guess one just because
  the request implies something should already exist.
- If the user's own request text names a project by name (e.g. "add this to
  my Work project") and no matching project id appears below, you have no
  way to resolve that name to an id — create a NEW project with that exact
  name instead (a \`create_project\` operation with a \`new:<n>\` local id),
  the same as if a genuinely new project were being requested.
- A new task's \`projectId\` may be omitted entirely if the request doesn't
  name a project — the app defaults it to the user's Inbox.
`;

function tasksSection(tasks) {
  const active = tasks.filter((t) => !t.isCompleted);
  const rows = active.map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes || undefined,
    priority: t.priority,
    dueDate: t.dueDate || null,
    projectId: t.projectId || null,
    sectionId: t.sectionId || null,
    parentId: t.parentId || undefined,
    dependsOn: t.dependsOn && t.dependsOn.length ? t.dependsOn : undefined,
    labelIds: t.labelIds && t.labelIds.length ? t.labelIds : undefined,
    estimatedHours: t.estimatedHours,
    remainingHours: t.remainingHours,
    isRecurring: t.isRecurring || undefined,
    recurrenceString: t.recurrenceString || undefined,
    fixedTime: t.fixedTime || undefined,
    isLocked: t.isLocked || undefined,
    isPassive: t.isPassive || undefined,
    earliestDate: t.earliestDate || undefined,
    enforceDueDate: t.enforceDueDate || undefined,
  }));
  return `## Existing tasks (non-completed only, ${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

function eventsSection(events) {
  const rows = (events || []).map((e) => ({
    id: e.id,
    title: e.title,
    date: e.date,
    startTime: e.startTime,
    endTime: e.endTime,
    description: e.description || undefined,
    location: e.location || undefined,
    isRecurring: e.isRecurring || undefined,
    recurrenceRule: e.recurrenceRule || undefined,
    source: e.source,
  }));
  return `## Existing calendar events (${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

/* Only ever called when the user opted into sending notes (see
   filterContextData's `includeNotes`) — a note body is unbounded freeform
   text, so it's the one part of the snapshot that's off by default. */
function notesSection(notes) {
  const rows = (notes || []).map((n) => ({ id: n.id, title: n.title, body: n.body || undefined }));
  return `## Existing notes (${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

function projectsSection(projects) {
  const rows = (projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    isPinned: p.isPinned || undefined,
  }));
  return `## Existing projects (${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

function sectionsSection(sections) {
  const rows = (sections || []).map((s) => ({
    id: s.id,
    name: s.name,
    projectId: s.projectId || null,
  }));
  return `## Existing sections (${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

function labelsSection(labels) {
  const rows = (labels || []).map((l) => ({ id: l.id, name: l.name }));
  return `## Existing labels (${rows.length} total)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

// Default event date-range window for "Custom" scope when the user hasn't
// picked their own start/end — "this month" isn't quite what's implemented
// (a fixed calendar month would shrink to almost nothing sent on the last
// day of a month); instead this is a rolling ~30 day window starting today,
// which stays a similarly-sized, useful lookahead no matter what day it is.
export const DEFAULT_EVENT_RANGE_DAYS = 30;

/**
 * Filters the raw workspace arrays down to what a given context `scope`
 * should include, before handing them to buildAIContext. Kept as a separate
 * step (rather than baked into buildAIContext itself) so callers — right now
 * just AIQuickAddModal — can filter once and reuse the identical filtered
 * arrays for both the token-estimate memo and the actual submit call,
 * guaranteeing those two never diverge.
 *
 * @param {{ tasks, projects, sections, labels, events }} data - raw workspace arrays.
 * @param {{ mode: 'full'|'none'|'custom', projectId?: string, eventStart?: string, eventEnd?: string }} [scope]
 *   - mode 'full' (default when omitted): no filtering, identical to today's behavior.
 *   - mode 'none': every array below is emptied out (labels included — see
 *     the spec this implements: "no context" means none of the snapshot).
 *   - mode 'custom': independent optional sub-filters —
 *     `projectId` restricts tasks/sections to that one project (plus that
 *     project itself; labels stay global/unfiltered since they're shared
 *     across projects and cheap to include). `eventStart`/`eventEnd`
 *     (inclusive ISO dates) restrict which events are included; if neither
 *     is set, events are left unfiltered (same as 'full'). Leaving both
 *     sub-filters unset behaves identically to 'full'.
 * @returns {{ tasks, projects, sections, labels, events }}
 */
export function filterContextData({ tasks, projects, sections, labels, events, notes }, scope) {
  const mode = scope?.mode || 'full';
  // Notes are opt-in in every mode rather than following the mode the way
  // everything else does: a note body is unbounded freeform prose, so it can
  // dwarf the rest of the snapshot, and some of it is the kind of thing a user
  // would rather not send anywhere. See AIQuickAddModal's "Include my notes".
  const scopedNotes = scope?.includeNotes && mode !== 'none' ? notes || [] : [];
  if (mode === 'full') return { tasks, projects, sections, labels, events, notes: scopedNotes };
  if (mode === 'none') return { tasks: [], projects: [], sections: [], labels: [], events: [], notes: [] };

  // mode === 'custom'
  let filteredProjects = projects;
  let filteredSections = sections;
  let filteredTasks = tasks;
  if (scope.projectId) {
    filteredProjects = (projects || []).filter((p) => p.id === scope.projectId);
    filteredSections = (sections || []).filter((s) => s.projectId === scope.projectId);
    filteredTasks = (tasks || []).filter((t) => t.projectId === scope.projectId);
  }
  let filteredEvents = events;
  // Calendar events have no projectId (see file header note in callers) — a
  // project filter never touches events, only a date range does.
  if (scope.eventStart || scope.eventEnd) {
    filteredEvents = (events || []).filter((e) => (!scope.eventStart || e.date >= scope.eventStart) && (!scope.eventEnd || e.date <= scope.eventEnd));
  }
  return { tasks: filteredTasks, projects: filteredProjects, sections: filteredSections, labels, events: filteredEvents, notes: scopedNotes };
}

/**
 * Assembles the full `context.md` sent with every AI Assistant request.
 * @param {{ tasks: Array, projects: Array, sections: Array, labels: Array, events: Array, today: string, scope: Object }} state
 *   `scope` (optional, defaults to full context) is the same shape filterContextData
 *   takes — pass it here to also append the reduced-context instructions addendum
 *   whenever scope.mode isn't 'full'; when a caller has already filtered the
 *   arrays itself (see AIQuickAddModal), pass the same `scope` through anyway so
 *   the addendum stays in sync with what was actually filtered.
 * @returns {{ markdown: string, approxTokens: number, activeTaskCount: number }}
 */
export function buildAIContext({ tasks, projects, sections, labels, events, notes, today, scope }) {
  const referenceDate = today || new Date().toISOString().slice(0, 10);
  const mode = scope?.mode || 'full';
  const parts = [
    INSTRUCTIONS,
    mode !== 'full' ? REDUCED_CONTEXT_ADDENDUM : '',
    `\n# Reference date\n\nToday's date is ${referenceDate}.\n`,
    `\n${projectsSection(projects)}`,
    `\n${sectionsSection(sections)}`,
    `\n${labelsSection(labels)}`,
    `\n${tasksSection(tasks)}`,
    `\n${eventsSection(events)}`,
    // Notes are opt-in, so the absence of this section is ambiguous on its
    // own ("no notes exist" vs. "you weren't shown them") — hence one explicit
    // line saying which, rather than an "Existing notes (0 total)" heading
    // that would read as the former.
    scope?.includeNotes
      ? `\n${notesSection(notes)}`
      : "\n## Existing notes\n\nThe user chose not to send their notes with this request, so you cannot see or edit any existing note. You may still propose `create_note` operations for new notes.\n",
  ];
  const markdown = parts.join('\n');
  return {
    markdown,
    approxTokens: estimateTokens(markdown),
    activeTaskCount: (tasks || []).filter((t) => !t.isCompleted).length,
  };
}
