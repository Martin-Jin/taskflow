/**
 * soundService — short, percussive "pop"/"thock" sound effects synthesized
 * with the Web Audio API (no binary audio assets). Modeled after Todoist's
 * task-complete sound: fast attack, very fast decay, no ringing sustain —
 * a tactile click rather than a musical chime/bell/ding.
 *
 * Each sound layers two things:
 *   - a short filtered-noise burst (a `BufferSource` of white noise through a
 *     bandpass/lowpass filter) for the "thock" texture, and
 *   - a quick pitched tone blip (an oscillator with an exponential decay)
 *     for a bit of tonal character to distinguish actions.
 * Both layers decay to (near) silence in well under 200ms, so nothing here
 * ever sustains or rings like a notification sound.
 *
 * A single AudioContext is created lazily on first play — browsers block
 * autoplay until a user gesture, and every call site here (task actions) is
 * itself triggered by a click, so lazy creation naturally satisfies that.
 */

let audioCtx = null;

function getContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Short noise burst through a bandpass filter — the percussive "pop" body.
function playNoiseBurst(ctx, { duration = 0.06, filterFreq = 1200, filterQ = 0.7, gain = 0.25, startAt = 0 } = {}) {
  const startTime = ctx.currentTime + startAt;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = filterQ;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(gain, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(ctx.destination);

  noise.start(startTime);
  noise.stop(startTime + duration);
}

// Quick pitched tone blip with a fast decay envelope — no sustain/release,
// so it reads as a tap rather than a note.
function playToneBlip(ctx, { freqStart = 440, freqEnd = null, duration = 0.09, gain = 0.2, type = 'sine', startAt = 0 } = {}) {
  const startTime = ctx.currentTime + startAt;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, startTime);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, startTime + duration);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(gain, startTime);
  oscGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(oscGain);
  oscGain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** Adding a task: a bright, quick upward pop — something was just created. */
export function playAddSound() {
  const ctx = getContext();
  if (!ctx) return;
  playNoiseBurst(ctx, { duration: 0.05, filterFreq: 1500, gain: 0.2 });
  playToneBlip(ctx, { freqStart: 420, freqEnd: 640, duration: 0.09, gain: 0.18, type: 'triangle' });
}

/** Completing a task: Todoist-style soft "pop" — brighter/higher than add. */
export function playCompleteSound() {
  const ctx = getContext();
  if (!ctx) return;
  playNoiseBurst(ctx, { duration: 0.05, filterFreq: 1800, gain: 0.22 });
  playToneBlip(ctx, { freqStart: 520, freqEnd: 780, duration: 0.1, gain: 0.2, type: 'sine' });
}

/** Uncompleting a task: same "pop" family as complete, pitched a bit lower. */
export function playUncompleteSound() {
  const ctx = getContext();
  if (!ctx) return;
  playNoiseBurst(ctx, { duration: 0.05, filterFreq: 1400, gain: 0.2 });
  playToneBlip(ctx, { freqStart: 460, freqEnd: 340, duration: 0.1, gain: 0.18, type: 'sine' });
}

/** Deleting a task: duller/lower and slightly longer — a "thud" not a pop. */
export function playDeleteSound() {
  const ctx = getContext();
  if (!ctx) return;
  playNoiseBurst(ctx, { duration: 0.08, filterFreq: 600, filterQ: 0.5, gain: 0.22 });
  playToneBlip(ctx, { freqStart: 300, freqEnd: 160, duration: 0.13, gain: 0.16, type: 'sine' });
}

/** Selecting/opening a task: very subtle — this fires often (every row click). */
export function playSelectSound() {
  const ctx = getContext();
  if (!ctx) return;
  playNoiseBurst(ctx, { duration: 0.03, filterFreq: 2000, gain: 0.09 });
}
