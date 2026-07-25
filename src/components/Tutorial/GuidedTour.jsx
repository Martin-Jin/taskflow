/**
 * GuidedTour — a spotlight-style walkthrough that highlights real on-screen
 * elements (nav items, key buttons, settings cards) rather than a
 * standalone content carousel. Steps live in guidedTourSteps.js and name a
 * `[data-tour="..."]` selector plus (optionally) which tab that element
 * lives on; this component switches tabs as it advances and re-locates the
 * target after each switch, since the element doesn't exist until the tab
 * it belongs to has rendered.
 *
 * Auto-launched once on a new visitor's first session (see App.jsx's
 * `hasSeenTutorial` flag) and replayable anytime from Settings or the
 * topbar help icon.
 */

import React, { useEffect, useLayoutEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { GUIDED_TOUR_STEPS } from './guidedTourSteps';

const SPOTLIGHT_PADDING = 6;
const TOOLTIP_WIDTH = 300;
const TOOLTIP_HEIGHT_ESTIMATE = 170; // Initial guess only, before the tooltip's real height is measured (see tooltipHeight state) — copy length varies per step.
const EDGE_MARGIN = 12;
const GAP = 14;
const LOCATE_RETRY_MS = 50;
const LOCATE_MAX_ATTEMPTS = 40; // ~2s — covers a tab switch's render + any data fetch it triggers.

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Where to place the tooltip for a given target rect, flipping to the opposite side if it would overflow the viewport. */
function computeTooltipPosition(rect, placement, tooltipHeight) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect) {
    return { top: vh / 2 - tooltipHeight / 2, left: vw / 2 - TOOLTIP_WIDTH / 2 };
  }

  let top;
  let left;
  switch (placement) {
    case 'right':
      left = rect.right + GAP;
      top = rect.top + rect.height / 2 - tooltipHeight / 2;
      if (left + TOOLTIP_WIDTH > vw - EDGE_MARGIN) left = rect.left - TOOLTIP_WIDTH - GAP;
      break;
    case 'top':
      top = rect.top - tooltipHeight - GAP;
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      if (top < EDGE_MARGIN) top = rect.bottom + GAP;
      break;
    case 'bottom':
    default:
      top = rect.bottom + GAP;
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      if (top + tooltipHeight > vh - EDGE_MARGIN) top = rect.top - tooltipHeight - GAP;
      break;
  }

  return {
    top: clamp(top, EDGE_MARGIN, vh - tooltipHeight - EDGE_MARGIN),
    left: clamp(left, EDGE_MARGIN, vw - TOOLTIP_WIDTH - EDGE_MARGIN),
  };
}

export default function GuidedTour({ currentTab, tabs, onTabChange, onFinish }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onFinish);
  const tooltipRef = useModalA11y(requestClose);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState(null);
  // Corrected to the tooltip's real rendered height below, once it's known —
  // starts as a guess so the very first position computation has something
  // to work with before that measurement effect has run.
  const [tooltipHeight, setTooltipHeight] = useState(TOOLTIP_HEIGHT_ESTIMATE);

  const step = GUIDED_TOUR_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === GUIDED_TOUR_STEPS.length - 1;
  // step.tab is this step's DESTINATION tab, so the badge always names the
  // page the spotlighted element actually lives on — reading currentTab
  // instead would show the page we're navigating away from for one render,
  // since the tab-switch effect below fires after this render commits.
  const pageLabel = step.tab ? tabs?.find((t) => t.id === step.tab)?.label : 'Overview';

  // Jump to whichever tab this step's target lives on.
  useEffect(() => {
    if (step.tab && step.tab !== currentTab) onTabChange(step.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Locate the target element, retrying briefly — a tab switch above needs
  // a render pass (and sometimes an async fetch) before the element exists.
  // If it never appears (e.g. a nav item hidden on mobile), fall back to a
  // centered tooltip with no spotlight rather than getting stuck.
  useLayoutEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer;

    function locate() {
      if (cancelled) return;
      const el = document.querySelector(step.selector);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setRect(el.getBoundingClientRect());
      } else if (attempts < LOCATE_MAX_ATTEMPTS) {
        attempts += 1;
        timer = setTimeout(locate, LOCATE_RETRY_MS);
      } else {
        setRect(null);
      }
    }
    setRect(null);
    locate();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stepIndex, step.selector]);

  // Keep the spotlight glued to its target through scrolling/resizing.
  // Scroll fires far more often than a frame renders, so this coalesces
  // bursts down to one reposition per animation frame instead of one
  // `setRect` (and re-render) per scroll event.
  useEffect(() => {
    let frameRequested = false;
    function reposition() {
      if (frameRequested) return;
      frameRequested = true;
      requestAnimationFrame(() => {
        frameRequested = false;
        const el = document.querySelector(step.selector);
        if (el) setRect(el.getBoundingClientRect());
      });
    }
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [step.selector]);

  // Re-measure after every render that could change the tooltip's height
  // (new step copy, or the spotlight/no-spotlight branch swapping in/out) so
  // computeTooltipPosition's flip/clamp math uses the real height instead of
  // the fixed estimate.
  useLayoutEffect(() => {
    const height = tooltipRef.current?.offsetHeight;
    if (height && height !== tooltipHeight) setTooltipHeight(height);
  });

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

  const tooltipPos = computeTooltipPosition(rect, step.placement, tooltipHeight);

  return (
    <div className={`guided-tour-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      {!rect && <div className="guided-tour-dim" />}
      {rect && (
        <div
          className="guided-tour-spotlight"
          style={{
            top: rect.top - SPOTLIGHT_PADDING,
            left: rect.left - SPOTLIGHT_PADDING,
            width: rect.width + SPOTLIGHT_PADDING * 2,
            height: rect.height + SPOTLIGHT_PADDING * 2,
          }}
        />
      )}
      <div
        className="guided-tour-tooltip"
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
        ref={tooltipRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-title"
        tabIndex={-1}
      >
        <button className="btn btn-icon guided-tour-close" onClick={requestClose} title="Close" aria-label="Close tour">
          <X size={14} />
        </button>
        <div className="guided-tour-step-count">
          {pageLabel && <span className="guided-tour-page-badge">{pageLabel}</span>}
          Step {stepIndex + 1} of {GUIDED_TOUR_STEPS.length}
        </div>
        <h4 id="guided-tour-title" className="guided-tour-title">
          {step.title}
        </h4>
        <p className="guided-tour-body">{step.body}</p>
        <div className="guided-tour-actions">
          <button className="btn" onClick={isFirst ? requestClose : goBack}>
            {isFirst ? 'Skip' : 'Back'}
          </button>
          <button className="btn btn-primary" onClick={goNext}>
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
