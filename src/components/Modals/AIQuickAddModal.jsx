/**
 * AIQuickAddModal — free-form text and/or a screenshot in, a reviewable plan
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
import { Sparkles, X, ImagePlus, Loader2, HelpCircle } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { loadPersisted, savePersisted } from '../../utils/persistence';
import { toISODate } from '../../utils/dateUtils';
import { requestAIPlan, getStoredApiKey } from '../../services/aiQuickAddService';
import { buildAIContext, estimateTokens } from '../../services/aiContextService';
import { resolvePlan } from '../../services/aiPlanService';
import { MODEL_CATALOG, getDefaultModelId, isValidModelId } from '../../services/aiModels';
import SelectMenu from '../Common/SelectMenu';
import AIQuickAddGuideModal from './AIQuickAddGuideModal';
import AIPlanConfirmModal from './AIPlanConfirmModal';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PROVIDER_STORAGE_KEY = 'aiQuickAddProvider';
const MODEL_STORAGE_KEY = 'aiQuickAddModelByProvider';
const PROVIDER_LABEL = { anthropic: 'Claude', gemini: 'Gemini' };
const OTHER_PROVIDER = { anthropic: 'gemini', gemini: 'anthropic' };
// error `kind`s (see aiQuickAddService.AIRequestError) where offering an
// immediate "switch provider" shortcut actually helps, vs. kinds where
// switching provider wouldn't fix anything (bad request, network, etc).
const SWITCHABLE_ERROR_KINDS = new Set(['quota_exhausted', 'rate_limit']);

export default function AIQuickAddModal({ onClose }) {
  const scheduler = useScheduler();
  const { tasks, projects, sections, labels, events } = scheduler;
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

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
  const [text, setText] = useState('');
  const textareaRef = useRef(null);
  useAutosizeTextarea(textareaRef, text, { maxLines: 4 });
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [plan, setPlan] = useState(null);
  const fileInputRef = useRef(null);

  // Only rebuilds when the workspace itself changes, not on every keystroke —
  // context.md's bulk is the workspace snapshot, which is unrelated to what
  // the user is currently typing (see aiContextService.buildAIContext).
  const contextTokens = useMemo(
    () => buildAIContext({ tasks, projects, sections, labels, events, today: toISODate(new Date()) }).approxTokens,
    [tasks, projects, sections, labels, events]
  );
  const approxTotalTokens = contextTokens + estimateTokens(text);

  // Revoke the previous preview's object URL whenever it changes/unmounts,
  // same leak-avoidance as TaskDetailModal's comment attachment preview.
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

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

  function applyImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Only image files can be attached.');
      setErrorKind('');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('Image is too large — please use one under 5MB.');
      setErrorKind('');
      return;
    }
    setError('');
    setErrorKind('');
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    applyImageFile(file);
  }

  // Lets a screenshot on the clipboard (Ctrl+V / Win+Shift+S) attach
  // directly without saving to disk first — same idea as TaskDetailModal's
  // comment paste handler.
  function handlePaste(e) {
    const file = Array.from(e.clipboardData?.items || [])
      .find((item) => item.kind === 'file')
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    applyImageFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    applyImageFile(e.dataTransfer.files?.[0]);
  }

  function removeImage() {
    setImageFile(null);
    setImagePreview(null);
  }

  async function handleSubmit() {
    if (isLoading) return;
    if (!text.trim() && !imageFile) {
      setError('Type something or attach a screenshot first.');
      return;
    }
    setIsLoading(true);
    setError('');
    setErrorKind('');
    try {
      const { markdown } = buildAIContext({ tasks, projects, sections, labels, events, today: toISODate(new Date()) });
      const { operations } = await requestAIPlan({
        provider,
        model,
        text: text.trim(),
        imageFile,
        contextMarkdown: markdown,
      });
      setPlan(resolvePlan(operations, { tasks, projects, sections, labels, events }));
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.');
      setErrorKind(err.kind || '');
    } finally {
      setIsLoading(false);
    }
  }

  if (plan) {
    return <AIPlanConfirmModal plan={plan} onClose={() => setPlan(null)} onApplied={requestClose} />;
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal modal-ai-quickadd"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="AI Quick Add"
        tabIndex={-1}
      >
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

        <p className="form-hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Describe what you want in your own words, or paste/attach a screenshot — add/edit/move tasks and events,
          break a task into subtasks, set up dependencies, reorganize projects — you'll review every change before
          anything is applied.
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

        {imagePreview ? (
          <div className="ai-quickadd-image-preview">
            <img src={imagePreview} alt="Attached screenshot" />
            <button type="button" className="btn btn-icon" onClick={removeImage} aria-label="Remove image">
              <X size={14} />
            </button>
          </div>
        ) : (
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
            <span>Attach a screenshot, or drag one here / paste from clipboard</span>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileSelect} />

        <p className="form-hint" style={{ marginTop: 8, marginBottom: 0 }}>
          ~{approxTotalTokens.toLocaleString()} tokens (approximate)
        </p>

        {error && (
          <p className="form-error">
            {error}
            {(errorKind === 'no_api_key' || errorKind === 'invalid_api_key') &&
              ' You can add it under Settings → Integrations → AI Quick Add.'}
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
      </div>
      {showGuide && <AIQuickAddGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}
