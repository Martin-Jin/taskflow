/**
 * AIQuickAddModal — free-form text and/or a screenshot in, one new Task or
 * Event out. Sends the input to the companion Cloudflare Worker (see
 * cloudflare-worker/), which calls the user's choice of Claude or Gemini
 * with a fixed create_task/create_event tool schema and returns whichever
 * one fits — see services/aiQuickAddService.js for the request/response
 * contract and services/aiQuickAddService.resolveProjectId for how the AI's
 * freeform `projectName` guess gets matched back to a real Project.
 *
 * Deliberately separate from the client-only regex-based "smart parse"
 * feature (utils/smartParse.js / SmartTitleInput) — this is a full LLM call
 * for messier/longer input (or a screenshot) where typing shorthand isn't
 * practical, not a replacement for it.
 *
 * Only reachable when isAIQuickAddConfigured() is true (no worker URL set =
 * feature hidden entirely, see TaskListPanel.jsx/BoardView.jsx).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, X, ImagePlus, Loader2 } from 'lucide-react';
import { useScheduler } from '../../context/SchedulerContext';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea';
import { loadPersisted, savePersisted } from '../../utils/persistence';
import { toISODate } from '../../utils/dateUtils';
import { parseWithAI, resolveProjectId } from '../../services/aiQuickAddService';

const DEFAULT_ESTIMATED_HOURS = 5 / 60; // 5 minutes — same fallback AddTaskModal uses for an un-estimated task.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PROVIDER_STORAGE_KEY = 'aiQuickAddProvider';

export default function AIQuickAddModal({ onClose }) {
  const { addTask, addManualEvent, projects, labels, getOrCreateLabelIds } = useScheduler();
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);

  // Device-local UI preference, not user data — deliberately outside
  // SchedulerContext/backups (see this repo's CLAUDE.md backup rules).
  const [provider, setProvider] = useState(() => loadPersisted(PROVIDER_STORAGE_KEY, 'anthropic'));
  const [text, setText] = useState('');
  const textareaRef = useRef(null);
  useAutosizeTextarea(textareaRef, text, { maxLines: 8 });
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  // Revoke the previous preview's object URL whenever it changes/unmounts,
  // same leak-avoidance as TaskDetailModal's comment attachment preview.
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  function changeProvider(next) {
    setProvider(next);
    savePersisted(PROVIDER_STORAGE_KEY, next);
  }

  function applyImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Only image files can be attached.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('Image is too large — please use one under 5MB.');
      return;
    }
    setError('');
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
    try {
      const result = await parseWithAI({
        provider,
        text: text.trim(),
        imageFile,
        context: {
          today: toISODate(new Date()),
          projectNames: projects.map((p) => p.name),
          labelNames: labels.map((l) => l.name),
        },
      });

      if (result.type === 'event') {
        addManualEvent({
          title: result.data.title,
          date: result.data.date,
          startTime: result.data.startTime,
          endTime: result.data.endTime,
          description: result.data.description || '',
          location: result.data.location || '',
        });
      } else {
        const projectId = resolveProjectId(result.data.projectName, projects);
        const labelIds = result.data.labelNames?.length ? getOrCreateLabelIds(result.data.labelNames) : [];
        const hasDueDate = !!result.data.dueDate;
        addTask({
          title: result.data.title,
          notes: result.data.notes || '',
          estimatedHours: result.data.estimatedHours || DEFAULT_ESTIMATED_HOURS,
          priority: result.data.priority || 'medium',
          dueDate: result.data.dueDate || null,
          // A recurring task needs a starting due date, same guard AddTaskModal applies.
          isRecurring: !!result.data.isRecurring && hasDueDate,
          recurrenceString: result.data.isRecurring && hasDueDate ? result.data.recurrenceString : null,
          projectId: projectId || null,
          fixedTime: result.data.fixedTime || null,
          labelIds,
        });
      }
      requestClose();
    } catch (err) {
      setError(err.message || 'Something went wrong — please try again.');
    } finally {
      setIsLoading(false);
    }
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
          <button className="btn btn-icon detail-header-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="form-hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Describe a task or event in your own words, or paste/attach a screenshot — the AI figures out the rest.
        </p>

        <div className="ai-quickadd-provider-row">
          <button
            type="button"
            className={`ai-quickadd-provider-btn ${provider === 'anthropic' ? 'is-active' : ''}`}
            onClick={() => changeProvider('anthropic')}
          >
            Claude
          </button>
          <button
            type="button"
            className={`ai-quickadd-provider-btn ${provider === 'gemini' ? 'is-active' : ''}`}
            onClick={() => changeProvider('gemini')}
          >
            Gemini
          </button>
        </div>

        <div className="form-row">
          <textarea
            ref={textareaRef}
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            placeholder={'e.g. "Dentist appointment next Tuesday 2-3pm" or "Finish the quarterly report by Friday, ~3 hours, high priority"'}
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

        {error && (
          <p className="form-error">
            {error}
            {error.includes('API key') && ' You can add it under Settings → Integrations → AI Quick Add.'}
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
                'Create'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
