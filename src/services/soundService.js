/**
 * soundService — plays short, licensed sound-effect files (Mixkit Sound
 * Effects Free License, commercial/personal use, no attribution required —
 * see src/assets/sounds/) for the app's task actions (add/complete/
 * uncomplete/delete).
 *
 * Uses the Web Audio API (AudioContext + decodeAudioData + BufferSource)
 * rather than plain <audio> elements: each source file is fetched and
 * decoded ONCE (cached as a shared AudioBuffer promise), then every play
 * call spins up a fresh BufferSourceNode from that buffer. That gives
 * low-latency, overlap-safe playback — rapid task-row clicks each get their
 * own source node and can layer/retrigger without cutting an earlier one
 * off, which a shared <audio> element (single playback position) can't do.
 *
 * There's no separate "uncomplete" audio file — playUncompleteSound reuses
 * whichever file playCompleteSound plays (see SOUND_URLS below), just at a
 * slightly lower playbackRate, so unchecking a task sounds like a
 * related-but-distinct variant of the same click.
 *
 * A single AudioContext is created lazily on first play — browsers block
 * autoplay until a user gesture, and every call site here (task actions) is
 * itself triggered by a click, so lazy creation naturally satisfies that.
 */

import addUrl from '../assets/sounds/add.mp3';
import completeUrl from '../assets/sounds/complete.mp3';
import deleteUrl from '../assets/sounds/delete.mp3';

// Swapped on purpose: Mixkit's "complete.mp3" ("Modern click box check") now
// plays for adding a task, and "add.mp3" ("Opening software interface") now
// plays for completing one — better tonal fit than the original pairing.
const SOUND_URLS = { add: completeUrl, complete: addUrl, delete: deleteUrl };

let audioCtx = null;

function getContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Decoded-buffer cache, keyed by sound name — each file is fetched+decoded
// at most once per page load, regardless of how many times/how soon after
// each other it's played.
const bufferPromises = {};

function loadBuffer(ctx, key) {
  if (!bufferPromises[key]) {
    bufferPromises[key] = fetch(SOUND_URLS[key])
      .then((res) => res.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data));
  }
  return bufferPromises[key];
}

function playBuffer(ctx, buffer, { volume = 1, playbackRate = 1 } = {}) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;

  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, Math.min(1, volume));

  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(0);
}

async function playSound(key, volume, opts) {
  const ctx = getContext();
  if (!ctx) return;
  try {
    const buffer = await loadBuffer(ctx, key);
    playBuffer(ctx, buffer, { volume, ...opts });
  } catch (err) {
    console.warn(`[soundService] Failed to play "${key}" sound`, err);
  }
}

/** Adding a task. `volume` (0-1) comes from the shared soundVolume setting. */
export function playAddSound(volume = 1) {
  playSound('add', volume);
}

/** Completing a task. */
export function playCompleteSound(volume = 1) {
  playSound('complete', volume);
}

/** Uncompleting a task — same file as complete, pitched down slightly so it reads as a related-but-distinct variant. */
export function playUncompleteSound(volume = 1) {
  playSound('complete', volume, { playbackRate: 0.85 });
}

/** Deleting a task. */
export function playDeleteSound(volume = 1) {
  playSound('delete', volume);
}
