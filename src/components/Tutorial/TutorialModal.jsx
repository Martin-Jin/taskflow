/**
 * TutorialModal — a lightweight step-by-step walkthrough, launched on
 * demand (from Settings or the topbar help icon) rather than forced on
 * first run. Deliberately a simple modal carousel rather than a
 * DOM-spotlight/tour-library overlay — this app has no other dependency
 * on that kind of positioning engine, and a carousel covers "explain the
 * app's concepts" just as well without the extra complexity/weight.
 */

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { TUTORIAL_STEPS } from './tutorialSteps';

export default function TutorialModal({ onClose }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onClose);
  const modalRef = useModalA11y(requestClose);
  const [stepIndex, setStepIndex] = useState(0);

  const step = TUTORIAL_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === TUTORIAL_STEPS.length - 1;
  const Icon = step.icon;

  function goNext() {
    if (isLast) {
      requestClose();
      return;
    }
    setStepIndex((i) => i + 1);
  }

  function goBack() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  return (
    <div className={`modal-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      <div
        className="modal tutorial-modal"
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-modal-title"
        tabIndex={-1}
      >
        <button className="btn btn-icon tutorial-close" onClick={requestClose} title="Close" aria-label="Close tutorial">
          <X size={15} />
        </button>

        <div className="tutorial-icon">
          <Icon size={28} strokeWidth={1.5} />
        </div>

        <h3 id="tutorial-modal-title" className="tutorial-title">{step.title}</h3>
        <p className="tutorial-body">{step.body}</p>

        <div className="tutorial-dots">
          {TUTORIAL_STEPS.map((_, i) => (
            <button
              key={i}
              className={`tutorial-dot ${i === stepIndex ? 'active' : ''}`}
              onClick={() => setStepIndex(i)}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        <div className="tutorial-actions">
          <button className="btn" onClick={isFirst ? requestClose : goBack}>
            {isFirst ? (
              'Skip'
            ) : (
              <>
                <ChevronLeft size={14} /> Back
              </>
            )}
          </button>
          <button className="btn btn-primary" onClick={goNext}>
            {isLast ? (
              'Done'
            ) : (
              <>
                Next <ChevronRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
