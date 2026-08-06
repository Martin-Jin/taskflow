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
7. **Don't touch what wasn't asked.** Only propose operations that serve the
   user's actual request — do not "clean up" or reorganize unrelated tasks
   the user didn't mention, even if you notice something that looks messy.
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

/**
 * Assembles the full `context.md` sent with every AI Assistant request.
 * @param {{ tasks: Array, projects: Array, sections: Array, labels: Array, events: Array, today: string }} state
 * @returns {{ markdown: string, approxTokens: number, activeTaskCount: number }}
 */
export function buildAIContext({ tasks, projects, sections, labels, events, today }) {
  const referenceDate = today || new Date().toISOString().slice(0, 10);
  const parts = [
    INSTRUCTIONS,
    `\n# Reference date\n\nToday's date is ${referenceDate}.\n`,
    `\n${projectsSection(projects)}`,
    `\n${sectionsSection(sections)}`,
    `\n${labelsSection(labels)}`,
    `\n${tasksSection(tasks)}`,
    `\n${eventsSection(events)}`,
  ];
  const markdown = parts.join('\n');
  return {
    markdown,
    approxTokens: estimateTokens(markdown),
    activeTaskCount: (tasks || []).filter((t) => !t.isCompleted).length,
  };
}
