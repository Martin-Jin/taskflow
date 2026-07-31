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
  Repeat,
  Ban,
  Wind,
  X,
  Lock,
  Unlock,
  CalendarClock,
  CalendarCheck,
  Flag,
  Link2,
  CalendarX2,
  Folder,
  Layers,
  Tag,
  Clock,
  Plus,
  Check,
  AlignLeft,
  MoreHorizontal,
  Trash2,
  Link as LinkIcon,
  Paperclip,
  File as FileIcon,
  Send,
  Loader2,
  Sparkles,
  Timer,
  Pause,
  Play,
  Square,
  ExternalLink,
  ChevronRight,
} from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAuth } from '../../context/AuthContext';
import { useTimers, getLiveRemaining, getDefaultDurationSeconds, formatTimerDuration } from '../../context/TimerContext';
import { useCompleteTask } from '../../context/CompleteTaskContext';
import { useSound } from '../../context/SoundContext';
import { validateAttachment, formatFileSize, ATTACHMENT_ACCEPT } from '../../services/attachmentService';
import { parseDurationHours, formatDisplayDate, formatDisplayDateTime, toISODate } from '../../utils/dateUtils';
import { linkLabel } from '../../utils/linkify';
import { parseRecurrenceRule, findRecurrencePhrase, RECURRENCE_UNITS, buildRecurrenceString, WEEKDAY_LABELS } from '../../utils/recurrence';
import { getIneligibleDependencyIds, areDependenciesMet } from '../../utils/dependencyUtils';
import { PRIORITY_LABELS } from '../../utils/priorityColor';
import { formatHours } from '../../utils/formatHours';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { useSmartTaskTitle, buildSmartChips } from '../../hooks/useSmartTaskTitle';
import { useMenuPosition } from '../../hooks/useMenuPosition';
import { useIsMobile } from '../../hooks/useIsMobile';
import DependencyPicker from '../Common/DependencyPicker';
import LabelPicker from '../Common/LabelPicker';
import DetailField from '../Common/DetailField';
import SmartChips from '../Common/SmartChips';
import SmartTitleInput from '../Common/SmartTitleInput';
import SmartDurationInput from '../Common/SmartDurationInput';
import SmartRecurrenceInput from '../Common/SmartRecurrenceInput';
import { faviconUrl } from '../Dashboard/notesModel';
import { findLinkPhrases, stripMatchedText } from '../../utils/smartParse';
import { getEffectiveEstimatedHours } from '../../utils/taskHierarchy';
import SmartParseGuideModal from './SmartParseGuideModal';

// Default estimated hours for a quick-added sub-task — matches
// AddTaskModal's DEFAULT_ESTIMATED_HOURS for a brand-new top-level task, so
// an un-estimated sub-task doesn't eat an oversized chunk of capacity
// either (it's schedulable immediately, due date or not — see
// allocator.js's prioritizeTasks — but keeps the two "new task" entry
// points consistent).
const DEFAULT_SUBTASK_ESTIMATED_HOURS = 5 / 60;

