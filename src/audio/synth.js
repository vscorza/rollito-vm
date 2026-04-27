import { lookupFreq } from './notes.js';

// Synth con 5 canales: 4 tonales (0..3) + 1 ruido (4). Dos modos:
//   - real: con AudioContext, agenda OscillatorNode/GainNode/AudioParam.
//   - headless: clock interno; usado en tests sin DOM.
//
// Eventos consumidos por el VM cada cuadro:
//   - pendingChannelEvents[c] = 1 cuando el canal c termina su sonido.
//   - pendingSilenceEvent = true cuando el último canal activo se calló.
//
// Forma de definir un sonido (output del parser de bloque SONIDO):
//   {
//     wave: 'TRI'|'SIE'|'PUL'|'SEN',
//     pulseWidth: 0..15,
//     env: { a, d, s, r },     // 0..15 cada uno, ticks (1/60 s)
//     steps: [
//       { type: 'note', semitone: 0..11, octave: 0..7, ticks },
//       { type: 'silence', ticks },
//     ]
//   }

export const TONAL_CHANNELS = 4;
export const NOISE_CHANNEL = 4;
export const TOTAL_CHANNELS = 5;
export const SOUND_SLOTS = 16;
const TICK_SEC = 1 / 60;
const PEAK_GAIN = 0.25;  // headroom para 4 canales mezclados sin clip

const WAVE_TYPE = { TRI: 'triangle', SIE: 'sawtooth', PUL: 'square', SEN: 'sine' };

export function createSynth(audioCtx = null) {
  const channels = new Array(TOTAL_CHANNELS);
  for (let c = 0; c < TOTAL_CHANNELS; c++) {
    channels[c] = { isPlaying: false, finishesAt: 0, timeoutId: null };
  }
  const synth = {
    audioCtx,
    sounds: new Array(SOUND_SLOTS),
    channels,
    pendingChannelEvents: new Uint8Array(TOTAL_CHANNELS),
    pendingSilenceEvent: false,
    headlessTime: 0,
    _wasAllSilent: true,
  };
  if (audioCtx) attachAudioContext(synth, audioCtx);
  return synth;
}

// Vincula un AudioContext "tarde" (browsers requieren user gesture).
// Mode upgrade: headless → real. Sounds ya cargados quedan listos.
export function attachAudioContext(synth, audioCtx) {
  synth.audioCtx = audioCtx;
  for (let c = 0; c < TONAL_CHANNELS; c++) {
    const ch = synth.channels[c];
    ch.gain = audioCtx.createGain();
    ch.gain.gain.value = 0;
    ch.gain.connect(audioCtx.destination);
    ch.osc = audioCtx.createOscillator();
    ch.osc.type = 'square';
    ch.osc.frequency.value = 440;
    ch.osc.connect(ch.gain);
    ch.osc.start();
  }
  // Canal de ruido: AudioBuffer con ruido blanco en loop.
  const noise = synth.channels[NOISE_CHANNEL];
  const sampleRate = audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, sampleRate, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.noiseBuffer = buffer;
  noise.gain = audioCtx.createGain();
  noise.gain.gain.value = 0;
  noise.gain.connect(audioCtx.destination);
}

export function loadSound(synth, slot, def) {
  let totalTicks = 0;
  const steps = [];
  for (const step of def.steps) {
    if (step.type === 'note') {
      steps.push({
        type: 'note',
        freq: lookupFreq(step.semitone, step.octave),
        ticks: step.ticks,
      });
    } else if (step.type === 'silence') {
      steps.push({ type: 'silence', ticks: step.ticks });
    }
    totalTicks += step.ticks;
  }
  synth.sounds[slot] = {
    wave: def.wave || 'PUL',
    pulseWidth: def.pulseWidth | 0,
    env: def.env || { a: 0, d: 0, s: 15, r: 0 },
    steps,
    totalTicks,
  };
}

export function playSound(synth, slot, channelIdx) {
  if (channelIdx < 0 || channelIdx >= TONAL_CHANNELS) return;
  const sound = synth.sounds[slot];
  if (!sound) return;
  startChannel(synth, sound, channelIdx, false);
}

export function playNoise(synth, slot) {
  const sound = synth.sounds[slot];
  if (!sound) return;
  startChannel(synth, sound, NOISE_CHANNEL, true);
}

export function silenceChannel(synth, channelIdx) {
  if (channelIdx < 0 || channelIdx >= TOTAL_CHANNELS) return;
  const ch = synth.channels[channelIdx];
  ch.isPlaying = false;
  if (ch.timeoutId !== null) {
    clearTimeout(ch.timeoutId);
    ch.timeoutId = null;
  }
  if (synth.audioCtx && ch.gain) {
    const now = synth.audioCtx.currentTime;
    ch.gain.gain.cancelScheduledValues(now);
    ch.gain.gain.setValueAtTime(0, now);
  }
  if (ch.noiseSource) {
    try { ch.noiseSource.stop(); } catch (_) { /* ya detenido */ }
    ch.noiseSource = null;
  }
}

