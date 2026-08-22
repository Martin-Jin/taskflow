/**
 * soundService — plays short sound effects for the app's task actions
 * (add/complete/uncomplete/delete). Add/complete play licensed Mixkit files
 * (Sound Effects Free License, commercial/personal use, no attribution
 * required — see src/assets/sounds/); delete is synthesized live at play
 * time via Web Audio oscillators/noise rather than a decoded file (see
 * playDeleteSound below).
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

// Swapped on purpose: Mixkit's "complete.mp3" ("Modern click box check") now
// plays for adding a task, and "add.mp3" ("Opening software interface") now
// plays for completing one — better tonal fit than the original pairing.
const SOUND_URLS = { add: completeUrl, complete: addUrl };

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

/**
 * Deleting a task — synthesized live (no audio file) rather than decoded
 * from a Mixkit asset like the others. A crisp noise "clack" transient plus
 * a short pitched "thock" underneath it, modeled on a satisfying mechanical
 * keyboard switch (the same tactile quality the complete/add clicks have),
 * just pitched a bit lower/darker so it still reads as distinct from them.
 */
export function playDeleteSound(volume = 1) {
  const ctx = getContext();
  if (!ctx) return;
  try {
    playDeleteClick(ctx, Math.max(0, Math.min(1, volume)));
  } catch (err) {
    console.warn('[soundService] Failed to play "delete" sound', err);
  }
}

function playDeleteClick(ctx, volume) {
  const now = ctx.currentTime;
  const masterGain = ctx.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(ctx.destination);

  // Transient "clack" — a very short burst of highpass-filtered noise for
  // the sharp attack of a key switch snapping.
  const clickDuration = 0.02;
  const noiseBuffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * clickDuration), ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;

  const clickFilter = ctx.createBiquadFilter();
  clickFilter.type = 'highpass';
  clickFilter.frequency.value = 2800;

  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.9, now);
  clickGain.gain.exponentialRampToValueAtTime(0.001, now + clickDuration);

  noiseSource.connect(clickFilter);
  clickFilter.connect(clickGain);
  clickGain.connect(masterGain);
  noiseSource.start(now);
  noiseSource.stop(now + clickDuration);

  // Body "thock" — a short pitched tone right under the transient, like the
  // switch bottoming out. Lower and darker than the add/complete clicks so
  // delete still reads as its own, distinct sound.
  const bodyOsc = ctx.createOscillator();
  bodyOsc.type = 'triangle';
  bodyOsc.frequency.setValueAtTime(420, now);
  bodyOsc.frequency.exponentialRampToValueAtTime(210, now + 0.05);

  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0, now);
  bodyGain.gain.linearRampToValueAtTime(0.55, now + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

  bodyOsc.connect(bodyGain);
  bodyGain.connect(masterGain);
  bodyOsc.start(now);
  bodyOsc.stop(now + 0.09);
}
