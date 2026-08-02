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
 * `hasSeenTutorial` flag) and replayable anytime from Settings.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAnimatedUnmount } from '../../hooks/useAnimatedUnmount';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useIsMobile } from '../../hooks/useIsMobile';
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

/**
 * Where to place the tooltip for a given target rect, flipping to the
 * opposite side if it would overflow the viewport. For 'top'/'bottom', the
 * final clamp is bounded to whichever side of the rect the tooltip landed on
 * (not the full viewport) — otherwise a rect taller than the available space
 * (common on short mobile viewports, e.g. a settings card scrolled to
 * center) would get clamped right back on top of the spotlighted element.
 */
function computeTooltipPosition(rect, placement, tooltipHeight) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect || placement === 'center') {
    return { top: vh / 2 - tooltipHeight / 2, left: vw / 2 - TOOLTIP_WIDTH / 2 };
  }

  let top;
  let left;
  let minTop = EDGE_MARGIN;
  let maxTop = vh - tooltipHeight - EDGE_MARGIN;

  switch (placement) {
    case 'right':
      left = rect.right + GAP;
      top = rect.top + rect.height / 2 - tooltipHeight / 2;
      if (left + TOOLTIP_WIDTH > vw - EDGE_MARGIN) left = rect.left - TOOLTIP_WIDTH - GAP;
      break;
    case 'top': {
      const spaceAbove = rect.top - GAP - EDGE_MARGIN;
      const spaceBelow = vh - rect.bottom - GAP - EDGE_MARGIN;
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      if (spaceAbove >= tooltipHeight || spaceAbove >= spaceBelow) {
        top = rect.top - tooltipHeight - GAP;
        maxTop = Math.max(minTop, rect.top - GAP - tooltipHeight);
      } else {
        top = rect.bottom + GAP;
        minTop = Math.min(maxTop, rect.bottom + GAP);
      }
      break;
    }
    case 'bottom':
    default: {
      const spaceBelow = vh - rect.bottom - GAP - EDGE_MARGIN;
      const spaceAbove = rect.top - GAP - EDGE_MARGIN;
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      if (spaceBelow >= tooltipHeight || spaceBelow >= spaceAbove) {
        top = rect.bottom + GAP;
        minTop = Math.min(maxTop, rect.bottom + GAP);
      } else {
        top = rect.top - tooltipHeight - GAP;
        maxTop = Math.max(minTop, rect.top - GAP - tooltipHeight);
      }
      break;
    }
  }

  return {
    top: clamp(top, minTop, maxTop),
    left: clamp(left, EDGE_MARGIN, vw - TOOLTIP_WIDTH - EDGE_MARGIN),
  };
}

export default function GuidedTour({ currentTab, tabs, onTabChange, onViewChange, onFinish }) {
  const { isClosing, requestClose } = useAnimatedUnmount(onFinish);
  const tooltipRef = useModalA11y(requestClose);
  const isMobile = useIsMobile();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState(null);
  // True only while a scroll/resize-driven reposition is in flight — see the
  // tracking effect below. Suppresses the spotlight's CSS transition for
  // those updates (an animated move to a brand-new step still gets it).
  const [isTracking, setIsTracking] = useState(false);
  // Corrected to the tooltip's real rendered height below, once it's known —
  // starts as a guess so the very first position computation has something
  // to work with before that measurement effect has run.
  const [tooltipHeight, setTooltipHeight] = useState(TOOLTIP_HEIGHT_ESTIMATE);
  // Which way the last goNext/goBack moved — read by the desktopOnly skip
  // effect below so skipping continues in the same direction the visitor
  // was already navigating, instead of always skipping forward.
  const skipDirection = useRef('next');

  // Steps flagged `desktopOnly` (e.g. Manual Plan Today, whose toggle has no
  // mobile equivalent at all) skip past themselves as soon as they'd become
  // current on a mobile viewport — otherwise the locate effect below would
  // just time out and fall back to a spotlight-less tooltip describing a
  // control the visitor can't reach.
  useEffect(() => {
    if (!isMobile) return;
    const step = GUIDED_TOUR_STEPS[stepIndex];
    if (!step.desktopOnly) return;
    setStepIndex((i) => clamp(i + (skipDirection.current === 'back' ? -1 : 1), 0, GUIDED_TOUR_STEPS.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, isMobile]);

  const step = GUIDED_TOUR_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === GUIDED_TOUR_STEPS.length - 1;
  // step.tab is this step's DESTINATION tab, so the badge always names the
  // page the spotlighted element actually lives on — reading currentTab
  // instead would show the page we're navigating away from for one render,
  // since the tab-switch effect below fires after this render commits.
  const pageLabel = step.tab ? tabs?.find((t) => t.id === step.tab)?.label : 'Overview';

  // Jump to whichever tab (and, for steps inside the Tasks page, sub-view —
  // e.g. Board/Gantt, no longer their own tabs) this step's target lives on.
  useEffect(() => {
    if (step.tab && step.tab !== currentTab) onTabChange(step.tab);
    if (step.view) onViewChange?.(step.view);
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
        setIsTracking(false);
        setRect(el.getBoundingClientRect());
      } else if (attempts < LOCATE_MAX_ATTEMPTS) {
        attempts += 1;
        timer = setTimeout(locate, LOCATE_RETRY_MS);
      } else {
        setRect(null);
      }
    }
    setRect(null);
    setIsTracking(false);
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
    let idleTimer;
    function reposition() {
      if (frameRequested) return;
      frameRequested = true;
      requestAnimationFrame(() => {
        frameRequested = false;
        const el = document.querySelector(step.selector);
        if (el) {
          setIsTracking(true);
          setRect(el.getBoundingClientRect());
        }
      });
      // Scroll events fire in bursts; only flip the tracking flag back off
      // once a burst has actually gone quiet, so the transition stays
      // suppressed for the whole gesture rather than flickering back on
      // between frames.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIsTracking(false), 150);
    }
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      clearTimeout(idleTimer);
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
    skipDirection.current = 'next';
    setStepIndex((i) => i + 1);
  }

  function goBack() {
    skipDirection.current = 'back';
    setStepIndex((i) => Math.max(0, i - 1));
  }

  // On mobile, nav steps target the bottom tab bar, and the very first step
  // targets the brand mark in the corner of the topbar — both are small,
  // edge-anchored elements with no room on their `right`/`left` side for a
  // 300px tooltip, so computeTooltipPosition's overflow fallback just flips
  // it back on top of the element it's supposed to be explaining. Center the
  // tooltip on screen instead for these; the spotlight still highlights the
  // real element.
  const isEdgeAnchoredMobileStep =
    isMobile && (step.selector.startsWith('[data-tour="nav-') || step.selector === '[data-tour="brand"]');
  const tooltipPos = computeTooltipPosition(rect, isEdgeAnchoredMobileStep ? 'center' : step.placement, tooltipHeight);

  return (
    <div className={`guided-tour-overlay ${isClosing ? 'is-closing' : ''}`} onClick={requestClose}>
      {!rect && <div className="guided-tour-dim" />}
      {rect && (
        <div
          className={`guided-tour-spotlight ${isTracking ? 'guided-tour-spotlight--tracking' : ''}`}
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