function startChannel(synth, sound, channelIdx, isNoise) {
  const ch = synth.channels[channelIdx];
  // Cancela playback previo en el mismo canal.
  silenceChannel(synth, channelIdx);
  ch.isPlaying = true;

  const totalSec = sound.totalTicks * TICK_SEC;
  if (synth.audioCtx) {
    const now = synth.audioCtx.currentTime;
    ch.finishesAt = now + totalSec;
    if (isNoise) scheduleNoiseChannel(synth, sound, ch, now);
    else         scheduleTonalChannel(synth, sound, ch, now);
    // CANAL c se dispara cuando termina (PLAN §11.4).
    ch.timeoutId = setTimeout(() => {
      ch.isPlaying = false;
      ch.timeoutId = null;
      synth.pendingChannelEvents[channelIdx] = 1;
    }, totalSec * 1000);
  } else {
    ch.finishesAt = synth.headlessTime + totalSec;
  }
}

function scheduleTonalChannel(synth, sound, ch, startTime) {
  ch.osc.type = WAVE_TYPE[sound.wave] || 'square';
  ch.gain.gain.cancelScheduledValues(startTime);
  ch.osc.frequency.cancelScheduledValues(startTime);

  const a = sound.env.a * TICK_SEC;
  const d = sound.env.d * TICK_SEC;
  const sLevel = (sound.env.s / 15) * PEAK_GAIN;
  const r = sound.env.r * TICK_SEC;

  let cursor = startTime;
  for (const step of sound.steps) {
    const dur = step.ticks * TICK_SEC;
    if (step.type === 'note') {
      ch.osc.frequency.setValueAtTime(step.freq, cursor);
      const noteEnd = cursor + dur;
      const attackEnd  = Math.min(cursor + a, noteEnd);
      const decayEnd   = Math.min(attackEnd + d, noteEnd);
      const releaseStart = Math.max(decayEnd, noteEnd - r);
      ch.gain.gain.setValueAtTime(0, cursor);
      if (a > 0) ch.gain.gain.linearRampToValueAtTime(PEAK_GAIN, attackEnd);
      else       ch.gain.gain.setValueAtTime(PEAK_GAIN, cursor);
      if (d > 0) ch.gain.gain.linearRampToValueAtTime(sLevel, decayEnd);
      else       ch.gain.gain.setValueAtTime(sLevel, decayEnd);
      ch.gain.gain.setValueAtTime(sLevel, releaseStart);
      ch.gain.gain.linearRampToValueAtTime(0, noteEnd);
    } else {
      ch.gain.gain.setValueAtTime(0, cursor);
    }
    cursor += dur;
  }
}

function scheduleNoiseChannel(synth, sound, ch, startTime) {
  const ctx = synth.audioCtx;
  const totalSec = sound.totalTicks * TICK_SEC;
  const src = ctx.createBufferSource();
  src.buffer = ch.noiseBuffer;
  src.loop = true;
  src.connect(ch.gain);
  ch.noiseSource = src;

  ch.gain.gain.cancelScheduledValues(startTime);
  ch.gain.gain.setValueAtTime(0, startTime);

  const a = sound.env.a * TICK_SEC;
  const r = sound.env.r * TICK_SEC;
  const noteEnd = startTime + totalSec;
  const attackEnd  = Math.min(startTime + a, noteEnd);
  const releaseStart = Math.max(attackEnd, noteEnd - r);
  ch.gain.gain.linearRampToValueAtTime(PEAK_GAIN, attackEnd);
  ch.gain.gain.setValueAtTime(PEAK_GAIN, releaseStart);
  ch.gain.gain.linearRampToValueAtTime(0, noteEnd);

  src.start(startTime);
  src.stop(noteEnd + 0.01);
}

// Avance del clock para tests (modo headless).
export function tickSynthHeadless(synth, dtSec) {
  if (synth.audioCtx) return;
  synth.headlessTime += dtSec;
  for (let c = 0; c < TOTAL_CHANNELS; c++) {
    const ch = synth.channels[c];
    if (ch.isPlaying && synth.headlessTime >= ch.finishesAt) {
      ch.isPlaying = false;
      synth.pendingChannelEvents[c] = 1;
    }
  }
}

export function isAllSilent(synth) {
  for (let c = 0; c < TOTAL_CHANNELS; c++) {
    if (synth.channels[c].isPlaying) return false;
  }
  return true;
}

// Llamado por el VM cada cuadro DESPUÉS de drenar pendingChannelEvents:
// si quedaron en silencio y antes había algo sonando, marca SILENCIO.
export function updateSilenceFlag(synth) {
  const allSilent = isAllSilent(synth);
  if (allSilent && !synth._wasAllSilent) {
    synth.pendingSilenceEvent = true;
  }
  synth._wasAllSilent = allSilent;
}
