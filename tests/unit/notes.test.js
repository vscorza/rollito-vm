import { describe, it, expect } from 'vitest';
import {
  parseNoteName, noteToFreq, lookupFreq, FREQ_LUT,
} from '../../src/audio/notes.js';

describe('parseNoteName', () => {
  it('parsea notas naturales', () => {
    expect(parseNoteName('DO4')).toEqual({ semitone: 0, octave: 4 });
    expect(parseNoteName('LA4')).toEqual({ semitone: 9, octave: 4 });
    expect(parseNoteName('SI7')).toEqual({ semitone: 11, octave: 7 });
  });
  it('parsea sostenidos y bemoles', () => {
    expect(parseNoteName('FA#3')).toEqual({ semitone: 6, octave: 3 });
    expect(parseNoteName('SIb6')).toEqual({ semitone: 10, octave: 6 });
  });
  it('case-insensitive', () => {
    expect(parseNoteName('do5')).toEqual({ semitone: 0, octave: 5 });
  });
  it('null en formato inválido', () => {
    expect(parseNoteName('XX5')).toBeNull();
    expect(parseNoteName('DO9')).toBeNull();
    expect(parseNoteName('LA')).toBeNull();
  });
});

describe('noteToFreq / FREQ_LUT', () => {
  it('LA4 = 440 Hz exactos', () => {
    expect(noteToFreq(9, 4)).toBeCloseTo(440, 4);
    expect(lookupFreq(9, 4)).toBeCloseTo(440, 1);
  });
  it('octava arriba duplica frecuencia', () => {
    expect(noteToFreq(0, 5) / noteToFreq(0, 4)).toBeCloseTo(2, 4);
  });
  it('LUT tiene 96 entradas', () => {
    expect(FREQ_LUT.length).toBe(96);
    expect(FREQ_LUT[0]).toBeGreaterThan(0);
    expect(FREQ_LUT[95]).toBeGreaterThan(FREQ_LUT[0]);
  });
});
