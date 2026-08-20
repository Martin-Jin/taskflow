/**
 * AIQuickAddModal — free-form text and/or screenshots/PDFs in, a reviewable plan
 * of workspace changes out (new/updated/deleted tasks, events, projects,
 * sections, labels). Sends the input plus a full snapshot of the current
 * workspace (see services/aiContextService.js's buildAIContext) to the
 * companion Cloudflare Worker (see cloudflare-worker/), which calls the
 * user's choice of Claude or Gemini against the full operation set and
 * returns every proposed change — see services/aiQuickAddService.js for the
 * request/response contract and services/aiPlanService.js for how that raw
 * response is validated/resolved into the plan handed to
 * AIPlanConfirmModal. Nothing is written to the workspace here — this modal
 * only gets as far as opening that confirm screen.
 *
 * Deliberately separate from the client-only regex-based "smart parse"
 * feature (utils/smartParse.js / SmartTitleInput) — this is a full LLM call
 * for messier/longer input (or a screenshot) where typing shorthand isn't
 * practical, not a replacement for it.
 *
 * Only reachable when isAIQuickAddConfigured() is true (no worker URL set =
 * feature hidden entirely, see TaskListPanel.jsx/BoardView.jsx).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, ImagePlus, FileText, Loader2, HelpCircle } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import Modal from '../Common/Modal';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { loadPersisted, savePersisted } from '../../utils/persistence';
import { toISODate, addDays } from '../../utils/dateUtils';
import { requestAIPlan, getStoredApiKey, ALLOWED_ATTACHMENT_TYPES } from '../../services/aiQuickAddService';
import { buildAIContext, estimateTokens, filterContextData, DEFAULT_EVENT_RANGE_DAYS } from '../../services/aiContextService';
import { resolvePlan } from '../../services/aiPlanService';
import { MODEL_CATALOG, getDefaultModelId, isValidModelId } from '../../services/aiModels';
import SelectMenu from '../Common/SelectMenu';
import AIQuickAddGuideModal from './AIQuickAddGuideModal';
import AIPlanConfirmModal from './AIPlanConfirmModal';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const PROVIDER_STORAGE_KEY = 'aiQuickAddProvider';
const MODEL_STORAGE_KEY = 'aiQuickAddModelByProvider';
// Device-local, same reasoning as PROVIDER_STORAGE_KEY/MODEL_STORAGE_KEY
// above — a per-device AI-request preference, not user data worth backing
// up (deliberately outside SchedulerContext/BACKUP_FIELDS).
const CONTEXT_SCOPE_STORAGE_KEY = 'aiQuickAddContextScope';
const PROVIDER_LABEL = { anthropic: 'Claude', gemini: 'Gemini' };
const OTHER_PROVIDER = { anthropic: 'gemini', gemini: 'anthropic' };
// error `kind`s (see aiQuickAddService.AIRequestError) where offering an
// immediate "switch provider" shortcut actually helps, vs. kinds where
// switching provider wouldn't fix anything (bad request, network, etc).
const SWITCHABLE_ERROR_KINDS = new Set(['quota_exhausted', 'rate_limit']);

const CONTEXT_SCOPE_OPTIONS = [
  { value: 'full', label: 'Full context' },
  { value: 'none', label: 'No context' },
  { value: 'custom', label: 'Custom' },
];

const DEFAULT_CONTEXT_SCOPE = { mode: 'full', projectId: '', eventStart: '', eventEnd: '' };

export default function AIQuickAddModal({ onClose, onProjectCreated }) {
  const scheduler = useScheduler();
  const { tasks, projects, sections, labels, events } = scheduler;
  // This component swaps its ENTIRE rendered tree between its own <Modal>
  // (the form) and <AIPlanConfirmModal> (a separately migrated <Modal> of
  // its own) once a plan exists — so when `plan` is set, no <Modal> of this
  // component's own is on screen to provide a requestClose via render-prop.
  // A standalone useAnimatedUnmount(onClose) call (no global side effects —
  // just local isClosing/timeout state, safe to have two independent
  // instances) keeps a "close the whole AI Quick Add flow" callback
  // available for the `onApplied` handoff below regardless of which branch
  // is rendering.
  const { requestClose: closeWholeFlow } = useAnimatedUnmount(onClose);

  // Device-local UI preference, not user data — deliberately outside
  // SchedulerContext/backups (see this repo's CLAUDE.md backup rules).
  const [provider, setProvider] = useState(() => loadPersisted(PROVIDER_STORAGE_KEY, 'anthropic'));
  // Keyed by provider so switching providers remembers each one's own last
  // model choice, falling back to that provider's default (and re-validated
  // against MODEL_CATALOG in case a stored id no longer exists there).
  const [modelByProvider, setModelByProvider] = useState(() => {
    const stored = loadPersisted(MODEL_STORAGE_KEY, {});
    return {
      anthropic: isValidModelId('anthropic', stored.anthropic) ? stored.anthropic : getDefaultModelId('anthropic'),
      gemini: isValidModelId('gemini', stored.gemini) ? stored.gemini : getDefaultModelId('gemini'),
    };
  });
  const model = modelByProvider[provider];
  const hasKey = { anthropic: !!getStoredApiKey('anthropic'), gemini: !!getStoredApiKey('gemini') };
  // Context-scope preference (Full/No context/Custom project+date-range
  // sub-filters) — same device-local persistence pattern as provider/model
  // above. Persisting the "custom" sub-filter selections too (rather than
  // resetting them each open) so switching back to Custom after closing the
  // modal doesn't lose a project/date-range pick the user just made.
  const [contextScope, setContextScope] = useState(() => ({
    ...DEFAULT_CONTEXT_SCOPE,
    ...loadPersisted(CONTEXT_SCOPE_STORAGE_KEY, {}),
  }));
  const todayIso = toISODate(new Date());

  function updateContextScope(patch) {
    setContextScope((prev) => {
      const next = { ...prev, ...patch };
      savePersisted(CONTEXT_SCOPE_STORAGE_KEY, next);
      return next;
    });
  }

  // Custom mode's event date-range sub-filter defaults to a rolling ~30 day
  // window starting today (DEFAULT_EVENT_RANGE_DAYS) whenever the user
  // hasn't picked their own start/end — computed fresh from `todayIso` each
  // render rather than baked into the persisted default, so it stays
  // "today-relative" across sessions instead of freezing to whatever day the
  // pref was first saved. Only meaningful in 'custom' mode — 'full' sends
  // every event unfiltered and 'none' sends none, so this is passed through
  // to filterContextData as-is only when scope.mode === 'custom' (see
  // effectiveScope below).
  const defaultEventStart = todayIso;
  const defaultEventEnd = addDays(todayIso, DEFAULT_EVENT_RANGE_DAYS);
  // A persisted projectId from a project that's since been deleted/left
  // falls back to "All projects" (no restriction) rather than filtering
  // everything out silently — same "stale pref is safely ignored" handling
  // as MODEL_STORAGE_KEY's isValidModelId re-check above.
  const projectStillExists = projects.some((p) => p.id === contextScope.projectId);
  const effectiveScope =
    contextScope.mode === 'custom'
      ? {
          mode: 'custom',
          projectId: projectStillExists ? contextScope.projectId : undefined,
          eventStart: contextScope.eventStart || defaultEventStart,
          eventEnd: contextScope.eventEnd || defaultEventEnd,
        }
      : { mode: contextScope.mode };

  const [text, setText] = useState('');
  const textareaRef = useRef(null);
  useAutosizeTextarea(textareaRef, text, { maxLines: 4 });
  // Each entry: { file, previewUrl } — previewUrl is an object URL for
  // images, null for PDFs (rendered with a file icon + name instead).
  const [attachments, setAttachments] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [plan, setPlan] = useState(null);
  const fileInputRef = useRef(null);

  // Filtered once per (workspace, scope) change and reused for both the
  // token-estimate memo below AND the actual submit call (see handleSubmit)
  // — keeping both derived from the same filtered arrays is what guarantees
  // the displayed estimate never diverges from what's actually sent.
  const filteredContextData = useMemo(
    () => filterContextData({ tasks, projects, sections, labels, events }, effectiveScope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, projects, sections, labels, events, contextScope]
  );

  // Only rebuilds when the workspace or scope changes, not on every
  // keystroke — context.md's bulk is the workspace snapshot, which is
  // unrelated to what the user is currently typing (see
  // aiContextService.buildAIContext).
  const contextTokens = useMemo(
    () => buildAIContext({ ...filteredContextData, today: toISODate(new Date()), scope: effectiveScope }).approxTokens,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredContextData, contextScope]
  );
  const approxTotalTokens = contextTokens + estimateTokens(text);

  // Revoke every preview's object URL on unmount, same leak-avoidance as
  // TaskDetailModal's comment attachment preview.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time correction on open: if the persisted/default provider has no
  // configured API key but the other one does, start on the usable one
  // instead of opening straight into a dead end. Deliberately mount-only —
  // once the user is in this modal, further switching is their own choice
  // (see the provider SelectMenu's disabled options below, which is the
  // actual "block selecting a keyless provider" mechanism).
  useEffect(() => {
    if (!hasKey[provider] && hasKey[OTHER_PROVIDER[provider]]) {
      changeProvider(OTHER_PROVIDER[provider]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeProvider(next) {
    setProvider(next);
    savePersisted(PROVIDER_STORAGE_KEY, next);
  }

  function changeModel(next) {
    const updated = { ...modelByProvider, [provider]: next };
    setModelByProvider(updated);
    savePersisted(MODEL_STORAGE_KEY, updated);
  }

  function applyFiles(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (list.length === 0) return;
    if (attachments.length + list.length > MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      setErrorKind('');
      return;
    }
    const accepted = [];
    for (const file of list) {
      if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
        setError('Only images (PNG, JPEG, WEBP, GIF) and PDFs can be attached.');
        setErrorKind('');
        return;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is too large — please use files under 5MB.`);
        setErrorKind('');
        return;
      }
      accepted.push({ file, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
    }
    setError('');
    setErrorKind('');
    setAttachments((prev) => [...prev, ...accepted]);
  }

  function handleFileSelect(e) {
    const files = e.target.files;
    applyFiles(files);
    e.target.value = '';
  }

  // Lets a screenshot on the clipboard (Ctrl+V / Win+Shift+S) attach
  // directly without saving to disk first — same idea as TaskDetailModal's
  // comment paste handler.
  function handlePaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    e.preventDefault();
    applyFiles(files);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    applyFiles(e.dataTransfer.files);
  }

  function removeAttachment(index) {
    setAttachments((prev) => {
      if (prev[index]?.previewUrl) URL.revokeObjectURL(prev[index].previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function handleSubmit() {
    if (isLoading) return;
    if (!text.trim() && attachments.length === 0) {
      setError('Type something or attach a screenshot/PDF first.');
      return;
    }
    setIsLoading(true);
    setError('');
    setErrorKind('');
    try {
      // Reuses the same filteredContextData the token estimate above was
      // computed from — the plan is then resolved (ids checked, new: locals
      // assigned) against that identical filtered set too, so a reduced-
      // context request can never validate a reference the AI wasn't
      // actually shown.
      const { markdown } = buildAIContext({ ...filteredContextData, today: toISODate(new Date()), scope: effectiveScope });
      const { operations } = await requestAIPlan({
        provider,
        model,
        text: text.trim(),
        attachmentFiles: attachments.map((a) => a.file),
        contextMarkdown: markdown,
      });
      setPlan(resolvePlan(operations, filteredContextData));
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.');
      setErrorKind(err.kind || '');
    } finally {
      setIsLoading(false);
    }
  }

  if (plan) {
    return (
      <AIPlanConfirmModal
        plan={plan}
        onClose={() => setPlan(null)}
        onApplied={closeWholeFlow}
        onProjectCreated={onProjectCreated}
      />
    );
  }

  return (
    <>
    <Modal
      onClose={onClose}
      ariaLabel="AI Quick Add"
      variantClassName="modal-ai-quickadd"
      header={({ requestClose }) => (
        <div className="stat-list-modal-header">
          <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={16} aria-hidden="true" /> AI Quick Add
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              className="btn btn-icon ai-quickadd-help-btn"
              onClick={() => setShowGuide(true)}
              aria-label="How does this work?"
              title="How does this work?"
            >
              <HelpCircle size={16} />
            </button>
            <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    >
      {({ requestClose }) => (
        <>
        <p className="form-hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Describe what you want in your own words, or paste/attach screenshots or PDFs — add/edit/move tasks and
          events, break a task into subtasks, set up dependencies, reorganize projects — you'll review every change
          before anything is applied.
        </p>

        <div className="ai-quickadd-provider-row">
          <SelectMenu
            ariaLabel="AI provider"
            value={provider}
            onChange={changeProvider}
            options={[
              {
                value: 'anthropic',
                label: 'Claude',
                disabled: !hasKey.anthropic,
                disabledReason: hasKey.anthropic ? undefined : 'Add an Anthropic API key in Settings first',
              },
              {
                value: 'gemini',
                label: 'Gemini',
                disabled: !hasKey.gemini,
                disabledReason: hasKey.gemini ? undefined : 'Add a Gemini API key in Settings first',
              },
            ]}
          />
          <SelectMenu
            ariaLabel="AI model"
            value={model}
            onChange={changeModel}
            options={MODEL_CATALOG[provider].map((m) => ({ value: m.id, label: m.label }))}
          />
        </div>
        <p className="form-hint" style={{ marginTop: -6, marginBottom: 12 }}>
          {MODEL_CATALOG[provider].find((m) => m.id === model)?.hint}
        </p>

        <div className="ai-quickadd-provider-row">
          <SelectMenu
            ariaLabel="Workspace context sent to the AI"
            value={contextScope.mode}
            onChange={(mode) => updateContextScope({ mode })}
            options={CONTEXT_SCOPE_OPTIONS}
          />
          {contextScope.mode === 'custom' && (
            <SelectMenu
              ariaLabel="Restrict to one project"
              value={projectStillExists ? contextScope.projectId : ''}
              onChange={(projectId) => updateContextScope({ projectId })}
              options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
        </div>
        {contextScope.mode === 'custom' && (
          <div className="ai-quickadd-daterange-row">
            <label className="form-hint" htmlFor="ai-quickadd-event-start">
              Events from
            </label>
            <input
              id="ai-quickadd-event-start"
              type="date"
              value={contextScope.eventStart || defaultEventStart}
              onChange={(e) => updateContextScope({ eventStart: e.target.value })}
            />
            <label className="form-hint" htmlFor="ai-quickadd-event-end">
              to
            </label>
            <input
              id="ai-quickadd-event-end"
              type="date"
              value={contextScope.eventEnd || defaultEventEnd}
              onChange={(e) => updateContextScope({ eventEnd: e.target.value })}
            />
          </div>
        )}
        <p className="form-hint" style={{ marginTop: contextScope.mode === 'custom' ? 4 : -6, marginBottom: 12 }}>
          {contextScope.mode === 'full' &&
            'Sends your full workspace (all projects, tasks, and calendar events) so the AI can reference anything by id.'}
          {contextScope.mode === 'none' &&
            "Sends none of your existing workspace — the AI can still create new tasks/events/projects, it just can't reference anything existing."}
          {contextScope.mode === 'custom' &&
            'Restrict what the AI can see: pick one project and/or narrow the calendar events sent, leaving either at its default to not restrict it.'}
        </p>

        <div className="form-row">
          <textarea
            ref={textareaRef}
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            placeholder={
              'e.g. "Dentist appointment next Tuesday 2-3pm", "Break down the kitchen renovation into subtasks", or "Move all overdue Work tasks into a new Cleanup project"'
            }
          />
        </div>

        {attachments.length > 0 && (
          <div className="ai-quickadd-attachment-list">
            {attachments.map((a, i) => (
              <div className="ai-quickadd-attachment-item" key={i}>
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.file.name} />
                ) : (
                  <div className="ai-quickadd-attachment-file">
                    <FileText size={20} aria-hidden="true" />
                    <span title={a.file.name}>{a.file.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn-icon"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${a.file.name}`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.length < MAX_ATTACHMENTS && (
          <div
            className={`ai-quickadd-dropzone ${isDragOver ? 'is-dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <ImagePlus size={16} aria-hidden="true" />
            <span>Attach screenshots or PDFs, or drag them here / paste from clipboard</span>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />

        <p className="form-hint" style={{ marginTop: 8, marginBottom: 0 }}>
          ~{approxTotalTokens.toLocaleString()} tokens (approximate)
        </p>

        {error && (
          <p className="form-error">
            {error}
            {(errorKind === 'no_api_key' || errorKind === 'invalid_api_key') && (
              <>
                {' '}
                You can add it under Settings → Integrations → AI Quick Add.{' '}
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    requestClose();
                    scheduler.requestSettingsSection('integrations');
                  }}
                >
                  Open Settings
                </button>
              </>
            )}
            {errorKind === 'context_too_large' &&
              ' Completing or archiving some older tasks will shrink the workspace sent with each request.'}
            {SWITCHABLE_ERROR_KINDS.has(errorKind) && (
              <>
                {' '}
                <button type="button" className="btn-link" onClick={() => changeProvider(OTHER_PROVIDER[provider])}>
                  Switch to {PROVIDER_LABEL[OTHER_PROVIDER[provider]]}
                </button>
              </>
            )}
          </p>
        )}

        <div className="addtask-footer">
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className="btn" onClick={requestClose} disabled={isLoading}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 size={14} className="spin" /> Thinking…
                </>
              ) : (
                'Plan changes'
              )}
            </button>
          </div>
        </div>
        </>
      )}
    </Modal>
    {showGuide && <AIQuickAddGuideModal onClose={() => setShowGuide(false)} />}
    </>
  );
}
