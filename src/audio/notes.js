// Notas en notación hispana: DO RE MI FA SOL LA SI, octava 0..7,
// opcional sostenido '#' o bemol 'b'. Mapeo a semitonos desde DO=0.

const NOTE_OFFSET = {
  DO: 0, RE: 2, MI: 4, FA: 5, SOL: 7, LA: 9, SI: 11,
};

const NOTE_RE = /^(DO|RE|MI|FA|SOL|LA|SI)(#|b)?([0-7])$/i;

// Convierte nombre de nota a { semitone:0..11, octave:0..7 } o null.
export function parseNoteName(s) {
  const m = s.match(NOTE_RE);
  if (!m) return null;
  let semitone = NOTE_OFFSET[m[1].toUpperCase()];
  if (m[2] === '#') semitone += 1;
  else if (m[2] === 'b') semitone -= 1;
  let octave = parseInt(m[3], 10);
  // Wrap si la accidental cruza el límite octavo (DOb → SI prev octave).
  if (semitone < 0) { semitone += 12; octave -= 1; }
  if (semitone > 11) { semitone -= 12; octave += 1; }
  if (octave < 0 || octave > 7) return null;
  return { semitone, octave };
}

// Hz de una nota MIDI: f = 440 * 2^((midi - 69)/12). LA4 (DO=0,oct=4) → 440.
function midiOf(semitone, octave) { return semitone + 12 * (octave + 1); }

export function noteToFreq(semitone, octave) {
  return 440 * Math.pow(2, (midiOf(semitone, octave) - 69) / 12);
}

// LUT precomputada de 96 frecuencias (8 octavas × 12 semitonos). docs/PLAN.md §7.2.
export const FREQ_LUT = (() => {
  const lut = new Float32Array(96);
  for (let octave = 0; octave < 8; octave++) {
    for (let semitone = 0; semitone < 12; semitone++) {
      lut[octave * 12 + semitone] = noteToFreq(semitone, octave);
    }
  }
  return lut;
})();

export function lookupFreq(semitone, octave) {
  return FREQ_LUT[octave * 12 + semitone];
}