// Sub-task nesting is capped at 2 levels (task -> sub-task -> sub-task of
// that sub-task), enforced going forward only (no migration/backfill for
// any pre-existing data that might already violate it — see TaskDetailModal's
// handleAddSubtask). A task is already at the max depth once ITS OWN parent
// is itself a sub-task (i.e. `task` is a depth-2 sub-task already); adding a
// child to it would create a depth-3 grandchild.
function isAtMaxSubtaskDepth(task, tasks) {
  if (!task.parentId) return false;
  const parent = tasks.find((t) => t.id === task.parentId);
  return !!(parent && parent.parentId);
}

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
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  const [title, setTitle] = useState(task.title);
  const [link, setLink] = useState(task.link || '');
  const [notes, setNotes] = useState(() => stripNotesLinks(task.notes || ''));
  const [estimatedHours, setEstimatedHours] = useState(task.estimatedHours);
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || '');
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
  const [isPassive, setIsPassive] = useState(!!task.isPassive);
  const [earliestDate, setEarliestDate] = useState(task.earliestDate || '');
  const [enforceDueDate, setEnforceDueDate] = useState(!!task.enforceDueDate);
  const [fixedTime, setFixedTime] = useState(task.fixedTime || '');
  const [labelIds, setLabelIds] = useState(task.labelIds || []);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [hideCompletedSubtasks, setHideCompletedSubtasks] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSmartParseGuide, setShowSmartParseGuide] = useState(false);
  const [notesLinkMatches, setNotesLinkMatches] = useState(() => getInitialNoteLinks(task));
  const [isNotesFocused, setIsNotesFocused] = useState(false);

  // Comments post immediately (like Todoist) rather than going through the
  // draft-state + Save/Cancel flow the rest of this modal uses — so this
  // local state only ever tracks the in-progress *next* comment, not the
  // thread itself (that lives on `task.comments`, read live).
  const [commentText, setCommentText] = useState('');
  const [commentFile, setCommentFile] = useState(null);
  const [commentFilePreview, setCommentFilePreview] = useState(null);
  const [isPostingComment, setIsPostingComment] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [lightboxAttachment, setLightboxAttachment] = useState(null);
  const commentFileInputRef = useRef(null);

  // Revoke the previous object URL whenever the pending attachment changes
  // (new file picked, removed, or comment posted) so picking several image
  // attachments in a row doesn't leak blob URLs for the lifetime of the tab.
  useEffect(() => {
    return () => {
      if (commentFilePreview) URL.revokeObjectURL(commentFilePreview);
    };
  }, [commentFilePreview]);

  function handleCommentFileSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = validateAttachment(file);
    if (error) {
      setCommentError(error);
      return;
    }
    setCommentError('');
    setCommentFile(file);
    setCommentFilePreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  }

  function handleRemoveCommentFile() {
    setCommentFile(null);
    setCommentFilePreview(null);
  }

  // Lets a screenshot on the clipboard (Ctrl+V / Cmd+V, e.g. from Win+Shift+S)
  // attach directly to the comment without saving it to disk first — same
  // validation/preview path as picking a file.
  function handleCommentPaste(e) {
    const file = Array.from(e.clipboardData?.items || [])
      .find((item) => item.kind === 'file')
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    const error = validateAttachment(file);
    if (error) {
      setCommentError(error);
      return;
    }
    setCommentError('');
    setCommentFile(file);
    setCommentFilePreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  }

  async function handlePostComment() {
    const text = commentText.trim();
    if (!text && !commentFile) return;
    setIsPostingComment(true);
    setCommentError('');
    try {
      await addComment(task.id, { text, file: commentFile });
      setCommentText('');
      handleRemoveCommentFile();
    } catch (err) {
      setCommentError(err.message || 'Failed to post comment.');
    } finally {
      setIsPostingComment(false);
    }
  }

  const notesRef = useRef(null);
  const notesBackdropRef = useRef(null);
  useAutosizeTextarea(notesRef, notes, { maxLines: 3 });

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

  // Snapshot of the task's saved values, refreshed whenever a *different*
  // task is opened (mirrors the reset-on-task.id effect below) — compared
  // against current form state to decide whether the inline Save/Cancel row
  // (rendered right under the description, Todoist-style, instead of a
  // permanent footer) should show at all.
  const initialSnapshotRef = useRef(null);
  if (!initialSnapshotRef.current) {
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: stripNotesLinks(task.notes || ''),
      estimatedHours: task.estimatedHours,
      priority: task.priority,
      dueDate: task.dueDate || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: initialRule.count,
      recurrenceUnit: initialRule.unit,
      recurrenceDays: initialRule.days || null,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      isPassive: !!task.isPassive,
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
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
    setPriority(task.priority);
    setDueDate(task.dueDate || '');
    setIsRecurring(!!task.isRecurring);
    const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
    setRecurrenceCount(rule.count);
    setRecurrenceUnit(rule.unit);
    setRecurrenceDays(rule.days || null);
    setProjectId(task.projectId || '');
    setSectionId(task.sectionId || '');
    setHasEditedSection(false);
    setDependsOn(task.dependsOn || []);
    setIsPassive(!!task.isPassive);
    setEarliestDate(task.earliestDate || '');
    setEnforceDueDate(!!task.enforceDueDate);
    setFixedTime(task.fixedTime || '');
    setLabelIds(task.labelIds || []);
    resetSmartState();
    lastSmartEstimatedHoursRef.current = null;
    initialSnapshotRef.current = {
      title: task.title,
      link: task.link || '',
      notes: stripNotesLinks(task.notes || ''),
      estimatedHours: task.estimatedHours,
      priority: task.priority,
      dueDate: task.dueDate || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: rule.count,
      recurrenceUnit: rule.unit,
      recurrenceDays: rule.days || null,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      dependsOn: task.dependsOn || [],
      isPassive: !!task.isPassive,
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
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
  useEffect(() => {
    const snap = initialSnapshotRef.current;
    if (!snap) return;
    const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
    const taskValues = {
      estimatedHours: task.estimatedHours,
      priority: task.priority,
      dueDate: task.dueDate || '',
      isRecurring: !!task.isRecurring,
      recurrenceCount: rule.count,
      recurrenceUnit: rule.unit,
      projectId: task.projectId || '',
      sectionId: task.sectionId || '',
      isPassive: !!task.isPassive,
      earliestDate: task.earliestDate || '',
      enforceDueDate: !!task.enforceDueDate,
      fixedTime: task.fixedTime || '',
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
      isPassive: setIsPassive,
      earliestDate: setEarliestDate,
      enforceDueDate: setEnforceDueDate,
      fixedTime: setFixedTime,
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
      isPassive,
      earliestDate,
      enforceDueDate,
      fixedTime,
    };
    Object.keys(taskValues).forEach((key) => {
      if (String(localValues[key]) === String(snap[key]) && String(taskValues[key]) !== String(snap[key])) {
        setters[key](taskValues[key]);
        snap[key] = taskValues[key];
      }
    });
    const taskRecurrenceDays = rule.days || null;
    if (jsonArrayEq(recurrenceDays, snap.recurrenceDays) && !jsonArrayEq(taskRecurrenceDays, snap.recurrenceDays)) {
      setRecurrenceDays(taskRecurrenceDays);
      snap.recurrenceDays = taskRecurrenceDays;
    }
    const taskDependsOn = task.dependsOn || [];
    if (jsonArrayEq(dependsOn, snap.dependsOn) && !jsonArrayEq(taskDependsOn, snap.dependsOn)) {
      setDependsOn(taskDependsOn);
      snap.dependsOn = taskDependsOn;
    }
    const taskLabelIds = task.labelIds || [];
    if (jsonArrayEq(labelIds, snap.labelIds) && !jsonArrayEq(taskLabelIds, snap.labelIds)) {
      setLabelIds(taskLabelIds);
      snap.labelIds = taskLabelIds;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  // Direct children only (one level) — a grandchild is reached by opening
  // its own parent's nested TaskDetailModal in turn, not shown flattened here.
  const childTasks = useMemo(() => tasks.filter((t) => t.parentId === task.id), [tasks, task.id]);
  const visibleChildTasks = hideCompletedSubtasks ? childTasks.filter((c) => !c.isCompleted) : childTasks;
  const completedChildTasks = childTasks.filter((c) => c.isCompleted).length;
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
  const effectiveEstimatedHours = useMemo(() => (isContainer ? getEffectiveEstimatedHours(task, tasks) : task.estimatedHours), [
    isContainer,
    task,
    tasks,
  ]);
  const atMaxSubtaskDepth = useMemo(() => isAtMaxSubtaskDepth(task, tasks), [task, tasks]);

  // Sections belong to a project — once a project is chosen, only show
  // that project's sections (matching Todoist's own board picker).
  const availableSections = useMemo(
    () => sections.filter((s) => !projectId || s.projectId === projectId),
    [sections, projectId]
  );

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
  const lastSmartEstimatedHoursRef = useRef(null);
  const { smartDetected, handleTitleChange: handleSmartTitleChange, dismissSmartChip, buildFinalTitle, resetSmartState } = useSmartTaskTitle({
    tasks,
    projects,
    sections,
    fields: {
      link: {
        isUntouched: () => link === (task.link || ''),
        apply: (match) => setLink(match.url),
        revert: () => setLink(task.link || ''),
      },
      dueDate: {
        isUntouched: () => dueDate === (task.dueDate || ''),
        apply: (match) => setDueDate(match.iso),
        revert: () => setDueDate(task.dueDate || ''),
      },
      recurrence: {
        isUntouched: () => isRecurring === !!task.isRecurring,
        apply: (match, detected) => {
          setIsRecurring(true);
          setRecurrenceCount(match.rule.count);
          setRecurrenceUnit(match.rule.unit);
          setRecurrenceDays(match.rule.days || null);
          if (!dueDate && !detected.dueDate) setDueDate(toISODate(new Date()));
        },
        revert: () => {
          setIsRecurring(!!task.isRecurring);
          const rule = parseRecurrenceRule(task.recurrenceString) || { unit: 'month', count: 1 };
          setRecurrenceCount(rule.count);
          setRecurrenceUnit(rule.unit);
          setRecurrenceDays(rule.days || null);
        },
      },
      priority: {
        isUntouched: () => priority === task.priority,
        apply: (match) => setPriority(match.level),
        revert: () => setPriority(task.priority),
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
        isUntouched: () => isPassive === !!task.isPassive,
        apply: () => setIsPassive(true),
        revert: () => setIsPassive(!!task.isPassive),
      },
      enforceDueDate: {
        isUntouched: () => enforceDueDate === !!task.enforceDueDate,
        apply: () => setEnforceDueDate(true),
        revert: () => setEnforceDueDate(!!task.enforceDueDate),
      },
      dependency: {
        isUntouched: () =>
          dependsOn.length === (task.dependsOn || []).length && dependsOn.every((id) => (task.dependsOn || []).includes(id)),
        apply: (match) => {
          if (match.task) setDependsOn((prev) => (prev.includes(match.task.id) ? prev : [...prev, match.task.id]));
        },
        revert: (entry) => {
          if (entry.task) setDependsOn((prev) => prev.filter((id) => id !== entry.task.id));
        },
      },
      project: {
        isUntouched: () => projectId === (task.projectId || ''),
        apply: (match) => {
          if (match.project) handleProjectChange(match.project.id);
          if (match.section && !hasEditedSection) setSectionId(match.section.id);
        },
        revert: () => {
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
    earliestDate !== initialSnapshotRef.current.earliestDate ||
    enforceDueDate !== initialSnapshotRef.current.enforceDueDate ||
    fixedTime !== initialSnapshotRef.current.fixedTime ||
    dependsOn.length !== initialSnapshotRef.current.dependsOn.length ||
    dependsOn.some((id) => !initialSnapshotRef.current.dependsOn.includes(id)) ||
    labelIds.length !== initialSnapshotRef.current.labelIds.length ||
    labelIds.some((id) => !initialSnapshotRef.current.labelIds.includes(id));
  const isDirty = mainDirty || sidebarDirty;

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

  function handleAddSubtask() {
    const trimmed = newSubtaskTitle.trim();
    if (!trimmed || atMaxSubtaskDepth) return;
    // A sub-task is just a top-level task with `parentId` set — created via
    // the same addTask every other task uses. `dueDate` is deliberately left
    // unset — an undated sub-task is still immediately schedulable (see
    // allocator.js's prioritizeTasks), it just competes for capacity at
    // baseline urgency (or its nearest ancestor's due date, if any) instead
    // of a deadline of its own.
    addTask({
      title: trimmed,
      parentId: task.id,
      estimatedHours: DEFAULT_SUBTASK_ESTIMATED_HOURS,
      priority: 'medium',
      dueDate: null,
      projectId: task.projectId ?? null,
      sectionId: task.sectionId ?? null,
      sectionName: task.sectionName ?? null,
    });
    setNewSubtaskTitle('');
  }

  function handleCancelAddSubtask() {
    setNewSubtaskTitle('');
    setIsAddingSubtask(false);
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
    // Shift remainingHours by however much the estimate changed, rather than
    // just clamping down — otherwise raising the estimate on an
    // already-fully-scheduled task (remainingHours: 0) would never add any
    // new hours for the scheduler to place.
    const nextRemainingHours = Math.min(
      nextEstimatedHours,
      Math.max(0, task.remainingHours + (nextEstimatedHours - task.estimatedHours))
    );

    const nextTitle = buildFinalTitle(title, link ? linkLabel(link) : task.title);

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
      // disabled for one below, but skip persisting these here too as a
      // second guard against ever writing a stale independent number onto
      // it (e.g. via a smart-parsed duration phrase in the title).
      ...(isContainer ? {} : { estimatedHours: nextEstimatedHours, remainingHours: nextRemainingHours }),
      priority,
      dueDate: nextDueDate,
      isRecurring: nextIsRecurring,
      recurrenceString: nextRecurrenceString,
      projectId: projectId || null,
      sectionId: sectionId || null,
      sectionName: section ? section.name : null,
      dependsOn,
      isPassive,
      earliestDate: earliestDate || null,
      // Only meaningful once a due date exists — clear it rather than
      // persisting a flag that has nothing to enforce.
      enforceDueDate: enforceDueDate && !!nextDueDate,
      // A container is never scheduled directly, so a fixed time-of-day has
      // nothing to apply to — skip persisting it, same guard as
      // estimatedHours/remainingHours above.
      fixedTime: isContainer ? null : fixedTime || null,
      labelIds: finalLabelIds,
    });

    // Sync local title state to the just-persisted, already-stripped value
    // and clear smart-parse detection state — otherwise re-entering edit
    // (e.g. via the sidebar auto-save path, which doesn't close the modal)
    // would keep showing the raw pre-strip text with stale link highlighting.
    setTitle(nextTitle);
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
      isPassive,
      earliestDate: earliestDate || '',
      enforceDueDate: enforceDueDate && !!nextDueDate,
      fixedTime: fixedTime || '',
      labelIds: finalLabelIds,
    };
  }

  function handleSave() {
    commitChanges();
    requestClose();
  }

  // Sidebar fields auto-save (debounced) without needing the explicit
  // Save/Cancel row — that row is reserved for mainDirty (title/notes)
  // below. Skips entirely while mainDirty is also true, since in that case
  // Save/Cancel is already visible and will commit both together.
  useEffect(() => {
    if (mainDirty || !sidebarDirty) return undefined;
    const handle = setTimeout(() => commitChanges(), 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mainDirty,
    sidebarDirty,
    estimatedHours,
    priority,
    dueDate,
    isRecurring,
    recurrenceCount,
    recurrenceUnit,
    recurrenceDays,
    projectId,
    sectionId,
    isPassive,
    earliestDate,
    enforceDueDate,
    fixedTime,
    dependsOn,
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
    setIsPassive(snap.isPassive);
    setEarliestDate(snap.earliestDate);
    setEnforceDueDate(snap.enforceDueDate);
    setFixedTime(snap.fixedTime);
    setLabelIds(snap.labelIds);
    resetSmartState();
    lastSmartEstimatedHoursRef.current = null;
  }

  function handleDelete() {
    deleteTask(task.id);
    requestClose();
  }

  return (
    <>
      <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
        <div
          className="modal modal-detail"
          onClick={(e) => e.stopPropagation()}
          style={{ width: 760 }}
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Task details"
          tabIndex={-1}
        >
          <div className="detail-topbar">
            {(parentTask || childTasks.length > 0) && (
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
                ) : (
                  <span className="detail-hierarchy-current">
                    <Layers size={12} aria-hidden="true" />
                    {task.title}
                    <span className="detail-hierarchy-count">
                      {childTasks.length} sub-task{childTasks.length === 1 ? '' : 's'}
                    </span>
                  </span>
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
                        <button type="button" role="menuitem" className="detail-menu-item detail-menu-item-danger" onClick={handleDelete}>
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

                      <li role="none" className="detail-menu-divider" />

                      {dependencyOptions.length > 0 && (
                        <li role="none">
                          <DetailField icon={Link2} label="Depends on">
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
                          <label className="form-checkbox-row" style={{ cursor: dueDate ? 'pointer' : 'not-allowed' }}>
                            <input
                              type="checkbox"
                              checked={enforceDueDate}
                              disabled={!dueDate}
                              onChange={(e) => setEnforceDueDate(e.target.checked)}
                            />
                            Must be done on due date
                          </label>
                          <p className="form-hint">
                            {dueDate
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
                              checked={!!fixedTime}
                              disabled={isContainer}
                              onChange={(e) => setFixedTime(e.target.checked ? '09:00' : '')}
                            />
                            {fixedTime ? `At ${fixedTime}` : 'Not fixed'}
                          </label>
                          {fixedTime && !isContainer && (
                            <>
                              <input type="time" value={fixedTime} onChange={(e) => setFixedTime(e.target.value)} style={{ marginTop: 6 }} />
                              <p className="form-hint">Scheduled blocks for this task will always start at this time.</p>
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
                    className={`task-checkbox ${task.priority} ${task.isCompleted ? 'checked' : ''}`}
                    onClick={() => {
                      if (!task.isCompleted) {
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
                    title={task.isCompleted ? 'Click to restore to active' : task.isRecurring ? 'Complete (advances to next occurrence)' : 'Mark complete'}
                    aria-label={task.isCompleted ? `Restore ${task.title}` : `Mark ${task.title} complete`}
                    style={{ marginTop: 6 }}
                  >
                    {task.isCompleted && <Check size={12} aria-hidden="true" />}
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

                <SmartChips chips={smartChips} onDismiss={dismissSmartChip} />

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
                        className="detail-notes-textarea"
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

              {mainDirty && (
                <div className="detail-save-row">
                  <button type="button" className="btn" onClick={handleCancel}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleSave}>
                    Save
                  </button>
                </div>
              )}

              {incompleteDependencies.length > 0 && (
                <p className="form-warning">
                  <Ban size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                  <span>
                    Waiting on: {incompleteDependencies.map((d) => d.title).join(', ')} — won't be auto-scheduled until{' '}
                    {incompleteDependencies.length === 1 ? 'it is' : 'they are'} marked complete.
                  </span>
                </p>
              )}

              <div className="form-row">
                <div className="subtask-header">
                  <label>Sub-tasks {childTasks.length > 0 ? `(${completedChildTasks}/${childTasks.length})` : ''}</label>
                  {completedChildTasks > 0 && (
                    <button type="button" className="subtask-hide-completed" onClick={() => setHideCompletedSubtasks((v) => !v)}>
                      {hideCompletedSubtasks ? 'Show completed' : 'Hide completed'}
                    </button>
                  )}
                </div>
                <div className="subtask-list">
                  {visibleChildTasks.map((child) => (
                    <div key={child.id} className="subtask-row">
                      <input
                        type="checkbox"
                        checked={child.isCompleted}
                        disabled={child.isCompleted}
                        // Same "complete, never un-complete" checkbox as a
                        // normal task's row (TaskListPanel) — reused as-is
                        // rather than hand-rolling a new toggle path.
                        onChange={() => {
                          if (!child.isCompleted) requestComplete(child.id);
                        }}
                      />
                      <div
                        role="button"
                        tabIndex={0}
                        className={`subtask-row-title-wrap ${child.isCompleted ? 'completed' : ''}`}
                        onClick={() => setActiveTaskId(child.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setActiveTaskId(child.id);
                          }
                        }}
                        title="Open sub-task"
                      >
                        <span className="subtask-row-title">
                          {child.link ? (
                            <a
                              href={child.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="task-title-link"
                              onClick={(e) => e.stopPropagation()}
                              title={`Open link: ${child.link}`}
                            >
                              {child.title}
                              <ExternalLink size={11} aria-hidden="true" />
                            </a>
                          ) : (
                            child.title
                          )}
                        </span>
                        {child.notes && <span className="subtask-row-notes">{child.notes}</span>}
                      </div>
                      <button
                        className="btn btn-icon subtask-row-remove"
                        onClick={() => deleteTask(child.id)}
                        style={{ color: 'var(--color-danger)' }}
                        aria-label={`Delete ${child.title}`}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  {atMaxSubtaskDepth ? (
                    <p className="form-hint">
                      Sub-tasks are capped at 2 levels deep — this task is already a sub-task of a sub-task, so it can't have its own.
                    </p>
                  ) : isAddingSubtask ? (
                    <div className="subtask-add-row">
                      <input
                        autoFocus
                        value={newSubtaskTitle}
                        onChange={(e) => setNewSubtaskTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddSubtask();
                          } else if (e.key === 'Escape') {
                            handleCancelAddSubtask();
                          }
                        }}
                        onBlur={() => {
                          if (!newSubtaskTitle.trim()) setIsAddingSubtask(false);
                        }}
                        placeholder="Add a sub-task…"
                        style={{ flex: 1 }}
                      />
                      <button type="button" className="btn" onClick={handleAddSubtask}>
                        <Plus size={14} />
                        Add
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="subtask-add-trigger" onClick={() => setIsAddingSubtask(true)}>
                      <Plus size={14} />
                      Add sub-task
                    </button>
                  )}
                </div>
              </div>

              <div className="form-row comments-section">
                <label>Comments{task.comments?.length ? ` (${task.comments.length})` : ''}</label>
                <div className="comment-list">
                  {(task.comments || []).map((c) => (
                    <div key={c.id} className="comment-row">
                      {user?.photoURL ? (
                        <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="account-avatar" />
                      ) : (
                        <span className="account-avatar account-avatar-fallback">
                          {(user?.displayName || user?.email || '?')[0].toUpperCase()}
                        </span>
                      )}
                      <div className="comment-body">
                        {c.text && <p className="comment-text">{c.text}</p>}
                        {c.attachment &&
                          (c.attachment.type.startsWith('image/') ? (
                            <button
                              type="button"
                              className="comment-attachment-thumb"
                              onClick={() => setLightboxAttachment(c.attachment)}
                            >
                              <img src={c.attachment.url} alt={c.attachment.name} />
                            </button>
                          ) : (
                            <a
                              href={c.attachment.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="comment-attachment-file"
                            >
                              <FileIcon size={14} />
                              <span className="comment-attachment-file-name">{c.attachment.name}</span>
                              <span className="comment-attachment-file-size">{formatFileSize(c.attachment.size)}</span>
                            </a>
                          ))}
                        <span className="comment-meta">{formatDisplayDateTime(c.createdAt)}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-icon comment-remove"
                        onClick={() => deleteComment(task.id, c.id)}
                        style={{ color: 'var(--color-danger)' }}
                        aria-label="Delete comment"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                {commentError && (
                  <p className="form-warning">
                    <Ban size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                    <span>{commentError}</span>
                  </p>
                )}

                {commentFile && (
                  <div className="comment-pending-file">
                    {commentFilePreview ? (
                      <img src={commentFilePreview} alt="" className="comment-pending-thumb" />
                    ) : (
                      <FileIcon size={14} />
                    )}
                    <span className="comment-pending-name">{commentFile.name}</span>
                    <button type="button" onClick={handleRemoveCommentFile} aria-label="Remove attachment">
                      <X size={12} />
                    </button>
                  </div>
                )}

                <div className="comment-input-bar">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handlePostComment();
                      }
                    }}
                    onPaste={handleCommentPaste}
                    placeholder="Comment"
                    disabled={isPostingComment}
                  />
                  <input
                    ref={commentFileInputRef}
                    type="file"
                    accept={ATTACHMENT_ACCEPT}
                    style={{ display: 'none' }}
                    onChange={handleCommentFileSelect}
                  />
                  <button
                    type="button"
                    className="btn btn-icon comment-attach-btn"
                    onClick={() =>
                      user ? commentFileInputRef.current?.click() : setCommentError('Sign in to attach files to a comment.')
                    }
                    title={user ? 'Attach a file' : 'Sign in to attach files'}
                    disabled={isPostingComment}
                  >
                    <Paperclip size={15} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon comment-send-btn"
                    onClick={handlePostComment}
                    disabled={isPostingComment || (!commentText.trim() && !commentFile)}
                    aria-label={isPostingComment ? 'Posting comment…' : 'Post comment'}
                  >
                    {isPostingComment ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="detail-sidebar">
              <DetailField icon={Folder} label="Project">
                <select value={projectId} onChange={(e) => handleProjectChange(e.target.value)}>
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </DetailField>

              <DetailField icon={Layers} label="Section">
                <select
                  value={sectionId}
                  onChange={(e) => {
                    setSectionId(e.target.value);
                    setHasEditedSection(true);
                  }}
                >
                  <option value="">No section</option>
                  {availableSections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </DetailField>

              <DetailField icon={CalendarClock} label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                {isContainer ? (
                  <p className="form-hint">
                    A container's own due date isn't scheduled directly — it feeds urgency for sub-tasks that don't have their own.
                  </p>
                ) : !dueDate && task.parentId ? (
                  <p className="form-hint">
                    Still schedulable without one — it'll use its parent's due date (if any) or default priority/urgency.
                  </p>
                ) : (
                  !dueDate && <p className="form-hint">Won't be auto-scheduled without a due date.</p>
                )}
              </DetailField>

              <DetailField icon={Flag} label="Priority">
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </DetailField>

              <DetailField icon={Tag} label="Labels">
                <LabelPicker
                  labels={labels}
                  selectedIds={labelIds}
                  onChange={setLabelIds}
                  onCreateLabel={handleCreateLabel}
                />
                {(smartDetected.labels || []).length > 0 && (
                  <p className="form-hint">Pending from the title: {smartDetected.labels.map((m) => `#${m.name}`).join(', ')}</p>
                )}
              </DetailField>

              <DetailField icon={Clock} label="Estimated time">
                {isContainer ? (
                  <>
                    <p style={{ margin: 0, fontWeight: 600 }}>{formatHours(effectiveEstimatedHours)}</p>
                    <p className="form-hint">
                      Computed from {childTasks.length} sub-task{childTasks.length === 1 ? '' : 's'} — not directly editable.
                    </p>
                  </>
                ) : (
                  <SmartDurationInput hours={Number(estimatedHours) || 0} onChange={setEstimatedHours} />
                )}
                {typeof task.actualHours === 'number' && (
                  <p className="form-hint">Actually spent: {formatHours(task.actualHours)} (tracked via timer)</p>
                )}
              </DetailField>

              <DetailField icon={Timer} label="Timer">
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
                  onPause={() => pauseTimer(task.id)}
                  onResume={() => resumeTimer(task.id)}
                  onStop={() => stopTimer(task.id)}
                />
              </DetailField>

              <DetailField icon={Repeat} label="Repeat">
                {isRecurring && recurrenceDays && recurrenceDays.length > 0 ? (
                  repeatEditText !== null ? (
                    <SmartRecurrenceInput
                      value={repeatEditText}
                      autoFocus
                      onChange={(e) => setRepeatEditText(e.target.value)}
                      onBlur={commitRepeatEditText}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setRepeatEditText(null);
                      }}
                    />
                  ) : (
                    <div className="detail-field-inline">
                      <button
                        type="button"
                        className="detail-recurrence-toggle"
                        style={{ flex: 1 }}
                        onClick={() =>
                          setRepeatEditText(
                            `every ${recurrenceCount === 1 ? '' : `${recurrenceCount} `}week${recurrenceCount === 1 ? '' : 's'} on ${recurrenceDays
                              .map((d) => WEEKDAY_LABELS[d])
                              .join(', ')}`
                          )
                        }
                      >
                        {`Every ${recurrenceCount === 1 ? '' : `${recurrenceCount} `}week${recurrenceCount === 1 ? '' : 's'} on ${recurrenceDays
                          .map((d) => WEEKDAY_LABELS[d])
                          .join(', ')}`}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon detail-recurrence-clear"
                        onClick={() => setIsRecurring(false)}
                        aria-label="Turn off repeat"
                        title="Does not repeat"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )
                ) : isRecurring ? (
                  <div className="detail-recurrence-toggle detail-recurrence-toggle-active">
                    {`Every ${recurrenceCount} ${recurrenceUnit}${recurrenceCount === 1 ? '' : 's'}`}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="detail-recurrence-toggle"
                    disabled={!dueDate}
                    onClick={() => setIsRecurring(true)}
                  >
                    Does not repeat
                  </button>
                )}
                {isRecurring && !(recurrenceDays && recurrenceDays.length > 0) && (
                  <div className="detail-field-inline" style={{ marginTop: 6 }}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={recurrenceCount}
                      onChange={(e) => {
                        setRecurrenceCount(Math.max(1, Number(e.target.value) || 1));
                        setRecurrenceDays(null);
                      }}
                      style={{ width: 56 }}
                    />
                    <select
                      value={recurrenceUnit}
                      onChange={(e) => {
                        setRecurrenceUnit(e.target.value);
                        setRecurrenceDays(null);
                      }}
                      style={{ flex: 1 }}
                    >
                      {RECURRENCE_UNITS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-icon detail-recurrence-clear"
                      onClick={() => setIsRecurring(false)}
                      aria-label="Turn off repeat"
                      title="Does not repeat"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {isRecurring && (
                  <p className="form-hint">Marking this complete advances the due date instead of moving it to Completed.</p>
                )}
                {task.isRecurring && (
                  <p className="form-hint">
                    Completed {recentCompletionCount} of the last 7 days
                  </p>
                )}
                {!dueDate && <p className="form-hint">Needs a due date first.</p>}
              </DetailField>

            </div>
          </div>
        </div>
      </div>

      {lightboxAttachment &&
        createPortal(
          <div className="attachment-lightbox" onClick={() => setLightboxAttachment(null)}>
            <button
              type="button"
              className="attachment-lightbox-close"
              onClick={() => setLightboxAttachment(null)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <img src={lightboxAttachment.url} alt={lightboxAttachment.name} onClick={(e) => e.stopPropagation()} />
          </div>,
          document.body
        )}

      {showSmartParseGuide && <SmartParseGuideModal onClose={() => setShowSmartParseGuide(false)} />}
    </>
  );
}

/**
 * Start/pause/resume/stop controls for this task's Pomodoro timer (see
 * TimerContext), plus a live "MM:SS remaining" readout. Ticks its own
 * 1-second interval only while a timer is actually running for this task,
 * so the rest of the (fairly heavy) detail modal doesn't re-render every
 * second just because a timer elsewhere is counting down.
 */
function TaskTimerControl({ durationSeconds, timer, onStart, onPause, onResume, onStop }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!timer || timer.status !== 'running') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timer]);

  if (!timer) {
    return (
      <button type="button" className="btn" onClick={() => onStart(durationSeconds)}>
        <Timer size={14} /> Start timer ({formatTimerDuration(durationSeconds)})
      </button>
    );
  }

  const remaining = getLiveRemaining(timer);
  const isDone = timer.status === 'done';

  return (
    <div className="detail-timer-control">
      <span className={`detail-timer-time ${isDone ? 'is-done' : ''}`}>{isDone ? "Time's up" : formatTimerDuration(remaining)}</span>
      {timer.status === 'running' ? (
        <button type="button" className="btn btn-icon" onClick={onPause} title="Pause" aria-label="Pause timer">
          <Pause size={14} />
        </button>
      ) : (
        <button type="button" className="btn btn-icon" onClick={onResume} title={isDone ? 'Restart' : 'Resume'} aria-label={isDone ? 'Restart timer' : 'Resume timer'}>
          <Play size={14} />
        </button>
      )}
      <button type="button" className="btn btn-icon" onClick={onStop} title="Stop" aria-label="Stop timer">
        <Square size={14} />
      </button>
    </div>
  );
}
