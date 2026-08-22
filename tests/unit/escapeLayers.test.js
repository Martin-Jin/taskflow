/**
 * Coverage for the shared Escape stack.
 *
 * The bug this replaced was an ordering bug, so the ordering cases are the
 * point: exactly one layer acts, it's always the innermost, and the stack
 * survives being unwound out of order. Getting this wrong is expensive in a
 * way a functional assertion won't catch — the original symptom was one
 * keypress silently discarding a half-written task.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerEscapeLayer, escapeLayerCount, dispatchEscape } from '../../src/hooks/useEscapeLayer';

/** A stand-in for the keydown event the real document listener passes through. */
function keydown(key) {
  return { key, propagationStopped: false, defaultPrevented: false,
    stopPropagation() { this.propagationStopped = true; },
    preventDefault() { this.defaultPrevented = true; } };
}

function pressEscape() {
  const event = keydown('Escape');
  dispatchEscape(event);
  return event;
}

describe('escape layers', () => {
  let unregisters;

  beforeEach(() => {
    unregisters = [];
  });

  afterEach(() => {
    unregisters.forEach((u) => u());
    expect(escapeLayerCount()).toBe(0);
  });

  function layer() {
    const onEscape = vi.fn();
    unregisters.push(registerEscapeLayer(onEscape));
    return onEscape;
  }

  it('routes Escape to the only layer', () => {
    const only = layer();
    pressEscape();
    expect(only).toHaveBeenCalledTimes(1);
  });

  it('routes Escape to the innermost layer, and only that one', () => {
    // The whole bug: a modal (outer) and the dropdown inside it (inner) both
    // wanted this keypress, and the modal won — closing the modal and
    // discarding its draft instead of just closing the dropdown.
    const modal = layer();
    const dropdown = layer();
    pressEscape();
    expect(dropdown).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
  });

  it('falls back to the layer below once the inner one unregisters', () => {
    // The second press, i.e. "Escape closed my dropdown, Escape again closes
    // the modal" — the behaviour a user expects from a stack of surfaces.
    const modal = layer();
    const dropdown = layer();
    pressEscape();
    unregisters.pop()();
    pressEscape();
    expect(dropdown).toHaveBeenCalledTimes(1);
    expect(modal).toHaveBeenCalledTimes(1);
  });

  it('stops propagation so no other handler also acts on the keypress', () => {
    layer();
    expect(pressEscape().propagationStopped).toBe(true);
  });

  it('leaves the keypress alone when nothing is open, so page shortcuts still see it', () => {
    const event = keydown('Escape');
    expect(dispatchEscape(event)).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  it('does not preventDefault, so a native control keeps its own Escape', () => {
    // A native <select> with its OS-rendered option list open needs the
    // browser's default Escape behaviour, and that list isn't ours to close.
    layer();
    const event = pressEscape();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores every other key', () => {
    const onEscape = layer();
    const enter = keydown('Enter');
    expect(dispatchEscape(enter)).toBe(false);
    expect(enter.propagationStopped).toBe(false);
    expect(dispatchEscape(keydown('a'))).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('does nothing when no layer is registered', () => {
    expect(() => pressEscape()).not.toThrow();
    expect(escapeLayerCount()).toBe(0);
  });

  it('unwinds correctly when a middle layer leaves first', () => {
    // React doesn't guarantee unmount order matches mount order, so a layer
    // in the middle can go first. It must remove ITS entry, not the topmost.
    const outer = layer();
    const middleUnregister = unregisters[unregisters.length - 1];
    const middle = layer();
    void middle;
    const inner = layer();

    middleUnregister();
    unregisters.splice(unregisters.indexOf(middleUnregister), 1);

    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('is idempotent on a double unregister rather than dropping someone else', () => {
    // splice() reads a negative index as "count back from the end", so an
    // unguarded splice(-1, 1) on a double cleanup would silently remove the
    // topmost layer — a different component's.
    const outer = layer();
    const doomedUnregister = unregisters[unregisters.length - 1];
    const inner = layer();

    doomedUnregister();
    doomedUnregister();
    unregisters.splice(unregisters.indexOf(doomedUnregister), 1);

    expect(escapeLayerCount()).toBe(1);
    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
