// Layout de variables del VM. Por nombre:
//   A..Z         → slots 0..25
//   CUA          → slot 26  (read-only desde el lenguaje, lo escribe el VM)
//   LIN          → slot 27  (read-only, scanline actual durante LINEA)
//   VID          → slot 28
//   PUN          → slot 29
//   NIV          → slot 30
//
// 32 slots con margen para crecer. Total 128 bytes.

export const VAR_COUNT = 32;

export const VAR_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < 26; i++) m[String.fromCharCode(65 + i)] = i;
  m.CUA = 26;
  m.LIN = 27;
  m.VID = 28;
  m.PUN = 29;
  m.NIV = 30;
  return m;
})();

export const READONLY_VARS = new Set(['CUA', 'LIN']);

// Profundidad máxima de PAR/SIG anidados (docs/PLAN.md §8.3).
export const LOOP_DEPTH = 8;
// Profundidad máxima de LLA/RET (docs/PLAN.md §9, "Pila de llamadas 16").
export const CALL_DEPTH = 16;
// Arreglos M0..M7 (docs/PLAN.md §8.3): 8 arrays de 256 ints.
export const ARRAY_COUNT = 8;
export const ARRAY_SIZE = 256;

// Cada frame de loop ocupa 4 slots: [varIdx, end, bodyIdx, _padding].
export const LOOP_FRAME_SIZE = 4;

// Seed default del PRNG. Cualquier valor != 0 vale para xorshift32.
// docs/PLAN.md §11.8: el seed forma parte del estado del VM, lo que
// permite tests reproducibles.
export const DEFAULT_SEED = 0x12345678 | 0;

export function createState(seed = DEFAULT_SEED) {
  return {
    vars: new Int32Array(VAR_COUNT),
    arrays: new Int32Array(ARRAY_COUNT * ARRAY_SIZE),
    loopStack: new Int32Array(LOOP_DEPTH * LOOP_FRAME_SIZE),
    loopSp: 0,
    callStack: new Int32Array(CALL_DEPTH),
    callSp: 0,
    halted: false,
    started: false,        // lifecycle: ¿corrió INICIOMOTOR/INICIOJUEGO?
    paused: false,
    justPaused: false,     // se baja tras disparar EN PAUSA en próximo cuadro
    justResumed: false,    // se baja tras disparar EN REANUDA en próximo cuadro
    pendingLevelLoad: false, // CARNIV setea esto; runFrame dispara handlers
    seed: (seed | 0) || 1, // xorshift32 no tolera seed=0
  };
}

// xorshift32. docs/PLAN.md §11.8.
export function nextRandom(state) {
  let x = state.seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x | 0;
  return x >>> 0;
}

export function resolveVar(name) {
  const idx = VAR_INDEX[name];
  if (idx === undefined) {
    throw new Error(`variable desconocida: ${name}`);
  }
  return idx;
}
