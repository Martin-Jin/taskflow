/**
 * TaskDetailModal — the "task page" edit surface, laid out Todoist-style: a
 * title header, a free-text main column (description + sub-tasks), and a
 * compact metadata sidebar (Project, Date, Priority, Labels, ...). Lets the
 * user edit every tracked property of a Task plus manage its sub-tasks (add
 * / check off / delete / open).
 *
 * SUB-TASKS ARE JUST TASKS: a sub-task is a normal Task row with `parentId`
 * pointing at this task (see types/index.js) — there's no separate Subtask
 * type or modal anymore. The "Sub-tasks" section below lists this task's
 * direct children (`tasks.filter(t => t.parentId === task.id)`) and, when a
 * child's title is clicked, swaps this SAME modal instance over to showing
 * that child instead of mounting a second modal on top — see `activeTaskId`
 * below. A hierarchy label in the header (see HIERARCHY LABEL below) lets the
 * user navigate back the other way, from a sub-task up to its parent, the
 * same in-place way.
 *
 * HIERARCHY LABEL: the header row (next to the "..." menu and close button)
 * shows "Parent Task Name > This Task Name" (parent name clickable) when the
 * open task has a parent, or just this task's title plus a sub-task count
 * when it has children of its own — omitted entirely for a plain standalone
 * task. Clicking the parent name calls `setActiveTaskId`, which re-derives
 * `task` from the live `tasks` list without unmounting/remounting this
 * modal — so a multi-level chain (grandparent > parent > child) is walked
 * one in-place swap at a time, however deep it goes.
 *
 * Every field here that has a Todoist equivalent is pushed back to Todoist
 * immediately on Save — see SchedulerContext for the sync logic. Fields
 * with no Todoist equivalent (lock state, min/max chunk hours, Labels) stay
 * app-only.
 *
 * SMART PARSE: typing "#project" or "@tag" into the title is picked up the
 * same way as the existing due-date/priority/dependency shorthands (see
 * utils/smartParse.js) — "#project" fuzzy-matches an existing Project the
 * same way "after <task>" matches a dependency; "@tag" always succeeds,
 * creating a new Label on Save if no matching one exists yet (see
 * SchedulerContext.getOrCreateLabelIds). Label resolution is deliberately
 * deferred to Save rather than happening as each keystroke is detected —
 * unlike the other fields (all local, uncommitted state), creating a Label
 * touches shared app state, and doing that on every keystroke would leave
 * stray labels behind if the user typed "@foo" and then cancelled.
 *
 * RECURRENCE: editable here as an "every N <interval>" pair (count + unit),
 * covering day/week/month/year. On Save this is written to
 * `recurrenceString` as a normalized "every N <unit>(s)" string (what
 * utils/recurrence.js's parser reads back most reliably) and, for
 * Todoist-sourced tasks with sync active, pushed to Todoist via its
 * natural-language `due_string` field so Todoist's own recurrence engine
 * picks it up too.
 *
 * LIVE UPDATES: this modal always renders from the live `task` object
 * passed down by its parent (which derives it from context on every
 * render), not a component-local snapshot frozen at open time — see the
 * parent components (TaskListPanel / BoardView) for how `editingTask` is
 * kept fresh. Local form field state (title/notes/etc. being typed) is
 * separate and only resets when the task identity changes, so in-progress
 * edits aren't clobbered by unrelated background updates (e.g. a subtask
 * toggle) while still reflecting those updates immediately elsewhere in
 * the modal (subtask checklist, subtask counts, etc.).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Wind,
  Sunrise,
  X,
  Lock,
  Unlock,
  CalendarCheck,
  Link2,
  CalendarX2,
  Layers,
  Clock,
  Check,
  AlignLeft,
  MoreHorizontal,
  Trash2,
  Link as LinkIcon,
  Sparkles,
  FileStack,
  Timer,
  Pause,
  Play,
  Square,
  CheckCircle,
  ExternalLink,
  ChevronRight,
  CornerUpLeft,
  FolderInput,
  UserPlus,
  Search,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import {
  useTimers,
  getSignedLiveRemaining,
  getSignedElapsedSeconds,
  getDefaultDurationSeconds,
  formatTimerDuration,
} from '../../context/TimerContext';
import { useCompleteTask } from '../../context/CompleteTaskContext';
import { useSound } from '../../context/SoundContext';
import { parseDurationHours, formatDisplayDate, toISODate } from '../../utils/dateUtils';
import { linkLabel } from '../../utils/linkify';
import {
  parseRecurrenceRule,
  findRecurrencePhrase,
  buildRecurrenceString,
  resolveCurrentOccurrenceDueDate,
  computeFirstMatchingDueDate,
} from '../../utils/recurrence';
import { getIneligibleDependencyIds, areDependenciesMet } from '../../utils/dependencyUtils';
import Modal from '../Common/Modal';
import { TIME_OF_DAY_OPTIONS, TIME_OF_DAY_LABELS } from '../../utils/timeOfDay';
import NumberField from '../Common/NumberField';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useSmartTaskTitle, buildSmartChips } from '../../hooks/useSmartTaskTitle';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useIsMobile } from '../../hooks/useIsMobile';
import DependencyPicker from '../Common/DependencyPicker';
import HelpTooltip from '../Common/HelpTooltip';
import DetailField from '../Common/DetailField';
import SmartChips from '../Common/SmartChips';
import SmartTitleInput from '../Common/SmartTitleInput';
import { faviconUrl } from '../Dashboard/notesModel';
import { findLinkPhrases, stripMatchedText } from '../../utils/smartParse';
import {
  getEffectiveEstimatedHours,
  getAllDescendants,
  isCompletedForCurrentOccurrence,
  getEffectiveRemainingHoursForOccurrence,
  computeRemainingHoursPatchAfterElapsed,
  getIneligibleParentIds,
} from '../../utils/taskHierarchy';
import {
  computeDueDateError,
  computeDueDateRequiredError,
  computeFixedTimeError,
  computeEnforcingAncestor,
} from '../../utils/taskValidation';
import SmartParseGuideModal from './SmartParseGuideModal';
import SaveTemplateModal from './SaveTemplateModal';
import CommentThread from './TaskDetail/CommentThread';
import SubtaskList from './TaskDetail/SubtaskList';
import DetailSidebar from './TaskDetail/DetailSidebar';
import { filterMentionCandidates } from '../../utils/commentMentions';
import { computeEffectiveRole, resolveOwnerProfile, getAssignableCollaborators } from '../../utils/sharedProjectAccess';

// Sentinel stored in smartParentTaskId by a smart-parsed "unsubtask" mention
// (see fields.unsubtask below) to mean "clear this task's parentId" — distinct
// from smartParentTaskId's own null ("no smart-parse draft at all"), since a
// real parent id is always a Firestore doc id and can never equal this string.
const UNSUBTASK_DRAFT = 'unsubtask';

// Smart-parsed link phrases (e.g. "check out example.com") get stripped out
// of notes text on load/save so the raw phrase doesn't linger once it's
// been turned into a link pill (see notesLinkMatches/notes-link-pill below).
function stripNotesLinks(text) {
  let next = text || '';
  findLinkPhrases(next).forEach((match) => {
    next = stripMatchedText(next, match.matchedText);
  });
  return next;
}

// Merges freshly re-detected link phrases in `text` with a set of
// already-known matches (which carry no text `index` once their raw phrase
// has been stripped out), keyed by url so a link isn't duplicated if it
// somehow still appears in both. Freshly detected matches win (they carry an
// `index`, needed for the in-textarea highlight); a previously-known link
// whose phrase is no longer present in `text` is still kept, since stripping
// the raw phrase out of notes is normal/expected once it's become a pill —
// only the pill's own remove ("X") button should drop it.
function mergeNoteLinks(text, prevMatches) {
  const detected = findLinkPhrases(text || '');
  const byUrl = new Map((prevMatches || []).map((m) => [m.url, m]));
  detected.forEach((m) => byUrl.set(m.url, m));
  return [...byUrl.values()];
}

// Shallow "same contents" check for the small arrays (recurrenceDays,
// dependsOn, labelIds) compared against the saved snapshot in a few places
// below — order-sensitive, which is fine since none of these arrays are
// re-sorted independently of their contents changing.
function jsonArrayEq(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

// On load, seeds notesLinkMatches from whatever's freshly detectable in the
// raw notes plus whatever was already persisted to task.noteLinks (see
// commitChanges) — the persisted-value path a fresh mount needs since there's
// no "previous" in-memory state yet.
function getInitialNoteLinks(task) {
  return mergeNoteLinks(task.notes || '', task.noteLinks || []);
}

export default function TaskDetailModal({ task: openedTask, onClose }) {
  const {
    tasks,
    blocks,
    addTask,
    updateTask,
    deleteTask,
    toggleTaskLock,
    sections,
    projects,
    labels,
    getOrCreateLabelIds,
    uncompleteTask,
    addComment,
    deleteComment,
    setNotification,
    sharedProjects,
    viewersByProject,
    taskTemplates,
    setTaskTemplates,
    markBlockDone,
    unmarkBlockDone,
    setRemainingHoursWithBlockInference,
  } = useScheduler();

  // Which task this modal instance currently displays. Starts as the task it
  // was opened with, but navigating to a parent (via the hierarchy label) or
  // a sub-task (via the Sub-tasks list) just swaps this id — re-deriving
  // `task` below from the live `tasks` list — instead of mounting a new
  // modal on top, so a click-through chain never stacks. `openedTask` is only
  // ever read as this state's initial value; once mounted, this modal is
  // fully driven by `activeTaskId`.
  const [activeTaskId, setActiveTaskId] = useState(openedTask.id);
  const task = tasks.find((t) => t.id === activeTaskId) || openedTask;
  const { user } = useAuth();
  const { getTimerForTask, startTimer, pauseTimer, resumeTimer, stopTimer } = useTimers();
  const { requestComplete } = useCompleteTask();
  const { playUncomplete } = useSound();
  // TaskDetailModal's overlay/close/focus-trap shell now comes from <Modal>
  // (see the render-prop below), but a couple of handlers that call
  // requestClose (e.g. handleDelete) are defined up here, outside that
  // render prop's scope. Ref mutation during render is safe (unlike
  // setState), so the render prop just stashes the latest requestClose here
  // on every render for those handlers to read.
  const requestCloseRef = useRef(() => {});

  const [title, setTitle] = useState(task.title);
  const [link, setLink] = useState(task.link || '');
  const [notes, setNotes] = useState(() => stripNotesLinks(task.notes || ''));
  const [estimatedHours, setEstimatedHours] = useState(task.estimatedHours);
  const [priority, setPriority] = useState(task.priority || 'medium');
  const [dueDate, setDueDate] = useState(resolveCurrentOccurrenceDueDate(task) || '');
  const [isRecurring, setIsRecurring] = useState(!!task.isRecurring);
  const initialRule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
  const [recurrenceCount, setRecurrenceCount] = useState(initialRule.count);
  const [recurrenceUnit, setRecurrenceUnit] = useState(initialRule.unit);
  // Weekday indices (0=Sun..6=Sat) for a day-specific rule ("every sat and
  // sun") — null for a plain "every N <unit>" rule. Carried alongside
  // count/unit so a smart-parsed or previously-imported weekday-specific
  // recurrence isn't silently collapsed to a generic cadence on save.
  const [recurrenceDays, setRecurrenceDays] = useState(initialRule.days || null);
  // Free-text override shown in place of the day-specific "Every ... on ..."
  // label while the user is editing it (see Repeat DetailField below) — null
  // means "not editing", so the plain read-only label renders instead.
  const [repeatEditText, setRepeatEditText] = useState(null);
  const [projectId, setProjectId] = useState(task.projectId || '');
  const [sectionId, setSectionId] = useState(task.sectionId || '');
  // Separate from the projectId/sectionId untouched-comparisons below: a
  // "#Project/Section" smart-parse match shouldn't clobber a section the
  // user has since picked manually from the dropdown, even while the
  // project itself is still smart-parse-driven.
  const [hasEditedSection, setHasEditedSection] = useState(false);
  const [dependsOn, setDependsOn] = useState(task.dependsOn || []);
  // Tracked as its own piece of local state (like every other sidebar field)
  // rather than read live off `task.parentId` at commit time — see
  // commitChanges below. It used to be read straight off `task` there, which
  // was a stale-closure bug: a direct reparent action (the "move to" popover,
  // "Remove from parent task") calls updateTask immediately, but if the
  // sidebar's debounced auto-save (commitChanges, below) had a timer already
  // pending from an earlier edit, that timer's closure had captured the OLD
  // `task.parentId` and would silently reassert it moments later, undoing the
  // direct action the user just took. Both direct-reparent call sites now
  // update this state (and the snapshot, so it isn't left dirty) synchronously
  // alongside their updateTask call, so any pending or future commitChanges
  // call reads the value the user actually asked for.
  const [parentId, setParentId] = useState(task.parentId ?? null);
  // Draft parent id from a smart-parsed "sub of <task>"/"subtask of <task>"
  // title mention — null means "not touched by smart parse", distinct from
  // clearing the parent (which the "move to" popover does directly via
  // updateTask, not through this draft). No widget edits this directly (like
  // dependsOn's DependencyPicker has), so unlike most sidebar fields it can't
  // compare against a task.* original to decide "untouched" — null itself IS
  // the untouched state, same idea as fixedTimeEnabled's hasEditedFixedTime.
  // A smart-parsed "unsubtask" mention (see fields.unsubtask below) stores the
  // sentinel UNSUBTASK_DRAFT here instead of null, so "clear the parent" is
  // still distinguishable from "no draft" even though both ultimately resolve
  // to a null parentId at commit time.
  const [smartParentTaskId, setSmartParentTaskId] = useState(null);
  const [isPassive, setIsPassive] = useState(!!task.isPassive);
  /* A sidebar-style field, so it must appear in SIX places or the autosave
     machinery misbehaves — see the reconcile effect below. Missing it from
     commitChanges while dirty-tracking it here is the specific mistake that
     produced an infinite save loop on the first attempt at this: the field
     stays dirty forever because nothing ever writes it, so the debounce
     re-arms on every pass. */
  const [preferredTimeOfDay, setPreferredTimeOfDay] = useState(task.preferredTimeOfDay || '');
  const [earliestDate, setEarliestDate] = useState(task.earliestDate || '');
  const [enforceDueDate, setEnforceDueDate] = useState(!!task.enforceDueDate);
  const [fixedTime, setFixedTime] = useState(task.fixedTime || '');
  // "Fixed time" has no value to speak of while the checkbox is checked but
  // no time has been picked yet — fixedTimeEnabled tracks the checkbox
  // itself (separate from the "HH:MM" value) so that state is distinguishable
  // from "not fixed at all", and hasEditedFixedTime is a dedicated
  // manual-edit flag: unlike every other sidebar field here (which compares
  // its live value against the task's original to decide "untouched"),
  // `fixedTime` alone can't use that comparison — a smart-parse-applied time
  // is a non-empty/changed value too, so re-detecting a *different* time
  // phrase later in the same title would otherwise never be able to
  // overwrite it once the first detection had already applied.
  const [fixedTimeEnabled, setFixedTimeEnabled] = useState(!!task.fixedTime);
  const [hasEditedFixedTime, setHasEditedFixedTime] = useState(false);
  const [labelIds, setLabelIds] = useState(task.labelIds || []);
  // The "Add sub-task" draft form's own state, smart-parse instance, and
  // handlers all live in SubtaskList now (see TaskDetail/SubtaskList.jsx) —
  // like CommentThread, it never touches this modal's draft/autosave
  // lifecycle, so it only needs `task` + `setActiveTaskId` from here.
  const [menuOpen, setMenuOpen] = useState(false);
  // "Move to" popover (breadcrumb button next to the hierarchy label) — lets
  // the user manually reparent this task, or clear its parent, instead of the
  // AI-tool-only path that existed before. Filter text is local to the
  // popover and cleared whenever it closes or a selection is made.
  const [moveToOpen, setMoveToOpen] = useState(false);
  const [moveToQuery, setMoveToQuery] = useState('');
  // Icon-only timer trigger in the topbar (separate from the "..." menu) —
  // opens a small popover hosting the same TaskTimerControl used in the
  // Timer DetailField below, for quick start/pause/stop without opening the
  // full field list. Not explicitly reset on task switch (setActiveTaskId),
  // mirroring menuOpen just above — both close naturally via useMenuPosition's
  // own outside-click/Escape handling well before a real navigation click
  // (the hierarchy label / sub-task row) would land elsewhere in the modal.
  const [timerPopoverOpen, setTimerPopoverOpen] = useState(false);
  // Inline "log this as progress?" prompt shown in the timer popover right
  // after a pause — null when not showing, or { suggestedHours } pre-filled
  // with the just-elapsed time. Lives alongside timerPopoverOpen (reset
  // wherever that closes/switches tasks) rather than as its own modal, since
  // it's a small follow-up to the pause action, not a separate flow.
  const [pauseLogPrompt, setPauseLogPrompt] = useState(null);
  const [showSmartParseGuide, setShowSmartParseGuide] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [notesLinkMatches, setNotesLinkMatches] = useState(() => getInitialNoteLinks(task));
  const [isNotesFocused, setIsNotesFocused] = useState(false);

  // Comment composing/posting state, @-mention autocomplete, and the
  // attachment lightbox all live in CommentThread now (see TaskDetail/
  // CommentThread.jsx) — it's genuinely self-contained (comments post
  // immediately, bypassing this modal's draft/autosave lifecycle entirely)
  // and only needs `task` from here.
  const isSharedTask = !!task.sharedProjectId;
  const sharedProject = isSharedTask ? sharedProjects?.[task.sharedProjectId] : null;

  // "Assign to…" search (three-dot menu) — a type-to-filter input over
  // `assignableCollaborators` below, replacing what used to be a flat button
  // list. Reset whenever the three-dot menu itself closes (see the effect
  // near menuOpen) so reopening it always starts from a blank search rather
  // than the previous session's leftover query/highlight.
  const [assignSearchQuery, setAssignSearchQuery] = useState('');

  // A two-stage Escape in the "..." menu's assignee search: the first press
  // clears the query, and with the query empty this layer is gone so the next
  // one closes the menu. Has to be a layer, not a keydown branch — the menu
  // itself is a layer and would otherwise take the keypress (see useEscapeLayer).
  useEscapeLayer(!!assignSearchQuery, () => {
    setAssignSearchQuery('');
    setAssignHighlight(0);
  });
  const [assignHighlight, setAssignHighlight] = useState(0);

  // The owner has no entry in `collaborators` (see SharedProject typedef) —
  // resolveOwnerProfile prefers the denormalized ownerDisplayName/
  // ownerPhotoURL on the project doc (durable, works while the owner's
  // offline), falling back to live presence and then a generic label for a
  // project doc that predates that field.
  const ownerProfile = sharedProject
    ? resolveOwnerProfile(sharedProject, viewersByProject?.[task.sharedProjectId], sharedProject.ownerId)
    : null;

  // Viewer-role collaborators see a read-only comment thread (Phase 3 fix):
  // comments are stored EMBEDDED in the task document's `comments` array, not
  // in the abandoned `comments` subcollection firestore.rules still has a
  // block for (see its stale comment there for the full story) — so a
  // comment write is really a write to the whole task, and `tasks/{taskId}`'s
  // rule only allows `parentOwner() || parentEditor()`. Widening that rule to
  // include viewers would let them edit every other field on the task too
  // (title, dates, completion), not just append a comment, since rules can't
  // cheaply express "only the comments array changed" — so instead the UI
  // hides/disables the composer for viewers rather than showing a write that
  // would just fail against Firestore.
  const myRole = isSharedTask ? computeEffectiveRole(sharedProject, user?.uid) : null;
  const isReadOnlyViewer = isSharedTask && myRole === 'viewer';

  // "Assign to…" menu (three-dot menu below) — every non-anonymous
  // collaborator plus the owner, for a shared task only. Unlike
  // mentionCandidates above, this deliberately does NOT exclude the current
  // viewer — assigning a task to yourself is the normal case (see
  // getAssignableCollaborators' own doc comment).
  const assignableCollaborators = useMemo(() => {
    if (!sharedProject) return [];
    return getAssignableCollaborators({
      ownerId: sharedProject.ownerId,
      collaborators: sharedProject.collaborators,
      ownerDisplayName: ownerProfile?.displayName,
      ownerPhotoURL: ownerProfile?.photoURL,
    });
  }, [sharedProject, ownerProfile]);

  // Re-filters assignableCollaborators as the user types — reuses the same
  // case-insensitive substring filter the comment @-mention dropdown already
  // uses (an empty query returns every candidate, matching the old flat
  // list's default of showing everyone).
  const assignSearchMatches = useMemo(
    () => filterMentionCandidates(assignSearchQuery, assignableCollaborators),
    [assignSearchQuery, assignableCollaborators]
  );

  // Reset the search box the moment the three-dot menu closes (however it
  // closes — Escape, outside click, or picking an assignee), so it never
  // reopens showing a stale query from a previous visit.
  useEffect(() => {
    if (!menuOpen) {
      setAssignSearchQuery('');
      setAssignHighlight(0);
    }
  }, [menuOpen]);

  /** Applies `assignedTo` (null for the synthetic "Unassigned" entry) and closes the menu. */
  function chooseAssignee(candidate) {
    updateTask(task.id, { assignedTo: candidate?.uid ?? null });
    setMenuOpen(false);
  }

  const notesRef = useRef(null);
  const notesBackdropRef = useRef(null);
  useAutosizeTextarea(notesRef, notes, { maxLines: 20 });

  // Keep the highlight backdrop's scroll position glued to the textarea's —
  // otherwise scrolling the (max-3-line) textarea leaves the highlighted
  // mark rendered at its old position while the underlying text has moved.
  function syncNotesBackdropScroll() {
    if (notesBackdropRef.current && notesRef.current) {
      notesBackdropRef.current.scrollTop = notesRef.current.scrollTop;
    }
  }

  // On mobile this menu always opens as a centered popup rather than
  // attempting to anchor to the trigger — a corner-anchored menu this wide
  // (280px, the same width as most of a phone's own viewport) rarely has
  // room to sit flush under a topbar icon without clipping. Desktop keeps
  // the anchored dropdown, still measured/portaled the same way so
  // useMenuPosition's overflow check covers it too.
  const isMobile = useIsMobile();
  const menuTriggerRef = useRef(null);
  const {
    menuRef,
    mode: menuMode,
    style: menuStyle,
  } = useMenuPosition({
    isOpen: menuOpen,
    anchorRef: menuTriggerRef,
    onClose: () => setMenuOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  // Clears the pause-log prompt whenever the timer popover closes (outside
  // click, Escape, toggling the trigger again) so it doesn't linger stale
  // the next time the popover is reopened for this or another task.
  useEffect(() => {
    if (!timerPopoverOpen) setPauseLogPrompt(null);
  }, [timerPopoverOpen]);

  // Positioning for the icon-only timer trigger's popover — same
  // useMenuPosition helper as the "..." menu just above (anchored dropdown on
  // desktop, centered-with-backdrop fallback whenever it wouldn't fit, forced
  // centered on mobile), just a separate hook instance since the two popovers
  // open independently of each other.
  const timerTriggerRef = useRef(null);
  const {
    menuRef: timerPopoverRef,
    mode: timerPopoverMode,
    style: timerPopoverStyle,
  } = useMenuPosition({
    isOpen: timerPopoverOpen,
    anchorRef: timerTriggerRef,
    onClose: () => setTimerPopoverOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  // Positioning for the "move to" popover — same useMenuPosition helper as
  // the "..." menu and timer popover above (its own independent instance so
  // all three can open without interfering with each other).
  const moveToTriggerRef = useRef(null);
  const {
    menuRef: moveToPopoverRef,
    mode: moveToPopoverMode,
    style: moveToPopoverStyle,
  } = useMenuPosition({
    isOpen: moveToOpen,
    anchorRef: moveToTriggerRef,
    onClose: () => setMoveToOpen(false),
    forceCentered: isMobile,
    computeAnchored: (anchorRect, menuRect) => {
      const spaceBelow = window.innerHeight - anchorRect.bottom;
      const openAbove = spaceBelow < menuRect.height && anchorRect.top > spaceBelow;
      return {
        left: anchorRect.right - menuRect.width,
        top: openAbove ? undefined : anchorRect.bottom + 4,
        bottom: openAbove ? window.innerHeight - anchorRect.top + 4 : undefined,
      };
    },
  });

  // Candidate tasks for "move to": every task except this one, its own
  // descendants (would create a cycle), and anything already at the max
  // sub-task depth (would create a 3-level chain) — see taskHierarchy.js's
  // getIneligibleParentIds, the single source of truth for this rule shared
  // with the AI reparent tool.
  const ineligibleParentIds = useMemo(() => getIneligibleParentIds(task.id, tasks), [task.id, tasks]);
  const moveToCandidates = useMemo(() => {
    const q = moveToQuery.trim().toLowerCase();
    return tasks.filter((t) => !ineligibleParentIds.has(t.id) && (!q || t.title.toLowerCase().includes(q)));
  }, [tasks, ineligibleParentIds, moveToQuery]);

  function handleMoveToParent(newParentId) {
    updateTask(task.id, { parentId: newParentId });
    // Mirror the change into local state (see the parentId declaration above)
    // and directly into the snapshot, the same way commitChanges syncs its own
    // snapshot right after firing updateTask — otherwise this field would sit
    // "dirty" against the pre-move snapshot and, if a sidebar auto-save timer
    // from an earlier edit fires afterward, commitChanges would either fight
    // this direct change or (before this field existed as local state) simply
    // reassert the stale task.parentId it had captured. Also clears
    // smartParentTaskId so a stale smart-parsed "sub of" draft from earlier in
    // this session can't override this deliberate direct action on the next
    // autosave (see its use in commitChanges below).
    setParentId(newParentId);
    setSmartParentTaskId(null);
    if (initialSnapshotRef.current) initialSnapshotRef.current.parentId = newParentId;
    setMoveToOpen(false);
    setMoveToQuery('');
  }

  const {
    activeIndex: moveToActiveIndex,
    setActiveIndex: setMoveToActiveIndex,
    listRef: moveToListRef,
    handleKeyDown: handleMoveToKeyDown,
  } = useListKeyboardNav({
    itemCount: moveToCandidates.length,
    onSelect: (index) => {
      const candidate = moveToCandidates[index];
      if (candidate) handleMoveToParent(candidate.id);
    },
    resetKey: moveToQuery,
  });

  // Snapshot of the task's saved values, refreshed whenever a *different*
  // task is opened (mirrors the reset-on-task.id effect below) — compared
  // against current form state to decide whether the inline Save/Cancel row
  // (rendered right under the description, Todoist-style, instead of a
  // permanent footer) should show at all.
  const initialSnapshotRef = useRef(null);
  // Set to true by commitChanges() right after it calls updateTask, and
  // checked/cleared by the "pull in external change" effect below whenever
  // that effect ends up pushing a correction into local state. Exists to fix
  // a self-re-arming loop: updateTask's own cascade helpers
  // (computeRecurringRescheduleUpdate, computeEnforceDueDateSyncUpdates,
  // computeRecurrenceSyncUpdates — all in SchedulerContext.jsx) can settle a
  // field onto a value that differs from what commitChanges just requested
  // (e.g. an off-pattern recurring move recorded as a one-occurrence override
  // instead of a plain reschedule, or an ancestor's enforceDueDate forcing
  // itself back on). The pull-in effect can't otherwise tell that apart from
  // a genuinely external change (another device's sync, an undo elsewhere) —
  // both look like "task's live value no longer matches our snapshot" — and
  // pushing either into local state re-arms the sidebar auto-save timer (the
  // field is one of its dependencies), which calls commitChanges() again,
  // which can trigger the same cascade again, repeating for as long as it
  // takes to stabilize ("repeated update notifications for a few seconds").
  // The field still needs to visually update to the cascade's authoritative
  // value (it IS the real saved state) — this flag doesn't block that, it
  // only tells the debounce effect that the very next re-arm opportunity is a
  // reaction to OUR OWN save landing, not fresh user input, so it should be
  // skipped once rather than scheduling another commitChanges() call. A
  // genuinely new edit right after still arms normally, since typing into a
  // field sets that field's own state directly rather than going through
  // this flag.
  const isReconcilingOwnCommitRef = useRef(false);
  // Companion to the flag above: set by the pull-in effect the moment it
  // actually pushes a correction while isReconcilingOwnCommitRef is true, and
  // consumed (read-then-cleared) by the debounce effect's very next run. Kept
  // separate from isReconcilingOwnCommitRef itself because the pull-in effect
  // only sometimes has something to reconcile (a commit whose cascade didn't
  // touch any tracked field leaves nothing to suppress).
  const suppressNextAutoSaveRef = useRef(false);
  // Latches true the first time an *appliable* shared field (the ones
  // handleApplyToAllSubtasks actually copies: priority, due date, project/
  // section, labels, passive — see that function's doc comment) goes dirty
  // for this task, and only resets on task switch (see the [task.id] effect
  // below) — unlike isDirty itself, this doesn't flip back to false the
  // moment the sidebar's debounced auto-save (commitChanges) resets
  // initialSnapshotRef to match the just-saved values. Drives the "Apply to
  // all sub-tasks" button so it stays visible for the rest of this modal
  // session once the user has edited a shared field, instead of disappearing
  // ~500ms after each edit. Deliberately narrower than isDirty/sidebarDirty:
  // title/notes/estimatedHours/dependsOn/fixedTime/recurrence/enforceDueDate
  // are dirty-tracked for the Save row but aren't part of what gets applied,
  // so editing only those must NOT show this button.
  const hasEditedSharedFieldsRef = useRef(false);
  // Reset the moment any appliable field changes again after a successful
  // apply, so the button disappears right after a click and only reappears
  // once there's something new worth (re-)applying.
  const [justAppliedToAll, setJustAppliedToAll] = useState(false);
  if (!initialSnapshotRef.current) {
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: stripNotesLinks(task.notes || ''),
      estimatedHours: task.estimatedHours,
      priority: task.priority || 'medium',
      dueDate: resolveCurrentOccurrenceDueDate(task) || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: initialRule.count,
      recurrenceUnit: initialRule.unit,
      recurrenceDays: initialRule.days || null,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      parentId: task.parentId ?? null,
      isPassive: !!task.isPassive,
      preferredTimeOfDay: task.preferredTimeOfDay || '',
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
      fixedTimeEnabled: !!task.fixedTime,
      labelIds: task.labelIds || [],
    };
  }

  // Tasks that can't be picked as a dependency of this one: itself, and any
  // task that (directly or transitively) already depends on it — either
  // would create a cycle the scheduler could never resolve.
  const ineligibleDependencyIds = useMemo(() => getIneligibleDependencyIds(task.id, tasks), [task.id, tasks]);
  const dependencyOptions = useMemo(
    () => tasks.filter((t) => !ineligibleDependencyIds.has(t.id) && !t.isCompleted),
    [tasks, ineligibleDependencyIds]
  );
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const incompleteDependencies = useMemo(
    () => (task.dependsOn || []).map((depId) => taskById.get(depId)).filter((dep) => dep && !dep.isCompleted),
    [task.dependsOn, taskById]
  );

  // Reset local form state whenever a *different* task is opened (not on
  // every re-render, or in-progress typing would get clobbered by
  // unrelated background updates to the same task).
  useEffect(() => {
    setTitle(task.title);
    setLink(task.link || '');
    const rawNotes = task.notes || '';
    setNotes(stripNotesLinks(rawNotes));
    setNotesLinkMatches(getInitialNoteLinks(task));
    setIsNotesFocused(false);
    setEstimatedHours(task.estimatedHours);
    setPriority(task.priority || 'medium');
    setDueDate(resolveCurrentOccurrenceDueDate(task) || '');
    setIsRecurring(!!task.isRecurring);
    const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
    setRecurrenceCount(rule.count);
    setRecurrenceUnit(rule.unit);
    setRecurrenceDays(rule.days || null);
    setProjectId(task.projectId || '');
    setSectionId(task.sectionId || '');
    setHasEditedSection(false);
    setDependsOn(task.dependsOn || []);
    setParentId(task.parentId ?? null);
    setSmartParentTaskId(null);
    setIsPassive(!!task.isPassive);
    setPreferredTimeOfDay(task.preferredTimeOfDay || '');
    setEarliestDate(task.earliestDate || '');
    setEnforceDueDate(!!task.enforceDueDate);
    setFixedTime(task.fixedTime || '');
    setFixedTimeEnabled(!!task.fixedTime);
    setHasEditedFixedTime(false);
    setLabelIds(task.labelIds || []);
    setPauseLogPrompt(null);
    setMoveToOpen(false);
    setMoveToQuery('');
    resetSmartState();
    lastSmartEstimatedHoursRef.current = null;
    lastSmartEarliestDateRef.current = null;
    hasEditedSharedFieldsRef.current = false;
    setJustAppliedToAll(false);
    isReconcilingOwnCommitRef.current = false;
    suppressNextAutoSaveRef.current = false;
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: stripNotesLinks(task.notes || ''),
      estimatedHours: task.estimatedHours,
      priority: task.priority || 'medium',
      dueDate: resolveCurrentOccurrenceDueDate(task) || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: rule.count,
      recurrenceUnit: rule.unit,
      recurrenceDays: rule.days || null,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      parentId: task.parentId ?? null,
      isPassive: !!task.isPassive,
      preferredTimeOfDay: task.preferredTimeOfDay || '',
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
      fixedTimeEnabled: !!task.fixedTime,
      labelIds: task.labelIds || [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Pulls in an EXTERNAL change to a sidebar field (e.g. an undo/redo
  // elsewhere restoring this task's previous priority/due date/etc.) while
  // this modal stays open on the same task — otherwise the field only
  // catches up the next time the modal is reopened. Only syncs a field that
  // is still "untouched" (local value === the last value we synced/saved),
  // so an in-progress edit is never clobbered — consistent with how these
  // same fields already autosave themselves without an explicit Save step
  // (see sidebarDirty/commitChanges below). Deliberately excludes
  // title/link/notes, which keep the existing task.id-only reset behavior
  // since they're gated behind an explicit Save/Cancel instead.
  //
  // This effect can't tell "something else changed this field" (genuine
  // external change) apart from "our OWN commitChanges just landed, and
  // updateTask's cascade helpers settled this field on a slightly different
  // value than we asked for" purely from the mismatch itself — both look
  // identical (task's live value != our snapshot). It doesn't need to: either
  // way, the cascade's value is authoritative and belongs in local state, so
  // the sync below runs unconditionally. What it DOES need to prevent is that
  // sync re-arming the sidebar auto-save timer for a reason that isn't fresh
  // user input — see isReconcilingOwnCommitRef/suppressNextAutoSaveRef
  // (declared above commitChanges) for how that's done: if this effect is
  // running as a direct result of our own commit (the flag commitChanges set
  // right after calling updateTask) AND it actually pushes a correction here,
  // it marks suppressNextAutoSaveRef so the debounce effect's very next check
  // skips arming once, then clears the "our own commit" flag either way once
  // this pass has seen it.
  useEffect(() => {
    const snap = initialSnapshotRef.current;
    if (!snap) return;
    const isOwnCommit = isReconcilingOwnCommitRef.current;
    isReconcilingOwnCommitRef.current = false;
    let pushedCorrection = false;
    const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
    const taskValues = {
      estimatedHours: task.estimatedHours,
      priority: task.priority || 'medium',
      dueDate: resolveCurrentOccurrenceDueDate(task) || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: rule.count,
      recurrenceUnit: rule.unit,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      parentId: task.parentId ?? null,
      isPassive: !!task.isPassive,
      preferredTimeOfDay: task.preferredTimeOfDay || '',
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
      fixedTimeEnabled: !!task.fixedTime,
    };
    const setters = {
      estimatedHours: setEstimatedHours,
      priority: setPriority,
      dueDate: setDueDate,
      isRecurring: setIsRecurring,
      recurrenceCount: setRecurrenceCount,
      recurrenceUnit: setRecurrenceUnit,
      projectId: setProjectId,
      sectionId: setSectionId,
      parentId: setParentId,
      isPassive: setIsPassive,
      preferredTimeOfDay: setPreferredTimeOfDay,
      earliestDate: setEarliestDate,
      enforceDueDate: setEnforceDueDate,
      fixedTime: setFixedTime,
      fixedTimeEnabled: setFixedTimeEnabled,
    };
    const localValues = {
      estimatedHours,
      priority,
      dueDate,
      isRecurring,
      recurrenceCount,
      recurrenceUnit,
      projectId,
      sectionId,
      parentId,
      isPassive,
      preferredTimeOfDay,
      earliestDate,
      enforceDueDate,
      fixedTime,
      fixedTimeEnabled,
    };
    Object.keys(taskValues).forEach((key) => {
      if (String(localValues[key]) === String(snap[key]) && String(taskValues[key]) !== String(snap[key])) {
        setters[key](taskValues[key]);
        snap[key] = taskValues[key];
        pushedCorrection = true;
      }
    });
    const taskRecurrenceDays = rule.days || null;
    if (jsonArrayEq(recurrenceDays, snap.recurrenceDays) && !jsonArrayEq(taskRecurrenceDays, snap.recurrenceDays)) {
      setRecurrenceDays(taskRecurrenceDays);
      snap.recurrenceDays = taskRecurrenceDays;
      pushedCorrection = true;
    }
    const taskDependsOn = task.dependsOn || [];
    if (jsonArrayEq(dependsOn, snap.dependsOn) && !jsonArrayEq(taskDependsOn, snap.dependsOn)) {
      setDependsOn(taskDependsOn);
      snap.dependsOn = taskDependsOn;
      pushedCorrection = true;
    }
    const taskLabelIds = task.labelIds || [];
    if (jsonArrayEq(labelIds, snap.labelIds) && !jsonArrayEq(taskLabelIds, snap.labelIds)) {
      setLabelIds(taskLabelIds);
      snap.labelIds = taskLabelIds;
      pushedCorrection = true;
    }
    if (isOwnCommit && pushedCorrection) suppressNextAutoSaveRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  // Direct children only (one level) — a grandchild is reached by opening
  // its own parent's nested TaskDetailModal in turn, not shown flattened here.
  // (SubtaskList recomputes its own copy for rendering the list itself —
  // this one stays here because isContainer/effectiveEstimatedHours and the
  // hierarchy label below all need it too.)
  const childTasks = useMemo(() => tasks.filter((t) => t.parentId === task.id), [tasks, task.id]);
  // This task's own parent, if any — drives the hierarchy label in the
  // header. Only one level is looked up here; if that parent itself has a
  // parent, navigating to it re-renders this same label against the new
  // `task`, so an arbitrarily deep chain is walked one hop at a time.
  const parentTask = task.parentId ? tasks.find((t) => t.id === task.parentId) || null : null;
  // Once a task has ≥1 sub-task it becomes schedule-container-only (see
  // rebalanceEngine.js) — its own estimatedHours/remainingHours stop being
  // directly editable and become a live rollup of its children's instead.
  const isContainer = childTasks.length > 0;
  // Count of the last 7 days' completions for a recurring task, from the
  // trimmed `completedDates` list SchedulerContext.completeTask maintains.
  const recentCompletionCount = useMemo(() => {
    if (!task.isRecurring || !task.completedDates?.length) return 0;
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 6);
    const cutoffISO = toISODate(cutoff);
    return task.completedDates.filter((d) => d >= cutoffISO).length;
  }, [task.isRecurring, task.completedDates]);
  // "Done for today" for the header checkbox and inline sub-task rows — for a
  // recurring task this must check today's completedDates entry rather than
  // task.isCompleted (which recurring tasks never set true on a normal
  // completion; see SchedulerContext.completeTask), otherwise a sub-task
  // completed today re-opens showing as unchecked/completable again.
  const todayIso = useMemo(() => toISODate(new Date()), []);
  const isDoneForToday = isCompletedForCurrentOccurrence(task, todayIso);
  const effectiveEstimatedHours = useMemo(() => (isContainer ? getEffectiveEstimatedHours(task, tasks) : task.estimatedHours), [
    isContainer,
    task,
    tasks,
  ]);

  // "Time left" (see types/index.js's Task.remainingHoursOverride) — a manual
  // edit to how much work remains, which directly reduces the number the
  // scheduler places going forward. Read/write logic (including the
  // recurring per-occurrence override keying) lives in taskHierarchy.js so
  // TimerContext-driven actions (Stop, Mark as done) can reuse the exact same
  // rule instead of re-deriving it.
  const currentOccurrenceOriginalDate = task.isRecurring ? task.dueDate : null;
  const effectiveRemainingHours = useMemo(() => getEffectiveRemainingHoursForOccurrence(task), [
    task.isRecurring,
    task.estimatedHours,
    task.remainingHours,
    task.dueDate,
    task.remainingHoursOverride,
  ]);

  // Routes through setRemainingHoursWithBlockInference (SchedulerContext)
  // instead of a plain updateTask so a manual decrease/increase here also
  // infers which of this task's scheduled blocks that edit implies were
  // completed or un-completed — see taskHierarchy.js's
  // planBlockCompletionFromRemainingHoursEdit for the oldest-first (mark
  // done) / newest-first (un-mark, for a corrective increase) algorithm.
  function handleRemainingHoursChange(hours) {
    // Defense in depth — the UI already disables this field while a
    // dependency is incomplete (see DetailSidebar's hasIncompleteDependencies
    // prop); this stops it even if called some other way.
    if (incompleteDependencies.length > 0) return;
    if (task.isRecurring && !currentOccurrenceOriginalDate) return; // no due date yet — nothing to key the override by
    setRemainingHoursWithBlockInference(task, hours, taskScheduledBlocks);
  }

  // Sections belong to a project — once a project is chosen, only show
  // that project's sections (matching Todoist's own board picker).
  const availableSections = useMemo(
    () => sections.filter((s) => !projectId || s.projectId === projectId),
    [sections, projectId]
  );

  // Scheduled blocks for this task, oldest first — a task's hours can be
  // split across multiple days, so this can have more than one entry. For a
  // recurring task, every future occurrence gets its own block too (see
  // SchedulerContext.completeTask's recurring branch), so this is narrowed
  // to just the current occurrence's date instead of listing every occurrence
  // out to the scheduling horizon. That's normally the earliest block's date
  // (`sorted[0]`), EXCEPT when the current occurrence was moved off-pattern
  // (see resolveCurrentOccurrenceDueDate) — its block is placed on the
  // moved-to date, which can sort after an older, not-yet-rebalanced block
  // for a prior occurrence still sitting in `blocks`. Preferring the resolved
  // due date (falling back to the earliest block, e.g. before any rebalance
  // has run yet) keeps this in agreement with the due-date field above rather
  // than trusting sort order alone.
  const taskScheduledBlocks = useMemo(() => {
    const sorted = blocks
      .filter((b) => b.taskId === task.id)
      .sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
    if (!task.isRecurring || sorted.length === 0) return sorted;
    const currentOccurrenceDate = resolveCurrentOccurrenceDueDate(task);
    const targetDate = sorted.some((b) => b.date === currentOccurrenceDate) ? currentOccurrenceDate : sorted[0].date;
    return sorted.filter((b) => b.date === targetDate);
  }, [blocks, task.id, task.isRecurring, task.dueDate, task.overrides]);

  function handleProjectChange(newProjectId) {
    setProjectId(newProjectId);
    // Changing project invalidates any section from the old project.
    if (sectionId && !sections.find((s) => s.id === sectionId && s.projectId === newProjectId)) {
      setSectionId('');
    }
  }

  // Stable reference (getOrCreateLabelIds itself is already useCallback'd in
  // SchedulerContext) so LabelPicker's React.memo isn't defeated by a fresh
  // inline function every render.
  const handleCreateLabel = useCallback((name) => getOrCreateLabelIds([name])[0], [getOrCreateLabelIds]);

  // Smart-parse: a field only counts as "safe to auto-fill" while it still
  // matches the value the task loaded with — the moment the user directly
  // touches that field's own widget it stops being "untouched" and smart
  // parse leaves it alone (same idea as handleNotesBlur's hours check below).
  // Every field's own apply() moves its state away from the task's original
  // value, which would otherwise permanently look "touched" after the first
  // successful parse and block re-parsing on later edits (e.g. typing
  // "tomorrow" then continuing to type would instantly lock dueDate). Each
  // lastSmart*Ref below tracks the last value smart-parse itself set, so the
  // field still counts as untouched until the user edits that field's own
  // widget directly, at which point it genuinely diverges from both values.
  const lastSmartEstimatedHoursRef = useRef(null);
  const lastSmartLinkRef = useRef(null);
  const lastSmartDueDateRef = useRef(null);
  const lastSmartRecurrenceRef = useRef(null);
  const lastSmartPriorityRef = useRef(null);
  const lastSmartUnattendedRef = useRef(null);
  const lastSmartEnforceDueDateRef = useRef(null);
  const lastSmartEarliestDateRef = useRef(null);
  const lastSmartProjectRef = useRef(null);
  const lastSmartDependencyIdRef = useRef(null);
  // { appliedUid, previousUid } | null — unlike the other refs above (which
  // just remember "the last value smart-parse itself set"), assignedTo has no
  // local draft state to compare against (it's written straight to Firestore
  // via updateTask, same as the three-dot "Assign to" menu — see that menu's
  // own chooseAssignee), so revert() needs the PRIOR value too, not just null,
  // to avoid clobbering a pre-existing assignment that had nothing to do with
  // smart-parse (mirrors how the dependency field's revert only removes the
  // one id it added, never resets the whole list).
  const lastSmartAssignedToRef = useRef(null);
  const {
    smartDetected,
    handleTitleChange: handleSmartTitleChange,
    dismissSmartChip,
    applySmartChipCandidate,
    buildFinalTitle,
    resetSmartState,
  } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
    // Only a shared task has anyone to assign to — an empty list here means
    // findAssignToPhrase (smartParse.js) never even attempts a match, same
    // gating every other "is this task shared" surface in this file uses.
    collaborators: isSharedTask ? assignableCollaborators : [],
    fields: {
      link: {
        isUntouched: () =>
          link === (task.link || '') || (lastSmartLinkRef.current !== null && link === lastSmartLinkRef.current),
        apply: (match) => {
          lastSmartLinkRef.current = match.url;
          setLink(match.url);
        },
        revert: () => {
          lastSmartLinkRef.current = null;
          setLink(task.link || '');
        },
      },
      dueDate: {
        isUntouched: () =>
          dueDate === (resolveCurrentOccurrenceDueDate(task) || '') ||
          (lastSmartDueDateRef.current !== null && dueDate === lastSmartDueDateRef.current),
        apply: (match) => {
          lastSmartDueDateRef.current = match.iso;
          setDueDate(match.iso);
        },
        revert: () => {
          lastSmartDueDateRef.current = null;
          setDueDate(resolveCurrentOccurrenceDueDate(task) || '');
        },
      },
      fixedTime: {
        isUntouched: () => !hasEditedFixedTime,
        apply: (match) => {
          setFixedTime(match.time);
          setFixedTimeEnabled(true);
        },
        revert: () => {
          setFixedTime(task.fixedTime || '');
          setFixedTimeEnabled(!!task.fixedTime);
        },
      },
      recurrence: {
        isUntouched: () =>
          isRecurring === !!task.isRecurring ||
          (lastSmartRecurrenceRef.current !== null && isRecurring === lastSmartRecurrenceRef.current),
        apply: (match, detected) => {
          lastSmartRecurrenceRef.current = true;
          setIsRecurring(true);
          setRecurrenceCount(match.rule.count);
          setRecurrenceUnit(match.rule.unit);
          setRecurrenceDays(match.rule.days || null);
          // Default to today only if today actually satisfies the
          // just-detected rule — "every friday" typed on a Thursday must
          // anchor on the next Friday, or the task's first occurrence would
          // fall on a day the rule doesn't match. See AddTaskModal's
          // matching fix for the same bug on task creation.
          if (!dueDate && !detected.dueDate) {
            const recurrenceString = buildRecurrenceString(match.rule.count, match.rule.unit, match.rule.days || null);
            setDueDate(computeFirstMatchingDueDate(toISODate(new Date()), recurrenceString));
          }
        },
        revert: () => {
          lastSmartRecurrenceRef.current = null;
          setIsRecurring(!!task.isRecurring);
          const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
          setRecurrenceCount(rule.count);
          setRecurrenceUnit(rule.unit);
          setRecurrenceDays(rule.days || null);
        },
      },
      priority: {
        isUntouched: () =>
          priority === task.priority || (lastSmartPriorityRef.current !== null && priority === lastSmartPriorityRef.current),
        apply: (match) => {
          lastSmartPriorityRef.current = match.level;
          setPriority(match.level);
        },
        revert: () => {
          lastSmartPriorityRef.current = null;
          setPriority(task.priority);
        },
      },
      estimatedHours: {
        // Smart parse's own apply() moves estimatedHours away from
        // task.estimatedHours, which would otherwise permanently look
        // "touched" and block re-parsing later edits to the duration phrase
        // (e.g. "5 min" -> "50 min"). Track the last value *we* set so it
        // still counts as untouched until the user edits the Duration field
        // itself, at which point it genuinely diverges from both values.
        isUntouched: () =>
          Number(estimatedHours) === Number(task.estimatedHours) ||
          (lastSmartEstimatedHoursRef.current !== null && Number(estimatedHours) === Number(lastSmartEstimatedHoursRef.current)),
        apply: (match) => {
          lastSmartEstimatedHoursRef.current = match.hours;
          setEstimatedHours(match.hours);
        },
        revert: () => {
          lastSmartEstimatedHoursRef.current = null;
          setEstimatedHours(task.estimatedHours);
        },
      },
      unattended: {
        isUntouched: () =>
          isPassive === !!task.isPassive || (lastSmartUnattendedRef.current !== null && isPassive === lastSmartUnattendedRef.current),
        apply: () => {
          lastSmartUnattendedRef.current = true;
          setIsPassive(true);
        },
        revert: () => {
          lastSmartUnattendedRef.current = null;
          setIsPassive(!!task.isPassive);
        },
      },
      enforceDueDate: {
        isUntouched: () =>
          enforceDueDate === !!task.enforceDueDate ||
          (lastSmartEnforceDueDateRef.current !== null && enforceDueDate === lastSmartEnforceDueDateRef.current),
        apply: (match, detected) => {
          lastSmartEnforceDueDateRef.current = true;
          setEnforceDueDate(true);
          // "Enforce due date" is inert without a due date — commitChanges
          // below persists `enforceDueDate: enforceDueDate && !!nextDueDate`,
          // so applying the flag alone (with no due date set) gets silently
          // zeroed back to false on the next autosave, which then echoes
          // back through the sync effect above and instantly un-checks the
          // box the user just saw get checked. Set one, same as recurrence.
          if (!dueDate && !detected.dueDate) setDueDate(toISODate(new Date()));
        },
        revert: () => {
          lastSmartEnforceDueDateRef.current = null;
          setEnforceDueDate(!!task.enforceDueDate);
        },
      },
      earliestDate: {
        isUntouched: () =>
          earliestDate === (task.earliestDate || '') ||
          (lastSmartEarliestDateRef.current !== null && earliestDate === lastSmartEarliestDateRef.current),
        apply: (match) => {
          lastSmartEarliestDateRef.current = match.iso;
          setEarliestDate(match.iso);
        },
        revert: () => {
          lastSmartEarliestDateRef.current = null;
          setEarliestDate(task.earliestDate || '');
        },
      },
      dependency: {
        isUntouched: () =>
          (dependsOn.length === (task.dependsOn || []).length && dependsOn.every((id) => (task.dependsOn || []).includes(id))) ||
          (lastSmartDependencyIdRef.current !== null && dependsOn.includes(lastSmartDependencyIdRef.current)),
        apply: (match) => {
          if (match.task) {
            lastSmartDependencyIdRef.current = match.task.id;
            setDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
          }
        },
        revert: (entry) => {
          if (entry.task) {
            if (lastSmartDependencyIdRef.current === entry.task.id) lastSmartDependencyIdRef.current = null;
            setDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
          }
        },
      },
      subOf: {
        isUntouched: () => smartParentTaskId === null,
        apply: (match) => {
          if (!match.task) return;
          // Invalid target (would create a cycle, or is already at max
          // sub-task depth) — behave like no match, never silently apply.
          if (getIneligibleParentIds(task.id, tasks).has(match.task.id)) return;
          setSmartParentTaskId(match.task.id);
        },
        revert: () => setSmartParentTaskId(null),
      },
      // Inverse of subOf above — a bare "unsubtask" mention (no task name to
      // resolve, see smartParse.js's findUnsubtaskPhrase) clears the parent
      // instead of setting one. Only meaningful when this task actually has a
      // parent to remove (matching the explicit "Remove from parent task"
      // button, which is itself only shown when task.parentId is set) — with
      // no parent, treat it as a no-op rather than arming a chip for nothing.
      unsubtask: {
        isUntouched: () => smartParentTaskId === null,
        apply: () => {
          if (!parentId) return;
          setSmartParentTaskId(UNSUBTASK_DRAFT);
        },
        revert: () => setSmartParentTaskId(null),
      },
      // Unlike every other field here, this writes straight to Firestore via
      // updateTask (same as the three-dot "Assign to" menu) rather than local
      // draft state committed on Save — assignedTo was never part of this
      // modal's draft/autosave lifecycle to begin with (see that menu's own
      // chooseAssignee), and folding it in now would mean touching the
      // fragile isDirty/initialSnapshotRef machinery below for a field that
      // already has its own, simpler, immediate-write precedent.
      assignTo: {
        isUntouched: () =>
          lastSmartAssignedToRef.current === null || task.assignedTo === lastSmartAssignedToRef.current.appliedUid,
        apply: (match) => {
          // Defense in depth — the three-dot menu's own Assign-to buttons are
          // disabled the same way; a viewer has no write access to the task
          // document at all, so this would just fail against firestore.rules.
          if (isReadOnlyViewer || !match.collaborator || match.collaborator.uid === (task.assignedTo || null)) return;
          lastSmartAssignedToRef.current = { appliedUid: match.collaborator.uid, previousUid: task.assignedTo || null };
          updateTask(task.id, { assignedTo: match.collaborator.uid });
        },
        revert: () => {
          if (lastSmartAssignedToRef.current) {
            updateTask(task.id, { assignedTo: lastSmartAssignedToRef.current.previousUid });
            lastSmartAssignedToRef.current = null;
          }
        },
      },
      project: {
        isUntouched: () =>
          projectId === (task.projectId || '') ||
          (lastSmartProjectRef.current !== null && projectId === lastSmartProjectRef.current),
        apply: (match) => {
          if (match.project) {
            lastSmartProjectRef.current = match.project.id;
            handleProjectChange(match.project.id);
          }
          if (match.section && !hasEditedSection) setSectionId(match.section.id);
        },
        revert: () => {
          lastSmartProjectRef.current = null;
          handleProjectChange(task.projectId || '');
          if (!hasEditedSection) setSectionId(task.sectionId || '');
        },
      },
      // Standalone "%section" shorthand — shares `project`'s own touch-guard
      // (both write to the same projectId/sectionId state) rather than
      // tracking a separate lastSmart*Ref, since the two triggers are
      // interchangeable from the field's point of view. An ambiguous match
      // (match.candidates non-empty) is left alone here; it's resolved later
      // via applySmartChipCandidate once the user picks a candidate from the
      // chip's disambiguation popover.
      sectionShorthand: {
        isUntouched: () =>
          projectId === (task.projectId || '') ||
          (lastSmartProjectRef.current !== null && projectId === lastSmartProjectRef.current),
        apply: (match) => {
          if (match.section) {
            lastSmartProjectRef.current = match.project.id;
            handleProjectChange(match.project.id);
            if (!hasEditedSection) setSectionId(match.section.id);
          }
        },
        revert: () => {
          lastSmartProjectRef.current = null;
          handleProjectChange(task.projectId || '');
          if (!hasEditedSection) setSectionId(task.sectionId || '');
        },
      },
    },
  });

  function handleTitleChange(value) {
    setTitle(value);
    handleSmartTitleChange(value);
  }

  // Commits the free-text repeat edit (see Repeat DetailField below) by
  // running it through the same phrase parser the title field's smart-parse
  // uses — reusing that parser instead of a bespoke day/unit picker for the
  // day-specific case, since the text already spells out the days. Leaves
  // the previous rule untouched if the text doesn't parse, rather than
  // silently clearing the repeat.
  function commitRepeatEditText() {
    const match = findRecurrencePhrase(repeatEditText || '');
    if (match) {
      setRecurrenceCount(match.rule.count);
      setRecurrenceUnit(match.rule.unit);
      setRecurrenceDays(match.rule.days || null);
    }
    setRepeatEditText(null);
  }

  const smartChips = useMemo(() => buildSmartChips(smartDetected), [smartDetected]);

  // Drives the inline Save/Cancel row rendered under the description
  // (Todoist-style, replacing a permanent footer) — only worth showing once
  // something in the form actually differs from the last-saved snapshot.
  // Split into "main content" (title/link/notes — the free-text area that
  // genuinely benefits from an explicit Save/Cancel step) vs "sidebar"
  // (every other field — Project, Date, Priority, Labels, Estimated hours,
  // Repeat, and the "..." menu's Depends on/Lock/Enforce/Unattended). Only
  // mainDirty gates the visible Save/Cancel row below; sidebarDirty instead
  // drives a debounced auto-save effect (see below) since those fields
  // don't need explicit confirmation — a stray click into a select/date
  // picker shouldn't need a follow-up "Save" click to actually stick.
  const mainDirty =
    title !== initialSnapshotRef.current.title ||
    link !== initialSnapshotRef.current.link ||
    notes !== initialSnapshotRef.current.notes;
  // Note: a pending "@label" chip doesn't need its own dirty clause —
  // detecting one requires the title to contain that "@tag" text, which the
  // `title !== ...` check above already catches (labels aren't stripped out
  // of `title` until buildFinalTitle runs at save time).
  const sidebarDirty =
    String(estimatedHours) !== String(initialSnapshotRef.current.estimatedHours) ||
    priority !== initialSnapshotRef.current.priority ||
    dueDate !== initialSnapshotRef.current.dueDate ||
    isRecurring !== initialSnapshotRef.current.isRecurring ||
    recurrenceCount !== initialSnapshotRef.current.recurrenceCount ||
    recurrenceUnit !== initialSnapshotRef.current.recurrenceUnit ||
    !jsonArrayEq(recurrenceDays, initialSnapshotRef.current.recurrenceDays) ||
    projectId !== initialSnapshotRef.current.projectId ||
    sectionId !== initialSnapshotRef.current.sectionId ||
    isPassive !== initialSnapshotRef.current.isPassive ||
    preferredTimeOfDay !== initialSnapshotRef.current.preferredTimeOfDay ||
    earliestDate !== initialSnapshotRef.current.earliestDate ||
    enforceDueDate !== initialSnapshotRef.current.enforceDueDate ||
    fixedTime !== initialSnapshotRef.current.fixedTime ||
    fixedTimeEnabled !== initialSnapshotRef.current.fixedTimeEnabled ||
    dependsOn.length !== initialSnapshotRef.current.dependsOn.length ||
    dependsOn.some((id) => !initialSnapshotRef.current.dependsOn.includes(id)) ||
    parentId !== initialSnapshotRef.current.parentId ||
    smartParentTaskId !== null ||
    labelIds.length !== initialSnapshotRef.current.labelIds.length ||
    labelIds.some((id) => !initialSnapshotRef.current.labelIds.includes(id));
  const isDirty = mainDirty || sidebarDirty;
  // Subset of sidebarDirty that's actually appliable to sub-tasks (mirrors
  // handleApplyToAllSubtasks' sharedUpdates) — excludes recurrence/
  // enforceDueDate/earliestDate/fixedTime*, which are dirty-tracked for the
  // sidebar auto-save but were deliberately dropped from the apply payload
  // (recurrence/enforceDueDate now sync automatically; the rest are
  // per-task-only, see that function's doc comment).
  const appliableSharedDirty =
    priority !== initialSnapshotRef.current.priority ||
    dueDate !== initialSnapshotRef.current.dueDate ||
    projectId !== initialSnapshotRef.current.projectId ||
    sectionId !== initialSnapshotRef.current.sectionId ||
    isPassive !== initialSnapshotRef.current.isPassive ||
    labelIds.length !== initialSnapshotRef.current.labelIds.length ||
    labelIds.some((id) => !initialSnapshotRef.current.labelIds.includes(id));
  if (appliableSharedDirty) {
    hasEditedSharedFieldsRef.current = true;
  }
  // Clears justAppliedToAll the moment an appliable field changes again
  // after a successful apply, so the button reappears only once there's
  // something new to (re-)apply. Runs as an effect (not inline during
  // render, like hasEditedSharedFieldsRef.current above) because unlike that
  // ref mutation, this is a state update — doing it unconditionally in the
  // render body re-triggers on every render while appliableSharedDirty stays
  // true (e.g. while typing into a debounced field), which is a React
  // "Maximum update depth exceeded" render loop.
  useEffect(() => {
    if (appliableSharedDirty) setJustAppliedToAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliableSharedDirty]);
  // These four gates used to be inline `const` expressions computed straight
  // from this component's own local state — now standalone pure functions in
  // utils/taskValidation.js (see that file's header comment) so the bulk-edit
  // engine (utils/bulkEditEngine.js) can run the exact same checks per
  // selected item, not just against this modal's own form state. Behavior
  // here is unchanged; only the implementation moved.
  //
  // Checking "Fixed time" with no time chosen yet is an incomplete edit —
  // block it from silently autosaving (or from the explicit Save button)
  // until a time is actually picked.
  const fixedTimeError = computeFixedTimeError(fixedTimeEnabled, fixedTime);
  // A sub-task's own due date can never be later than its nearest dated
  // ancestor's — that ancestor's due date is the hard "finish everything
  // toward this goal by this day" deadline (see allocator.js's
  // resolveDueDate/getTaskWindow); a step scheduled past its own goal's
  // deadline would never be able to actually finish the goal on time. Only
  // meaningful when the ancestor chain actually has a due date somewhere —
  // an undated parent imposes no ceiling at all (the sub-task is free to use
  // whatever due date it likes, or none).
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const dueDateError = useMemo(() => computeDueDateError(task, dueDate, tasksById), [task, dueDate, tasksById]);
  // Is this task's enforceDueDate being forced on by an ancestor (see
  // computeEnforceDueDateSyncUpdates)? If so, the checkbox below is disabled
  // rather than letting the user uncheck it only to have it silently snap
  // back true on the next sync.
  const enforcingAncestor = useMemo(() => computeEnforcingAncestor(task, tasksById), [task, tasksById]);
  // Recurring tasks are scheduled off their due date advancing each
  // occurrence (see completeTask/computeNextDueDate) — a recurring task with
  // no due date has nothing to advance from, so clearing it here would leave
  // the task in a state the rest of the app doesn't know how to handle.
  // Blocks the clear the same way fixedTimeError/dueDateError block an
  // incomplete edit, rather than silently turning isRecurring off (which is
  // what commitChanges' `isRecurring && !!nextDueDate` used to do).
  const dueDateRequiredError = computeDueDateRequiredError(isRecurring, dueDate);

  function handleNotesChange(value) {
    setNotes(value);
    setNotesLinkMatches((prev) => mergeNoteLinks(value, prev));
  }

  function handleNotesBlur() {
    const nextNotes = stripNotesLinks(notes);
    setNotes(nextNotes);
    setNotesLinkMatches((prev) => mergeNoteLinks(notes, prev));
    // Convenience: if the user typed a duration hint into the notes (e.g.
    // "30 minutes" or "1.5 hours") and hasn't touched the hours field
    // manually since opening, offer the parsed value.
    const parsed = parseDurationHours(nextNotes);
    if (parsed && parsed !== estimatedHours && estimatedHours === task.estimatedHours) {
      setEstimatedHours(parsed);
    }
  }

  function dismissNotesLink(match) {
    const nextNotes = stripMatchedText(notes, match.matchedText);
    setNotes(nextNotes);
    setNotesLinkMatches((prev) => prev.filter((item) => item.matchedText !== match.matchedText));
  }

  function renderHighlightedNotesText(text) {
    if (!isNotesFocused || !text) return null;
    const matches = notesLinkMatches.filter((match) => typeof match.index === 'number');
    if (!matches.length) return text;

    const parts = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.index > cursor) parts.push(text.slice(cursor, match.index));
      parts.push(
        <mark key={`${match.matchedText}-${index}`} className="smart-notes-mark">
          {match.matchedText}
        </mark>
      );
      cursor = match.index + match.matchedText.length;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }

  /**
   * Builds the update payload from current form state and pushes it via
   * updateTask, then refreshes the snapshot so isDirty recomputes back to
   * false against these just-saved values. Shared by the explicit Save
   * button (which also closes the modal) and the sidebar auto-save effect
   * below (which doesn't).
   */
  function commitChanges() {
    const section = sections.find((s) => s.id === sectionId);
    const nextDueDate = dueDate || null;
    const nextIsRecurring = isRecurring && !!nextDueDate;
    const nextRecurrenceString = isRecurring && nextDueDate ? buildRecurrenceString(recurrenceCount, recurrenceUnit, recurrenceDays) : null;
    const nextNotes = stripNotesLinks(notes);

    // Resolve any still-pending "@tag" mentions to real Label ids now,
    // merging with whatever was already picked via the sidebar's LabelPicker.
    const pendingLabelNames = (smartDetected.labels || []).map((m) => m.name);
    const finalLabelIds = [...new Set([...labelIds, ...(pendingLabelNames.length ? getOrCreateLabelIds(pendingLabelNames) : [])])];

    const nextEstimatedHours = Number(estimatedHours) || task.estimatedHours;

    const nextTitle = buildFinalTitle(title, link ? linkLabel(link) : task.title);

    // Resolve the smart-parse parent draft (if any) — a real matched task id
    // from "sub of X" applies directly, while the UNSUBTASK_DRAFT sentinel
    // from a bare "unsubtask" mention resolves to null (see fields.unsubtask
    // and smartParentTaskId's own doc comment above).
    const resolvedSmartParentId = smartParentTaskId === UNSUBTASK_DRAFT ? null : smartParentTaskId;

    updateTask(task.id, {
      // If the title was nothing but a smart-parsed link, stripping it
      // leaves an empty string — fall back to the link's hostname rather
      // than a blank/raw-URL title.
      title: nextTitle,
      link: link || null,
      notes: nextNotes,
      // Persist the detected link phrases alongside the (now-stripped) notes
      // text — otherwise a reload has nothing left to re-detect them from
      // (see getInitialNoteLinks above).
      noteLinks: notesLinkMatches.map(({ url, matchedText }) => ({ url, matchedText })),
      // A container task's estimatedHours/remainingHours are a computed
      // rollup of its children (see isContainer/effectiveEstimatedHours
      // above), not a directly-editable value — the Estimated time field is
      // disabled for one below, but skip persisting this here too as a
      // second guard against ever writing a stale independent number onto
      // it (e.g. via a smart-parsed duration phrase in the title).
      // remainingHours itself is left for SchedulerContext's updateTask to
      // derive from the estimatedHours delta (see
      // deriveRemainingHoursOnEstimateChange) — every caller gets correct
      // shifting behavior for free rather than replicating the formula here.
      ...(isContainer ? {} : { estimatedHours: nextEstimatedHours }),
      priority,
      dueDate: nextDueDate,
      isRecurring: nextIsRecurring,
      recurrenceString: nextRecurrenceString,
      projectId: projectId || null,
      sectionId: sectionId || null,
      sectionName: section ? section.name : null,
      dependsOn,
      // Only override parentId if smart-parse actually produced a draft
      // parent this session — otherwise fall back to this modal's own local
      // parentId state, NOT task.parentId read live off the prop. Reading the
      // prop here used to be a stale-closure bug: this function can run up to
      // 500ms after the debounce effect scheduled it (see that effect below),
      // and if a direct reparent action (the "move to" popover, "Remove from
      // parent task") landed via its own updateTask call in the meantime, the
      // closure captured at schedule-time still held the OLD task.parentId —
      // silently reasserting it and undoing the direct action. Local state
      // doesn't have that problem: both direct-reparent call sites update it
      // synchronously, so whatever this function reads here (however late it
      // actually runs) is always the value the user most recently asked for.
      parentId: smartParentTaskId !== null ? resolvedSmartParentId : parentId,
      isPassive,
      // Written as null rather than '' when cleared, so an unset preference
      // carries no value at all (see placementCost's zero-cost path).
      preferredTimeOfDay: preferredTimeOfDay || null,
      earliestDate: earliestDate || null,
      // Only meaningful once a due date exists — clear it rather than
      // persisting a flag that has nothing to enforce.
      enforceDueDate: enforceDueDate && !!nextDueDate,
      // A container is never scheduled directly, so a fixed time-of-day has
      // nothing to apply to — skip persisting it, same guard as
      // estimatedHours/remainingHours above.
      fixedTime: isContainer ? null : fixedTimeEnabled && fixedTime ? fixedTime : null,
      labelIds: finalLabelIds,
    });
    // The next "pull in external change" effect pass (below) is a direct
    // reaction to the updateTask call just above — mark it so that effect can
    // tell a cascade side-effect of THIS save apart from a genuinely new
    // external change, and suppress the debounce effect's next re-arm if it
    // ends up correcting anything (see isReconcilingOwnCommitRef's doc
    // comment above, and the "self-re-arming loop" note on the debounce
    // effect below).
    isReconcilingOwnCommitRef.current = true;

    // Sync local title/label state to what was just persisted, and clear
    // smart-parse detection state. Without the setLabelIds call, a label
    // resolved from a pending "@tag" (getOrCreateLabelIds, above) exists in
    // finalLabelIds/the saved task but never makes it into the live
    // `labelIds` state — so the very next auto-save tick (the sidebar
    // effect below, or a Cancel) reverts the task back to its pre-save
    // labelIds and silently drops the just-created label. Title needs the
    // same sync so re-entering edit (e.g. via the sidebar auto-save path,
    // which doesn't close the modal) doesn't keep showing the raw pre-strip
    // text with stale link highlighting.
    setTitle(nextTitle);
    setLabelIds(finalLabelIds);
    // The draft parent (if any) is now baked into local parentId state itself
    // — mirrors labelIds just above (a pending draft is folded into the
    // "real" tracked field once committed) — then clear the smart-parse draft
    // so isUntouched() goes back to true instead of staying permanently
    // blocked against re-applying a later "sub of" edit.
    if (smartParentTaskId !== null) setParentId(resolvedSmartParentId);
    setSmartParentTaskId(null);
    resetSmartState();

    initialSnapshotRef.current = {
      title: nextTitle,
      link: link || '',
      notes: nextNotes,
      estimatedHours: nextEstimatedHours,
      priority,
      dueDate: nextDueDate || '',
      isRecurring: nextIsRecurring,
      recurrenceCount,
      recurrenceUnit,
      recurrenceDays,
      projectId: projectId || '',
      sectionId: sectionId || '',
      dependsOn,
      parentId: smartParentTaskId !== null ? resolvedSmartParentId : parentId,
      isPassive,
      preferredTimeOfDay,
      earliestDate: earliestDate || '',
      enforceDueDate: enforceDueDate && !!nextDueDate,
      fixedTime: fixedTime || '',
      fixedTimeEnabled,
      labelIds: finalLabelIds,
    };
  }

  function handleSave() {
    // "Fixed time" enabled with no time picked blocks the explicit Save too
    // (mirrors AddTaskModal's handleSubmit) — the sidebar autosave effect
    // below already blocks its own debounced commit the same way, but the
    // Save/Cancel row is reachable whenever mainDirty is also true.
    if (fixedTimeError || dueDateError || dueDateRequiredError) return;
    commitChanges();
    // Deliberately does NOT close the modal — per user preference, Save
    // just commits and leaves the task open; Escape (or the close button)
    // is how the user dismisses it when they're done.
  }

  /**
   * Cascades this (container) task's shared fields — priority, due
   * date/enforcement, project/section, labels, and passive flag — down onto
   * every descendant sub-task (direct and nested, see getAllDescendants).
   * Only offered when the task actually has sub-tasks (isContainer) AND the
   * user has edited one of these shared fields at some point this modal
   * session (hasEditedSharedFieldsRef, driven by appliableSharedDirty above
   * — deliberately narrower than isDirty/sidebarDirty so e.g. editing just
   * the title doesn't surface a button that has nothing to apply) AND the
   * button hasn't just been clicked with nothing new to apply since
   * (justAppliedToAll) — see the Save row below, which hides the button
   * otherwise. isContainer re-hides it the moment the last sub-task is
   * removed (recomputed from the live `tasks` list each render);
   * hasEditedSharedFieldsRef only resets when the modal switches to a
   * different task, NOT on every sidebar auto-save — sidebar fields
   * debounce-save ~500ms after each edit (see the auto-save effect below),
   * which resets initialSnapshotRef/isDirty back to false, but the button
   * should stay available for the rest of the session rather than flash and
   * disappear right after the edit that triggered it. justAppliedToAll is
   * the exception: it resets back to false the moment an appliable field
   * changes again (see appliableSharedDirty above), so the button reappears
   * only once there's something new to apply.
   *
   * Deliberately excludes title/notes/estimatedHours/dependsOn/fixedTime —
   * those are meant to stay per-task (a shared title would collide, a shared
   * dependsOn would create nonsensical self-references, hours are each
   * sub-task's own real work estimate). dueDate IS included: a descendant's
   * own due date is still capped at its nearest dated ancestor's (enforced
   * in commitChanges' dueDateError above) — applying the container's own due
   * date can never violate that, since the container IS that ancestor.
   *
   * Recurrence and enforceDueDate are deliberately NOT included here anymore:
   * parent/sub-task recurrence now stays consistent automatically (see
   * computeRecurrenceSyncUpdates, wired into SchedulerContext's
   * addTask/updateTask) the moment either side's recurrence changes, and
   * enforceDueDate does the same (see computeEnforceDueDateSyncUpdates) the
   * moment an ancestor's enforcement or due date changes — so a manual copy
   * step for either would be redundant.
   */
  function handleApplyToAllSubtasks() {
    const descendants = getAllDescendants(task.id, tasks);
    if (descendants.length === 0) return;
    const sharedUpdates = {
      priority,
      dueDate: dueDate || null,
      projectId: projectId || null,
      sectionId: sectionId || null,
      labelIds,
      isPassive,
    };
    descendants.forEach((d) => updateTask(d.id, sharedUpdates));
    setNotification({
      type: 'success',
      message: `Applied to ${descendants.length} sub-task${descendants.length === 1 ? '' : 's'}.`,
    });
    setJustAppliedToAll(true);
  }

  // Sidebar fields auto-save (debounced) without needing the explicit
  // Save/Cancel row — that row is reserved for mainDirty (title/notes)
  // below. Skips entirely while mainDirty is also true, since in that case
  // Save/Cancel is already visible and will commit both together. Also skips
  // while fixedTimeError or dueDateError is set, so an enabled-but-empty
  // "Fixed time" or a due date past the parent goal's deadline never
  // silently autosaves.
  //
  // SELF-RE-ARMING LOOP GUARD: this effect's own dependency list includes the
  // raw field values (dueDate, recurrenceCount, ...), not just the derived
  // sidebarDirty — so it re-evaluates any time the "pull in external change"
  // effect (above) pushes a correction into one of them, even if that
  // correction resolves sidebarDirty back to false in the same pass. Most of
  // the time that's harmless (sidebarDirty is false, so the guard below
  // returns early regardless) — but if the cascade behind that correction
  // left a DIFFERENT field genuinely dirty against commitChanges' own
  // pre-cascade snapshot, this would otherwise arm a fresh 500ms timer whose
  // eventual commitChanges() call re-triggers the same cascade, repeating
  // until it stabilizes. suppressNextAutoSaveRef (set by that effect only
  // when the correction was reconciling OUR OWN just-landed commit, not a
  // genuinely new external change) short-circuits exactly that one re-arm,
  // without blocking any later timer that arms because of real new user
  // input.
  useEffect(() => {
    if (suppressNextAutoSaveRef.current) {
      suppressNextAutoSaveRef.current = false;
      return undefined;
    }
    if (mainDirty || !sidebarDirty || fixedTimeError || dueDateError || dueDateRequiredError) return undefined;
    const handle = setTimeout(() => commitChanges(), 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mainDirty,
    sidebarDirty,
    fixedTimeError,
    dueDateError,
    dueDateRequiredError,
    estimatedHours,
    priority,
    dueDate,
    isRecurring,
    recurrenceCount,
    recurrenceUnit,
    recurrenceDays,
    projectId,
    sectionId,
    parentId,
    isPassive,
    earliestDate,
    enforceDueDate,
    fixedTime,
    fixedTimeEnabled,
    dependsOn,
    smartParentTaskId,
    labelIds,
  ]);

  function handleCancel() {
    const snap = initialSnapshotRef.current;
    setTitle(snap.title);
    setLink(snap.link);
    setNotes(snap.notes);
    setNotesLinkMatches(getInitialNoteLinks(task));
    setEstimatedHours(snap.estimatedHours);
    setPriority(snap.priority);
    setDueDate(snap.dueDate);
    setIsRecurring(snap.isRecurring);
    setRecurrenceCount(snap.recurrenceCount);
    setRecurrenceUnit(snap.recurrenceUnit);
    setRecurrenceDays(snap.recurrenceDays || null);
    setProjectId(snap.projectId);
    setSectionId(snap.sectionId);
    setHasEditedSection(false);
    setDependsOn(snap.dependsOn);
    setParentId(snap.parentId);
    setSmartParentTaskId(null);
    setIsPassive(snap.isPassive);
    setEarliestDate(snap.earliestDate);
    setEnforceDueDate(snap.enforceDueDate);
    setFixedTime(snap.fixedTime);
    setFixedTimeEnabled(snap.fixedTimeEnabled);
    setHasEditedFixedTime(false);
    setLabelIds(snap.labelIds);
    resetSmartState();
    lastSmartEstimatedHoursRef.current = null;
    lastSmartEarliestDateRef.current = null;
  }

  function handleDelete() {
    if (isReadOnlyViewer) return; // Defense in depth — menu item is already disabled for viewers.
    deleteTask(task.id);
    requestCloseRef.current();
  }

  return (
    <>
      <Modal onClose={onClose} ariaLabel="Task details" size="xl" variantClassName="modal-detail">
        {({ requestClose }) => {
          requestCloseRef.current = requestClose;
          return (
            <>
          <div className="detail-topbar">
            {/* Always rendered (not gated on having a parent/children) so the
                "move to" button is reachable from a plain standalone task too
                — only the breadcrumb text itself is conditional. */}
            <div className="detail-hierarchy">
              {parentTask ? (
                <>
                  <button
                    type="button"
                    className="detail-hierarchy-link"
                    onClick={() => setActiveTaskId(parentTask.id)}
                    title={`Open parent task: ${parentTask.title}`}
                  >
                    {parentTask.title}
                  </button>
                  <ChevronRight size={12} className="detail-hierarchy-sep" aria-hidden="true" />
                  <span className="detail-hierarchy-current">{task.title}</span>
                </>
              ) : childTasks.length > 0 ? (
                <span className="detail-hierarchy-current">
                  <Layers size={12} aria-hidden="true" />
                  {task.title}
                  <span className="detail-hierarchy-count">
                    {childTasks.length} sub-task{childTasks.length === 1 ? '' : 's'}
                  </span>
                </span>
              ) : null}
              <button
                type="button"
                ref={moveToTriggerRef}
                className="btn btn-icon detail-move-to-trigger"
                onClick={() => setMoveToOpen((v) => !v)}
                aria-haspopup="true"
                aria-expanded={moveToOpen}
                aria-label="Move to another task"
                title="Move to another task"
              >
                <FolderInput size={14} />
              </button>
              {moveToOpen &&
                createPortal(
                  <>
                    {moveToPopoverMode === 'centered' && (
                      <div className="menu-popover-backdrop" onClick={() => setMoveToOpen(false)} />
                    )}
                    <div
                      ref={moveToPopoverRef}
                      className={`detail-move-to-popover ${moveToPopoverMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      style={moveToPopoverMode === 'anchored' ? moveToPopoverStyle : undefined}
                    >
                      <input
                        type="text"
                        autoFocus
                        className="detail-move-to-input"
                        placeholder="Search tasks…"
                        value={moveToQuery}
                        onChange={(e) => setMoveToQuery(e.target.value)}
                        onKeyDown={handleMoveToKeyDown}
                      />
                      <div className="detail-move-to-list" ref={moveToListRef}>
                        {task.parentId && (
                          <button
                            type="button"
                            className="detail-move-to-item detail-move-to-item-none"
                            onClick={() => handleMoveToParent(null)}
                          >
                            None (make top-level task)
                          </button>
                        )}
                        {moveToCandidates.length === 0 ? (
                          <p className="detail-move-to-empty">No matching tasks.</p>
                        ) : (
                          moveToCandidates.map((t, i) => (
                            <button
                              type="button"
                              key={t.id}
                              className={`detail-move-to-item ${i === moveToActiveIndex ? 'active' : ''}`}
                              data-active={i === moveToActiveIndex}
                              onMouseEnter={() => setMoveToActiveIndex(i)}
                              onClick={() => handleMoveToParent(t.id)}
                            >
                              {t.title}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </>,
                  document.body
                )}
            </div>

            {!isContainer && (
              <div className="detail-timer-trigger-wrap">
                <button
                  type="button"
                  ref={timerTriggerRef}
                  className={`btn btn-icon timer-trigger ${getTimerForTask(task.id) ? 'is-active' : ''}`}
                  onClick={() => setTimerPopoverOpen((v) => !v)}
                  aria-haspopup="true"
                  aria-expanded={timerPopoverOpen}
                  aria-label="Timer"
                  title={
                    getTimerForTask(task.id)
                      ? getTimerForTask(task.id).status === 'running'
                        ? 'Timer running'
                        : 'Timer paused'
                      : 'Start timer'
                  }
                >
                  <Timer size={16} />
                </button>
                {timerPopoverOpen &&
                  createPortal(
                    <>
                      {timerPopoverMode === 'centered' && (
                        <div className="menu-popover-backdrop" onClick={() => setTimerPopoverOpen(false)} />
                      )}
                      <div
                        ref={timerPopoverRef}
                        className={`detail-timer-popover ${timerPopoverMode === 'centered' ? 'menu-popover-centered' : ''}`}
                        style={timerPopoverMode === 'anchored' ? timerPopoverStyle : undefined}
                      >
                        <TaskTimerControl
                          durationSeconds={getDefaultDurationSeconds({ ...task, estimatedHours })}
                          timer={getTimerForTask(task.id)}
                          onStart={(seconds) => {
                            if (!areDependenciesMet(task, taskById)) {
                              const blockers = (task.dependsOn || [])
                                .map((id) => taskById.get(id))
                                .filter((t) => t && !t.isCompleted)
                                .map((t) => t.title);
                              setNotification({
                                type: 'warning',
                                message:
                                  blockers.length > 0
                                    ? `Can't start the timer for "${task.title}" — finish "${blockers.join('", "')}" first.`
                                    : `Can't start the timer for "${task.title}" — its dependencies aren't done yet.`,
                              });
                              return;
                            }
                            startTimer(task, seconds);
                          }}
                          onPause={() => {
                            // Same elapsed-time math as CompleteTaskContext's
                            // own pending-completion prompt (including
                            // overtime) — offer to log it against "Time
                            // left" too, but only when it's enough to be
                            // worth a prompt (skip a near-instant pause with
                            // negligible elapsed time).
                            const runningTimer = getTimerForTask(task.id);
                            const elapsedSeconds = runningTimer ? Math.max(0, getSignedElapsedSeconds(runningTimer)) : 0;
                            const suggestedHours = elapsedSeconds / 3600;
                            pauseTimer(task.id);
                            setPauseLogPrompt(suggestedHours > 0.01 ? { suggestedHours } : null);
                          }}
                          onResume={() => {
                            setPauseLogPrompt(null);
                            resumeTimer(task.id);
                          }}
                          onStop={() => {
                            setPauseLogPrompt(null);
                            // Log elapsed (incl. overtime) against "Time
                            // left" before removing the timer — same rule
                            // TimerWidget's Stop button uses.
                            const runningTimer = getTimerForTask(task.id);
                            if (runningTimer) {
                              const elapsedHours = Math.max(0, getSignedElapsedSeconds(runningTimer)) / 3600;
                              const patch = computeRemainingHoursPatchAfterElapsed(task, elapsedHours);
                              if (patch) updateTask(task.id, patch);
                            }
                            stopTimer(task.id);
                          }}
                          onMarkDone={() => {
                            setPauseLogPrompt(null);
                            setTimerPopoverOpen(false);
                            // Routes through the normal completion flow
                            // (dependency checks, recurring handling, the
                            // elapsed-time confirmation) — it reads this
                            // timer's own elapsed time itself.
                            requestComplete(task.id);
                          }}
                        />
                        {pauseLogPrompt && (
                          <PauseLogPrompt
                            suggestedHours={pauseLogPrompt.suggestedHours}
                            effectiveRemainingHours={effectiveRemainingHours}
                            onApply={(loggedHours) => {
                              handleRemainingHoursChange(Math.max(0, effectiveRemainingHours - loggedHours));
                              setPauseLogPrompt(null);
                            }}
                            onDismiss={() => setPauseLogPrompt(null)}
                          />
                        )}
                      </div>
                    </>,
                    document.body
                  )}
              </div>
            )}

            <div className="detail-menu">
              <button
                type="button"
                ref={menuTriggerRef}
                className="btn btn-icon menu-trigger"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen &&
                createPortal(
                  <>
                    {menuMode === 'centered' && <div className="menu-popover-backdrop" onClick={() => setMenuOpen(false)} />}
                    <ul
                      ref={menuRef}
                      className={`detail-menu-dropdown ${menuMode === 'centered' ? 'menu-popover-centered' : ''}`}
                      role="menu"
                      style={menuMode === 'anchored' ? menuStyle : undefined}
                    >
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item"
                          onClick={() => {
                            toggleTaskLock(task.id);
                            setMenuOpen(false);
                          }}
                        >
                          {task.isLocked ? <Unlock size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
                          {task.isLocked ? 'Unlock' : 'Lock'}
                        </button>
                      </li>
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item"
                          onClick={() => {
                            updateTask(task.id, { excludeFromAutoSchedule: !task.excludeFromAutoSchedule });
                            setMenuOpen(false);
                          }}
                        >
                          <Ban size={14} aria-hidden="true" />
                          {task.excludeFromAutoSchedule ? 'Include in auto-schedule' : 'Exclude from auto-schedule'}
                        </button>
                      </li>
                      {isSharedTask && assignableCollaborators.length > 0 && (
                        <>
                          <li role="none" className="detail-menu-divider" />
                          <li role="none" className="detail-menu-section-label">
                            <UserPlus size={12} aria-hidden="true" />
                            Assign to
                          </li>
                          {/* Type-to-search replaces what used to be a flat button per
                              collaborator — that doesn't scale once a shared project's
                              member list grows. Mirrors the comment @-mention autocomplete's
                              filtering (filterMentionCandidates) and arrow-key/Enter
                              conventions, but renders as a plain in-flow list rather than a
                              floating popup: this already lives inside the "..." menu's own
                              portaled, scrollable dropdown, so a second nested popup would
                              just add positioning complexity for no benefit. */}
                          <li role="none" className="assign-to-search-row">
                            <div className="assign-to-search">
                              <Search size={13} aria-hidden="true" className="assign-to-search-icon" />
                              <input
                                type="text"
                                className="assign-to-search-input"
                                placeholder="Search collaborators…"
                                value={assignSearchQuery}
                                disabled={isReadOnlyViewer}
                                onChange={(e) => {
                                  setAssignSearchQuery(e.target.value);
                                  setAssignHighlight(0);
                                }}
                                onKeyDown={(e) => {
                                  // +1 to account for the synthetic "Unassigned" row pinned at index 0.
                                  const optionCount = assignSearchMatches.length + 1;
                                  if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setAssignHighlight((i) => Math.min(i + 1, optionCount - 1));
                                  } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setAssignHighlight((i) => Math.max(i - 1, 0));
                                  } else if (e.key === 'Enter') {
                                    e.preventDefault();
                                    if (assignHighlight === 0) chooseAssignee(null);
                                    else chooseAssignee(assignSearchMatches[assignHighlight - 1]);
                                  }
                                }}
                              />
                            </div>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              className={`detail-menu-item ${assignHighlight === 0 ? 'highlighted' : ''}`}
                              onClick={() => chooseAssignee(null)}
                              onMouseEnter={() => setAssignHighlight(0)}
                              disabled={isReadOnlyViewer}
                              title={isReadOnlyViewer ? "Viewers can't reassign tasks" : undefined}
                            >
                              <Check size={14} aria-hidden="true" style={{ visibility: task.assignedTo ? 'hidden' : 'visible' }} />
                              Unassigned
                            </button>
                          </li>
                          {assignSearchMatches.length === 0 ? (
                            <li role="none" className="assign-to-empty">No collaborators match "{assignSearchQuery}"</li>
                          ) : (
                            assignSearchMatches.map((c, i) => (
                              <li role="none" key={c.uid}>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className={`detail-menu-item ${assignHighlight === i + 1 ? 'highlighted' : ''}`}
                                  onClick={() => chooseAssignee(c)}
                                  onMouseEnter={() => setAssignHighlight(i + 1)}
                                  disabled={isReadOnlyViewer}
                                  title={isReadOnlyViewer ? "Viewers can't reassign tasks" : undefined}
                                >
                                  <Check
                                    size={14}
                                    aria-hidden="true"
                                    style={{ visibility: task.assignedTo === c.uid ? 'visible' : 'hidden' }}
                                  />
                                  {c.uid === user?.uid ? `${c.displayName} (you)` : c.displayName}
                                </button>
                              </li>
                            ))
                          )}
                        </>
                      )}
                      {task.parentId && (
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="detail-menu-item"
                            onClick={() => {
                              updateTask(task.id, { parentId: null });
                              // Same reasoning as handleMoveToParent(null) above
                              // — sync local state + snapshot immediately so a
                              // pending sidebar auto-save can't reassert the
                              // old parentId out from under this direct action.
                              setParentId(null);
                              setSmartParentTaskId(null);
                              if (initialSnapshotRef.current) initialSnapshotRef.current.parentId = null;
                              setMenuOpen(false);
                            }}
                          >
                            <CornerUpLeft size={14} aria-hidden="true" />
                            Remove from parent task
                          </button>
                        </li>
                      )}
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item detail-menu-item-danger"
                          onClick={handleDelete}
                          disabled={isReadOnlyViewer}
                          title={isReadOnlyViewer ? 'Viewers can\'t delete tasks' : undefined}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Delete
                        </button>
                      </li>
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item"
                          onClick={() => {
                            setShowSmartParseGuide(true);
                            setMenuOpen(false);
                          }}
                        >
                          <Sparkles size={14} aria-hidden="true" />
                          Smart parse guide
                        </button>
                      </li>

                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="detail-menu-item"
                          onClick={() => {
                            setShowSaveTemplate(true);
                            setMenuOpen(false);
                          }}
                        >
                          <FileStack size={14} aria-hidden="true" />
                          Save as template
                        </button>
                      </li>

                      <li role="none" className="detail-menu-divider" />

                      {dependencyOptions.length > 0 && (
                        <li role="none">
                          <DetailField
                            icon={Link2}
                            label="Depends on"
                            labelExtra={
                              <HelpTooltip label="What does this do?">
                                A blocked task can't be marked complete or auto-scheduled until every task it depends on is
                                done first.
                              </HelpTooltip>
                            }
                          >
                            <DependencyPicker options={dependencyOptions} selectedIds={dependsOn} onChange={setDependsOn} />
                          </DetailField>
                        </li>
                      )}

                      <li role="none">
                        <DetailField icon={CalendarX2} label="Lock to a day">
                          <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={!!earliestDate}
                              onChange={(e) => setEarliestDate(e.target.checked ? toISODate(new Date()) : '')}
                            />
                            {earliestDate ? formatDisplayDate(earliestDate) : 'Not locked'}
                          </label>
                          {earliestDate && (
                            <>
                              <input
                                type="date"
                                value={earliestDate}
                                onChange={(e) => setEarliestDate(e.target.value)}
                                style={{ marginTop: 6 }}
                              />
                              <p className="form-hint">The scheduler won't place blocks before this date, overriding its usual pacing.</p>
                            </>
                          )}
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={CalendarCheck} label="Enforce due date">
                          <label
                            className="form-checkbox-row"
                            style={{ cursor: dueDate && !enforcingAncestor ? 'pointer' : 'not-allowed' }}
                          >
                            <input
                              type="checkbox"
                              checked={enforceDueDate && !!dueDate}
                              disabled={!dueDate || !!enforcingAncestor}
                              onChange={(e) => setEnforceDueDate(e.target.checked)}
                            />
                            Must be done on due date
                          </label>
                          <p className="form-hint">
                            {enforcingAncestor
                              ? `Inherited from "${enforcingAncestor.title}" — that task must be done on its due date, so this sub-task is too.`
                              : dueDate
                              ? "Task won't be scheduled earlier — all remaining work is forced onto the due date."
                              : 'Set a due date first to enable this.'}
                          </p>
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={Clock} label="Fixed time">
                          <label className="form-checkbox-row" style={{ cursor: isContainer ? 'not-allowed' : 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={fixedTimeEnabled}
                              disabled={isContainer}
                              onChange={(e) => {
                                setHasEditedFixedTime(true);
                                setFixedTimeEnabled(e.target.checked);
                                if (!e.target.checked) setFixedTime('');
                              }}
                            />
                            {fixedTimeEnabled ? (fixedTime ? `At ${fixedTime}` : 'Pick a time') : 'Not fixed'}
                          </label>
                          {fixedTimeEnabled && !isContainer && (
                            <>
                              <input
                                type="time"
                                value={fixedTime}
                                onChange={(e) => {
                                  setHasEditedFixedTime(true);
                                  setFixedTime(e.target.value);
                                }}
                                style={{ marginTop: 6 }}
                              />
                              <p className="form-hint">Scheduled blocks for this task will always start at this time.</p>
                              {fixedTimeError && <p className="form-error">{fixedTimeError}</p>}
                            </>
                          )}
                          {isContainer && (
                            <p className="form-hint">
                              This task is never scheduled directly once it has sub-tasks — set a fixed time on the sub-task itself instead.
                            </p>
                          )}
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={Sunrise} label="Preferred time">
                          {/* Deliberately a native <select>, unlike the same
                              field in AddTaskModal and every picker in the
                              sidebar. SelectMenu portals its listbox to
                              document.body, which puts it outside this "..."
                              menu — so useMenuPosition's outside-click check
                              would read choosing an option as a click away and
                              close the whole menu underneath it. Any picker
                              added inside this menu has the same constraint. */}
                          <select
                            value={preferredTimeOfDay}
                            onChange={(e) => setPreferredTimeOfDay(e.target.value)}
                            aria-label="Preferred time of day"
                          >
                            <option value="">No preference</option>
                            {TIME_OF_DAY_OPTIONS.map((period) => (
                              <option key={period} value={period}>
                                {TIME_OF_DAY_LABELS[period]}
                              </option>
                            ))}
                          </select>
                          <p className="form-hint">A nudge, not a rule — the scheduler prefers this part of the day but will still use another slot rather than leave the work unplanned.</p>
                        </DetailField>
                      </li>

                      <li role="none">
                        <DetailField icon={Wind} label="Unattended">
                          <label className="form-checkbox-row" style={{ cursor: 'pointer' }}>
                            <input type="checkbox" checked={isPassive} onChange={(e) => setIsPassive(e.target.checked)} />
                            Can run unattended
                          </label>
                          <p className="form-hint">e.g. laundry — can overlap other scheduled work.</p>
                        </DetailField>
                      </li>
                    </ul>
                  </>,
                  document.body
                )}
            </div>

            <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="detail-body">
            <div className="detail-main">
              <div className="detail-editbox">
                <div className="detail-title-row">
                  <button
                    className={`task-checkbox ${task.priority} ${isDoneForToday ? 'checked' : ''}`}
                    disabled={isReadOnlyViewer}
                    onClick={() => {
                      if (isReadOnlyViewer) return; // Defense in depth — button is already disabled for viewers.
                      if (!isDoneForToday) {
                        // requestComplete only completes synchronously (returning true)
                        // when there's no tracked-time popup to show first — a task with
                        // a timer instead surfaces CompleteTaskConfirmModal above this
                        // modal and leaves this screen open until the user decides.
                        const completedImmediately = requestComplete(task.id);
                        if (completedImmediately) {
                          // Close immediately rather than leaving this screen open showing
                          // stale local state (e.g. the pre-completion due date for a
                          // recurring task, which completeTask advances underneath us).
                          requestClose();
                        }
                      } else {
                        // Already completed — clicking again restores it (mirrors the
                        // "Completed" tab's restore action in TaskListPanel).
                        uncompleteTask(task.id);
                        playUncomplete();
                      }
                    }}
                    title={isDoneForToday ? 'Click to restore to active' : task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
                    aria-label={isDoneForToday ? `Restore ${task.title}` : `Mark ${task.title} complete`}
                    style={{ marginTop: 6 }}
                  >
                    {isDoneForToday && <Check size={12} aria-hidden="true" />}
                  </button>
                  <div className="detail-title-wrap">
                    <SmartTitleInput
                      value={title}
                      onChange={handleTitleChange}
                      smartDetected={smartDetected}
                      onDismiss={dismissSmartChip}
                      projects={projects}
                      sections={sections}
                      labels={labels}
                    />
                  </div>
                </div>

                <SmartChips chips={smartChips} onDismiss={dismissSmartChip} onSelectCandidate={applySmartChipCandidate} />

                {link && (
                  <div className="detail-link-badge">
                    <a href={link} target="_blank" rel="noopener noreferrer" className="detail-link-badge-open">
                      <LinkIcon size={12} aria-hidden="true" />
                      {linkLabel(link)}
                    </a>
                    <button
                      type="button"
                      className="detail-link-badge-remove"
                      onClick={() => setLink('')}
                      aria-label="Remove link"
                      title="Remove link"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                <div className="detail-notes-row">
                  <AlignLeft size={14} className="detail-notes-icon" aria-hidden="true" />
                  <div className="detail-notes-col">
                    <label htmlFor="task-detail-notes" className="sr-only">
                      Description
                    </label>
                    <div className="smart-notes-wrap">
                      {isNotesFocused && (
                        <div className="smart-notes-backdrop" ref={notesBackdropRef} aria-hidden="true">
                          {renderHighlightedNotesText(notes)}
                        </div>
                      )}
                      <textarea
                        id="task-detail-notes"
                        className="detail-notes-textarea detail-notes-textarea-tall"
                        ref={notesRef}
                        rows={1}
                        value={notes}
                        onChange={(e) => handleNotesChange(e.target.value)}
                        onFocus={() => {
                          setIsNotesFocused(true);
                          requestAnimationFrame(syncNotesBackdropScroll);
                        }}
                        onBlur={() => {
                          setIsNotesFocused(false);
                          handleNotesBlur();
                        }}
                        onScroll={syncNotesBackdropScroll}
                        placeholder="Description"
                        maxLength={10000}
                      />
                    </div>
                    {notesLinkMatches.length > 0 && (
                      <div className="notes-link-preview">
                        {notesLinkMatches.map((match) => {
                          const favicon = faviconUrl(match.url);
                          return (
                            <div key={`${match.url}-${match.index}`} className="notes-link-pill">
                              {favicon ? <img src={favicon} alt="" className="notes-link-pill-favicon" /> : <LinkIcon size={12} aria-hidden="true" />}
                              <a href={match.url} target="_blank" rel="noopener noreferrer" className="notes-link-pill-link">
                                {match.url}
                              </a>
                              <button
                                type="button"
                                className="chip-dependency-remove"
                                onClick={() => dismissNotesLink(match)}
                                title="Remove link suggestion"
                                aria-label="Remove link suggestion"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {(mainDirty || (isContainer && hasEditedSharedFieldsRef.current && !justAppliedToAll)) && (
                <div className="detail-save-row">
                  {fixedTimeError && <p className="form-error">{fixedTimeError}</p>}
                  {mainDirty && (
                    <>
                      <button type="button" className="btn" onClick={handleCancel}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={!!fixedTimeError || !!dueDateError || !!dueDateRequiredError}
                      >
                        Save
                      </button>
                    </>
                  )}
                  {isContainer && hasEditedSharedFieldsRef.current && !justAppliedToAll && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleApplyToAllSubtasks}
                      title="Copy this task's priority, due date, project/section, labels, and passive flag onto every sub-task"
                    >
                      Apply to all sub-tasks
                    </button>
                  )}
                </div>
              )}

              {incompleteDependencies.length > 0 && (
                <p className="form-warning">
                  <Ban size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                  <span>
                    Waiting on: {incompleteDependencies.map((d) => d.title).join(', ')} — will be auto-scheduled to start after{' '}
                    {incompleteDependencies.length === 1 ? 'it finishes' : 'they finish'}, and can't be completed itself until{' '}
                    {incompleteDependencies.length === 1 ? 'it is' : 'they are'} marked complete.
                  </span>
                </p>
              )}

              <SubtaskList task={task} setActiveTaskId={setActiveTaskId} />

              <CommentThread task={task} />
            </div>

              <DetailSidebar
                task={task}
                isReadOnlyViewer={isReadOnlyViewer}
                isContainer={isContainer}
                projects={projects}
                projectId={projectId}
                onProjectChange={handleProjectChange}
                availableSections={availableSections}
                sectionId={sectionId}
                onSectionChange={(value) => {
                  setSectionId(value);
                  setHasEditedSection(true);
                }}
                dueDate={dueDate}
                onDueDateChange={setDueDate}
                dueDateError={dueDateError}
                dueDateRequiredError={dueDateRequiredError}
                taskScheduledBlocks={taskScheduledBlocks}
                onMarkBlockDone={markBlockDone}
                onUnmarkBlockDone={unmarkBlockDone}
                hasIncompleteDependencies={incompleteDependencies.length > 0}
                priority={priority}
                onPriorityChange={setPriority}
                labels={labels}
                labelIds={labelIds}
                onLabelIdsChange={setLabelIds}
                onCreateLabel={handleCreateLabel}
                pendingSmartLabels={smartDetected.labels || []}
                estimatedHours={estimatedHours}
                onEstimatedHoursChange={setEstimatedHours}
                effectiveEstimatedHours={effectiveEstimatedHours}
                childTasksCount={childTasks.length}
                effectiveRemainingHours={effectiveRemainingHours}
                onRemainingHoursChange={handleRemainingHoursChange}
                isRecurring={isRecurring}
                onIsRecurringChange={setIsRecurring}
                recurrenceCount={recurrenceCount}
                onRecurrenceCountChange={setRecurrenceCount}
                recurrenceUnit={recurrenceUnit}
                onRecurrenceUnitChange={setRecurrenceUnit}
                recurrenceDays={recurrenceDays}
                onRecurrenceDaysChange={setRecurrenceDays}
                repeatEditText={repeatEditText}
                onRepeatEditTextChange={setRepeatEditText}
                onCommitRepeatEditText={commitRepeatEditText}
                recentCompletionCount={recentCompletionCount}
              />
          </div>
            </>
          );
        }}
      </Modal>

      {showSmartParseGuide && <SmartParseGuideModal onClose={() => setShowSmartParseGuide(false)} />}
      {showSaveTemplate && (
        <SaveTemplateModal
          rootTask={task}
          /* The whole subtree, root first — getAllDescendants' order is
             unspecified, so buildTemplateFromTasks re-layers it itself. */
          subtreeTasks={[task, ...getAllDescendants(task.id, tasks)]}
          existingTemplates={taskTemplates}
          onSave={(template) => {
            setTaskTemplates((prev) => [...prev, template]);
            setNotification({ type: 'success', message: `Saved "${template.name}" as a template.` });
          }}
          onClose={() => setShowSaveTemplate(false)}
        />
      )}
    </>
  );
}

/**
 * Start/pause/resume/stop/mark-done controls for this task's Pomodoro timer
 * (see TimerContext), plus a live "MM:SS remaining" readout that keeps
 * counting up into overtime past zero instead of stopping at "Time's up".
 * Ticks its own 1-second interval only while a timer is actually running for
 * this task, so the rest of the (fairly heavy) detail modal doesn't
 * re-render every second just because a timer elsewhere is counting down.
 */
function TaskTimerControl({ durationSeconds, timer, onStart, onPause, onResume, onStop, onMarkDone }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!timer || timer.status !== 'running') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timer]);

  if (!timer) {
    return (
      /* Plain, unboxed: it's the only thing in .detail-timer-popover, which
         already supplies the raised surface — a bordered .btn inside it read
         as a button floating in a panel rather than the panel's own action. */
      <button type="button" className="btn detail-timer-start" onClick={() => onStart(durationSeconds)}>
        <Timer size={14} /> Start timer ({formatTimerDuration(durationSeconds)})
      </button>
    );
  }

  const remaining = getSignedLiveRemaining(timer);
  const isOvertime = timer.status === 'running' && remaining < 0;
  const displayTime = `${remaining < 0 ? '-' : ''}${formatTimerDuration(Math.abs(remaining))}`;

  return (
    <div className="detail-timer-control">
      <span className={`detail-timer-time ${isOvertime ? 'is-overtime' : ''}`}>{displayTime}</span>
      {timer.status === 'running' ? (
        <button type="button" className="btn btn-icon" onClick={onPause} title="Pause" aria-label="Pause timer">
          <Pause size={14} />
        </button>
      ) : (
        <button type="button" className="btn btn-icon" onClick={onResume} title="Resume" aria-label="Resume timer">
          <Play size={14} />
        </button>
      )}
      <button
        type="button"
        className="btn btn-icon"
        onClick={onMarkDone}
        title="Mark as done"
        aria-label="Mark task as done"
      >
        <CheckCircle size={14} />
      </button>
      <button type="button" className="btn btn-icon" onClick={onStop} title="Stop" aria-label="Stop timer">
        <Square size={14} />
      </button>
    </div>
  );
}

/**
 * Inline follow-up shown in the timer popover right after a pause — offers
 * to log the just-elapsed time as progress by reducing "Time left" (see
 * handleRemainingHoursChange), the same idea as CompleteTaskConfirmModal's
 * pre-filled/editable elapsed-time field but rendered as plain content in
 * this already-open popover instead of a separate modal. Deliberately
 * doesn't touch Task.actualHours — that's a distinct action tied to
 * completing the task, not adjusting how much work remains mid-task.
 */
function PauseLogPrompt({ suggestedHours, effectiveRemainingHours, onApply, onDismiss }) {
  const [hours, setHours] = useState(roundPauseHours(suggestedHours));

  return (
    <div className="detail-timer-pause-prompt">
      <p className="detail-timer-pause-prompt-text">
        Log {formatTimerDuration(suggestedHours * 3600)} and reduce time left?
      </p>
      <div className="detail-timer-pause-prompt-row">
        <NumberField
          min={0}
          max={effectiveRemainingHours}
          step="0.1"
          unitLabel="hours"
          className="detail-timer-pause-prompt-input"
          value={hours}
          onCommit={setHours}
          aria-label="Hours to log"
        />
        <span className="detail-timer-pause-prompt-unit">h</span>
      </div>
      <div className="detail-timer-pause-prompt-actions">
        <button type="button" className="btn" onClick={onDismiss}>
          Dismiss
        </button>
        <button
          type="button"
          className="btn btn-primary"
          /* No fallback needed: NumberField only ever commits a value within
             0..effectiveRemainingHours. The old guard accepted anything
             non-negative, so `max` went unenforced and a typo could log more
             hours than the task had left. */
          onClick={() => onApply(hours)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** Rounds to 1 decimal for display, same tolerance as the hours input's step. */
function roundPauseHours(hours) {
  return Math.round(hours * 10) / 10;
}
