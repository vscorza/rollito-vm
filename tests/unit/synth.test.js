import { describe, it, expect } from 'vitest';
import {
  createSynth, loadSound, playSound, silenceChannel,
  tickSynthHeadless, isAllSilent, updateSilenceFlag,
  TONAL_CHANNELS, TOTAL_CHANNELS,
} from '../../src/audio/synth.js';

const TICK_SEC = 1 / 60;

function jumpSound() {
  return {
    wave: 'PUL',
    pulseWidth: 8,
    env: { a: 1, d: 2, s: 8, r: 4 },
    steps: [
      { type: 'note', semitone: 0, octave: 5, ticks: 4 },  // DO5
      { type: 'note', semitone: 7, octave: 5, ticks: 4 },  // SOL5
    ],
  };
}

describe('createSynth (headless)', () => {
  it('arranca silencioso con 5 canales', () => {
    const s = createSynth(null);
    expect(s.audioCtx).toBeNull();
    expect(s.channels.length).toBe(TOTAL_CHANNELS);
    expect(isAllSilent(s)).toBe(true);
  });
});

describe('loadSound + playSound (headless clock)', () => {
  it('marca el canal como playing y se silencia tras la duración', () => {
    const s = createSynth(null);
    loadSound(s, 0, jumpSound());
    playSound(s, 0, 1);
    expect(s.channels[1].isPlaying).toBe(true);
    // 8 ticks total — avanzo 7 (no termina aún).
    tickSynthHeadless(s, 7 * TICK_SEC);
    expect(s.channels[1].isPlaying).toBe(true);
    expect(s.pendingChannelEvents[1]).toBe(0);
    // Avanzo 1 tick más → termina y dispara pending event.
    tickSynthHeadless(s, 1.5 * TICK_SEC);
    expect(s.channels[1].isPlaying).toBe(false);
    expect(s.pendingChannelEvents[1]).toBe(1);
  });

  it('ignora canal fuera de rango tonal', () => {
    const s = createSynth(null);
    loadSound(s, 0, jumpSound());
    playSound(s, 0, 99);
    expect(isAllSilent(s)).toBe(true);
  });
});

describe('silenceChannel', () => {
  it('detiene el canal y limpia pendingEvent', () => {
    const s = createSynth(null);
    loadSound(s, 0, jumpSound());
    playSound(s, 0, 2);
    silenceChannel(s, 2);
    expect(s.channels[2].isPlaying).toBe(false);
  });
});

describe('updateSilenceFlag', () => {
  it('marca SILENCIO cuando el último canal activo termina', () => {
    const s = createSynth(null);
    loadSound(s, 0, jumpSound());
    playSound(s, 0, 0);
    updateSilenceFlag(s);  // todavía no silencio
    expect(s.pendingSilenceEvent).toBe(false);

    tickSynthHeadless(s, 9 * TICK_SEC);  // suficiente para terminar
    // Drenar el evento de canal como hace el VM.
    s.pendingChannelEvents[0] = 0;
    updateSilenceFlag(s);
    expect(s.pendingSilenceEvent).toBe(true);
  });

  it('no marca SILENCIO si nunca sonó nada', () => {
    const s = createSynth(null);
    updateSilenceFlag(s);
    expect(s.pendingSilenceEvent).toBe(false);
  });
});

describe('paralelismo entre canales', () => {
  it('dos canales pueden sonar a la vez', () => {
    const s = createSynth(null);
    loadSound(s, 0, jumpSound());
    playSound(s, 0, 0);
    playSound(s, 0, 1);
    expect(s.channels[0].isPlaying).toBe(true);
    expect(s.channels[1].isPlaying).toBe(true);
    expect(isAllSilent(s)).toBe(false);
  });
});
