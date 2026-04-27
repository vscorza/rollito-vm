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

// =====================================================================
// Memory map de la "RollitoVM logical machine" (docs/PLAN.md §17).
// Total 512 KB. Las regiones son contiguas, alineadas a 64 KB salvo
// PAL/SON que son chicas y caben en 16 KB.
//
//   0x00000  CODE   32 KB  programa compilado (futuro bytecode)
//   0x08000  STATE  32 KB  vars + arrays + stacks + actores + input + flags
//   0x10000  SPR    32 KB  32 patrones × 1 KB stride (256 B útiles)
//   0x18000  MAP    16 KB  4 mapas × 4 KB stride (max 64×64)
//   0x1C000  PAL     4 KB  4 paletas × 1 KB stride (64 B útiles = 16 colores RGBA)
//   0x1D000  SON    12 KB  16 sonidos × 768 B stride (def flat)
//   0x20000  FB     64 KB  framebuffer indexado (64 000 B usados)
//   0x30000  FREE  320 KB  memoria de propósito general
//   0x80000         END    (512 KB)
// =====================================================================

export const MEM_SIZE_TOTAL = 0x80000;

export const MEM = {
  CODE:  { base: 0x00000, size: 0x08000 },
  STATE: { base: 0x08000, size: 0x08000 },
  SPR:   { base: 0x10000, size: 0x08000, slotStride: 0x400, slots: 32, slotMax: 256 },
  MAP:   { base: 0x18000, size: 0x04000, slotStride: 0x1000, slots: 4, slotMax: 4096 },
  PAL:   { base: 0x1C000, size: 0x01000, slotStride: 0x400, slots: 4, slotMax: 64 },
  SON:   { base: 0x1D000, size: 0x03000, slotStride: 0x300, slots: 16, slotMax: 768 },
  FB:    { base: 0x20000, size: 0x10000 },
  FREE:  { base: 0x30000, size: 0x50000 },
};

// Region IDs para LDR/STR (idx-based access).
export const REGION_PAL = 0;
export const REGION_SPR = 1;
export const REGION_MAP = 2;
export const REGION_SON = 3;

// Layout dentro de STATE (offsets desde STATE.base = 0x08000):
//   0x0000  vars        (32 × Int32 = 128 B)
//   0x0080  arrays      (8 × 256 × Int32 = 8192 B)
//   0x2080  actors      (32 × 16 × Int16 = 1024 B)
//   0x2480  patternIdx  (32 B)
//   0x24A0  loopStack   (8 × 4 × Int32 = 128 B)
//   0x2520  callStack   (16 × Int32 = 64 B)
//   0x2560  inputBtn    (8 B)
//   0x2568  inputKeys   (256 B)
//   0x2668  flags+seed  (32 B reservados)
//   0x2688..0x7FFF  reservado (incluye magic registers de v2-E)
//
// Magic registers reservados (no implementados en v1):
//   STATE_BASE + 0x3000  silenceChannel (write canal)
//   STATE_BASE + 0x3004  playSound      (write slot+canal empacados)
//   STATE_BASE + 0x3008  carniv         (write nivel)
const STATE_OFF_VARS       = 0x0000;
const STATE_OFF_ARRAYS     = 0x0080;
const STATE_OFF_ACTORS     = 0x2080;
const STATE_OFF_PATTERNIDX = 0x2480;
const STATE_OFF_LOOPSTACK  = 0x24A0;
const STATE_OFF_CALLSTACK  = 0x2520;
const STATE_OFF_INPUT_BTN  = 0x2560;
const STATE_OFF_INPUT_KEYS = 0x2568;

// Profundidad del stack de evaluación del intérprete bytecode (v2-A).
export const EVAL_STACK_DEPTH = 256;

export function createState(seed = DEFAULT_SEED) {
  return {
    vars: new Int32Array(VAR_COUNT),
    arrays: new Int32Array(ARRAY_COUNT * ARRAY_SIZE),
    loopStack: new Int32Array(LOOP_DEPTH * LOOP_FRAME_SIZE),
    loopSp: 0,
    callStack: new Int32Array(CALL_DEPTH),
    callSp: 0,
    evalStack: new Int32Array(EVAL_STACK_DEPTH),
    evalSp: 0,
    halted: false,
    started: false,
    paused: false,
    justPaused: false,
    justResumed: false,
    pendingLevelLoad: false,
    seed: (seed | 0) || 1,
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

// =====================================================================
// readByte / writeByte: dispatcher de acceso a memoria.
//
// `addr` es 0..MEM_SIZE_TOTAL-1 (o cualquier valor; lo enmascaramos a
// 19 bits = 512 KB). Direcciones absolutas — LDM/STM/LDW/STW las pasan
// tal como las recibe el usuario.
// =====================================================================

export function readByte(state, vmRef, addr) {
  addr = (addr | 0) & 0x7FFFF;  // 19 bits = 512 KB
  // CODE
  if (addr < MEM.STATE.base) {
    return vmRef.codeMem ? vmRef.codeMem[addr] : 0;
  }
  // STATE
  if (addr < MEM.SPR.base) {
    return readStateByte(state, vmRef, addr - MEM.STATE.base);
  }
  // SPR
  if (addr < MEM.MAP.base) {
    return readSpriteByteAt(vmRef, addr - MEM.SPR.base);
  }
  // MAP
  if (addr < MEM.PAL.base) {
    return readMapByteAt(vmRef, addr - MEM.MAP.base);
  }
  // PAL
  if (addr < MEM.SON.base) {
    return readPaletteByteAt(vmRef, addr - MEM.PAL.base);
  }
  // SON
  if (addr < MEM.FB.base) {
    return vmRef.sonMem ? vmRef.sonMem[addr - MEM.SON.base] : 0;
  }
  // FB
  if (addr < MEM.FREE.base) {
    const off = addr - MEM.FB.base;
    return off < vmRef.fb.length ? vmRef.fb[off] : 0;
  }
  // FREE
  return vmRef.freeMem[addr - MEM.FREE.base];
}

export function writeByte(state, vmRef, addr, val) {
  addr = (addr | 0) & 0x7FFFF;
  val = val & 0xff;
  // CODE
  if (addr < MEM.STATE.base) {
    if (vmRef.codeMem) vmRef.codeMem[addr] = val;
    return;
  }
  // STATE
  if (addr < MEM.SPR.base) {
    writeStateByte(state, vmRef, addr - MEM.STATE.base, val);
    return;
  }
  // SPR
  if (addr < MEM.MAP.base) {
    writeSpriteByteAt(vmRef, addr - MEM.SPR.base, val);
    return;
  }
  // MAP
  if (addr < MEM.PAL.base) {
    writeMapByteAt(vmRef, addr - MEM.MAP.base, val);
    return;
  }
  // PAL
  if (addr < MEM.SON.base) {
    writePaletteByteAt(vmRef, addr - MEM.PAL.base, val);
    return;
  }
  // SON: muta sonMem y marca el slot dirty para re-parseo al próximo
  // playSound (v2-C).
  if (addr < MEM.FB.base) {
    if (!vmRef.sonMem) return;
    const off = addr - MEM.SON.base;
    vmRef.sonMem[off] = val;
    const slot = (off / MEM.SON.slotStride) | 0;
    if (vmRef.synth && vmRef.synth.dirtySounds) vmRef.synth.dirtySounds[slot] = 1;
    return;
  }
  // FB
  if (addr < MEM.FREE.base) {
    const off = addr - MEM.FB.base;
    if (off < vmRef.fb.length) vmRef.fb[off] = val & 0x0f;
    return;
  }
  // FREE
  vmRef.freeMem[addr - MEM.FREE.base] = val;
}

// =====================================================================
// LDR / STR: acceso indexado por (region, slot, offset).
// =====================================================================

export function readByteIndexed(vmRef, region, slot, offset) {
  region = region | 0; slot = slot | 0; offset = offset | 0;
  switch (region) {
    case REGION_PAL: return readPaletteIndexed(vmRef, slot, offset);
    case REGION_SPR: return readSpriteIndexed(vmRef, slot, offset);
    case REGION_MAP: return readMapIndexed(vmRef, slot, offset);
    case REGION_SON: return readSoundIndexed(vmRef, slot, offset);
    default: return 0;
  }
}

export function writeByteIndexed(vmRef, region, slot, offset, val) {
  region = region | 0; slot = slot | 0; offset = offset | 0;
  val = val & 0xff;
  switch (region) {
    case REGION_PAL: writePaletteIndexed(vmRef, slot, offset, val); return;
    case REGION_SPR: writeSpriteIndexed(vmRef, slot, offset, val); return;
    case REGION_MAP: writeMapIndexed(vmRef, slot, offset, val); return;
    case REGION_SON: writeSoundIndexed(vmRef, slot, offset, val); return;
    default: return;
  }
}

// =====================================================================
// LDW / STW: lectura/escritura de 4 bytes little-endian (Int32).
// =====================================================================

export function readWord(state, vmRef, addr) {
  const b0 = readByte(state, vmRef, addr);
  const b1 = readByte(state, vmRef, addr + 1);
  const b2 = readByte(state, vmRef, addr + 2);
  const b3 = readByte(state, vmRef, addr + 3);
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) | 0;
}

export function writeWord(state, vmRef, addr, val) {
  writeByte(state, vmRef, addr,     val        & 0xff);
  writeByte(state, vmRef, addr + 1, (val >>> 8)  & 0xff);
  writeByte(state, vmRef, addr + 2, (val >>> 16) & 0xff);
  writeByte(state, vmRef, addr + 3, (val >>> 24) & 0xff);
}

// =====================================================================
// MEMCPY / MEMSET: bulk byte ops (v1 incluye, era v2-F).
// =====================================================================

export function memCopy(state, vmRef, srcAddr, dstAddr, n) {
  n = n | 0;
  if (n <= 0) return;
  // Si las direcciones se solapan, copia hacia atrás cuando dst > src.
  if (dstAddr > srcAddr && dstAddr < srcAddr + n) {
    for (let i = n - 1; i >= 0; i--) {
      writeByte(state, vmRef, dstAddr + i, readByte(state, vmRef, srcAddr + i));
    }
  } else {
    for (let i = 0; i < n; i++) {
      writeByte(state, vmRef, dstAddr + i, readByte(state, vmRef, srcAddr + i));
    }
  }
}

export function memSet(state, vmRef, dstAddr, val, n) {
  n = n | 0;
  val = val & 0xff;
  for (let i = 0; i < n; i++) {
    writeByte(state, vmRef, dstAddr + i, val);
  }
}

// =====================================================================
// Helpers internos por región.
// =====================================================================

// --- STATE (Int32Array views + sprite actors Int16 + input Uint8) ---
function readStateByte(state, vmRef, off) {
  if (off < STATE_OFF_ARRAYS) {
    // vars (Int32 little-endian)
    const wordIdx = off >>> 2;
    const bytePos = off & 3;
    if (wordIdx >= state.vars.length) return 0;
    return (state.vars[wordIdx] >>> (bytePos * 8)) & 0xff;
  }
  if (off < STATE_OFF_ACTORS) {
    const idx = (off - STATE_OFF_ARRAYS) >>> 2;
    const bytePos = (off - STATE_OFF_ARRAYS) & 3;
    if (idx >= state.arrays.length) return 0;
    return (state.arrays[idx] >>> (bytePos * 8)) & 0xff;
  }
  if (off < STATE_OFF_PATTERNIDX) {
    // actors (Int16 little-endian)
    const idx = (off - STATE_OFF_ACTORS) >>> 1;
    const bytePos = (off - STATE_OFF_ACTORS) & 1;
    const actors = vmRef.spriteState.actors;
    if (idx >= actors.length) return 0;
    return (actors[idx] >>> (bytePos * 8)) & 0xff;
  }
  if (off < STATE_OFF_LOOPSTACK) {
    const idx = off - STATE_OFF_PATTERNIDX;
    const pIdx = vmRef.spriteState.patternIdx;
    return idx < pIdx.length ? pIdx[idx] : 0;
  }
  if (off < STATE_OFF_CALLSTACK) {
    const idx = (off - STATE_OFF_LOOPSTACK) >>> 2;
    const bytePos = (off - STATE_OFF_LOOPSTACK) & 3;
    if (idx >= state.loopStack.length) return 0;
    return (state.loopStack[idx] >>> (bytePos * 8)) & 0xff;
  }
  if (off < STATE_OFF_INPUT_BTN) {
    const idx = (off - STATE_OFF_CALLSTACK) >>> 2;
    const bytePos = (off - STATE_OFF_CALLSTACK) & 3;
    if (idx >= state.callStack.length) return 0;
    return (state.callStack[idx] >>> (bytePos * 8)) & 0xff;
  }
  if (off < STATE_OFF_INPUT_KEYS) {
    const idx = off - STATE_OFF_INPUT_BTN;
    const buttons = vmRef.inputState.buttons;
    return idx < buttons.length ? buttons[idx] : 0;
  }
  // input.keys (256 B)
  const idx = off - STATE_OFF_INPUT_KEYS;
  const keys = vmRef.inputState.keys;
  if (idx >= 0 && idx < keys.length) return keys[idx];
  return 0;
}

function writeStateByte(state, vmRef, off, val) {
  if (off < STATE_OFF_ARRAYS) {
    const wordIdx = off >>> 2;
    const bytePos = off & 3;
    if (wordIdx >= state.vars.length) return;
    const cur = state.vars[wordIdx] >>> 0;
    const mask = (0xff << (bytePos * 8)) >>> 0;
    state.vars[wordIdx] = ((cur & ~mask) | ((val & 0xff) << (bytePos * 8))) | 0;
    return;
  }
  if (off < STATE_OFF_ACTORS) {
    const idx = (off - STATE_OFF_ARRAYS) >>> 2;
    const bytePos = (off - STATE_OFF_ARRAYS) & 3;
    if (idx >= state.arrays.length) return;
    const cur = state.arrays[idx] >>> 0;
    const mask = (0xff << (bytePos * 8)) >>> 0;
    state.arrays[idx] = ((cur & ~mask) | ((val & 0xff) << (bytePos * 8))) | 0;
    return;
  }
  if (off < STATE_OFF_PATTERNIDX) {
    const idx = (off - STATE_OFF_ACTORS) >>> 1;
    const bytePos = (off - STATE_OFF_ACTORS) & 1;
    const actors = vmRef.spriteState.actors;
    if (idx >= actors.length) return;
    const cur = actors[idx] & 0xffff;
    const mask = 0xff << (bytePos * 8);
    const next = (cur & ~mask) | ((val & 0xff) << (bytePos * 8));
    // Convert back to signed Int16.
    actors[idx] = (next << 16) >> 16;
    return;
  }
  if (off < STATE_OFF_LOOPSTACK) {
    const idx = off - STATE_OFF_PATTERNIDX;
    const pIdx = vmRef.spriteState.patternIdx;
    if (idx < pIdx.length) pIdx[idx] = val;
    return;
  }
  // loopStack/callStack/input — protección suave: permitido pero sin
  // invariants chequeados (el usuario asume el riesgo).
  if (off < STATE_OFF_CALLSTACK) {
    const idx = (off - STATE_OFF_LOOPSTACK) >>> 2;
    const bytePos = (off - STATE_OFF_LOOPSTACK) & 3;
    if (idx >= state.loopStack.length) return;
    const cur = state.loopStack[idx] >>> 0;
    const mask = (0xff << (bytePos * 8)) >>> 0;
    state.loopStack[idx] = ((cur & ~mask) | ((val & 0xff) << (bytePos * 8))) | 0;
    return;
  }
  if (off < STATE_OFF_INPUT_BTN) {
    const idx = (off - STATE_OFF_CALLSTACK) >>> 2;
    const bytePos = (off - STATE_OFF_CALLSTACK) & 3;
    if (idx >= state.callStack.length) return;
    const cur = state.callStack[idx] >>> 0;
    const mask = (0xff << (bytePos * 8)) >>> 0;
    state.callStack[idx] = ((cur & ~mask) | ((val & 0xff) << (bytePos * 8))) | 0;
    return;
  }
  if (off < STATE_OFF_INPUT_KEYS) {
    const idx = off - STATE_OFF_INPUT_BTN;
    const buttons = vmRef.inputState.buttons;
    if (idx < buttons.length) buttons[idx] = val ? 1 : 0;
    return;
  }
  const idx = off - STATE_OFF_INPUT_KEYS;
  const keys = vmRef.inputState.keys;
  if (idx >= 0 && idx < keys.length) keys[idx] = val ? 1 : 0;
}

// --- SPR (32 patrones × 1 KB stride) ---
function readSpriteByteAt(vmRef, off) {
  const slot = off >>> 10;          // / 1024
  const inner = off & 0x3FF;        // & 1023
  return readSpriteIndexed(vmRef, slot, inner);
}
function writeSpriteByteAt(vmRef, off, val) {
  const slot = off >>> 10;
  const inner = off & 0x3FF;
  writeSpriteIndexed(vmRef, slot, inner, val);
}
function readSpriteIndexed(vmRef, slot, offset) {
  if (slot < 0 || slot >= MEM.SPR.slots) return 0;
  if (offset < 0 || offset >= MEM.SPR.slotMax) return 0;
  const pat = vmRef.spriteState.patterns[slot];
  if (!pat) return 0;
  if (offset >= pat.pixels.length) return 0;
  return pat.pixels[offset];
}
function writeSpriteIndexed(vmRef, slot, offset, val) {
  if (slot < 0 || slot >= MEM.SPR.slots) return;
  if (offset < 0 || offset >= MEM.SPR.slotMax) return;
  const pat = vmRef.spriteState.patterns[slot];
  if (!pat) return;
  if (offset >= pat.pixels.length) return;
  pat.pixels[offset] = val & 0x0f;
}

// --- MAP (4 mapas × 4 KB stride) ---
function readMapByteAt(vmRef, off) {
  const slot = off >>> 12;        // / 4096
  const inner = off & 0xFFF;
  return readMapIndexed(vmRef, slot, inner);
}
function writeMapByteAt(vmRef, off, val) {
  const slot = off >>> 12;
  const inner = off & 0xFFF;
  writeMapIndexed(vmRef, slot, inner, val);
}
function readMapIndexed(vmRef, slot, offset) {
  if (slot < 0 || slot >= MEM.MAP.slots) return 0;
  if (offset < 0 || offset >= MEM.MAP.slotMax) return 0;
  const m = vmRef.mapState.maps[slot];
  if (!m) return 0;
  if (offset >= m.cells.length) return 0;
  return m.cells[offset];
}
function writeMapIndexed(vmRef, slot, offset, val) {
  if (slot < 0 || slot >= MEM.MAP.slots) return;
  if (offset < 0 || offset >= MEM.MAP.slotMax) return;
  const m = vmRef.mapState.maps[slot];
  if (!m) return;
  if (offset >= m.cells.length) return;
  m.cells[offset] = val & 0x0f;
  m.dirty = true;  // invalida pre-render del FON
}

// --- PAL (4 paletas × 1 KB stride; 64 B útiles = 16 colores RGBA) ---
function readPaletteByteAt(vmRef, off) {
  const slot = off >>> 10;
  const inner = off & 0x3FF;
  return readPaletteIndexed(vmRef, slot, inner);
}
function writePaletteByteAt(vmRef, off, val) {
  const slot = off >>> 10;
  const inner = off & 0x3FF;
  writePaletteIndexed(vmRef, slot, inner, val);
}
function readPaletteIndexed(vmRef, slot, offset) {
  if (slot < 0 || slot >= MEM.PAL.slots) return 0;
  if (offset < 0 || offset >= MEM.PAL.slotMax) return 0;
  const luts = vmRef.bank.luts;
  const colorIdx = offset >> 2;
  const bytePos = offset & 3;
  return (luts[slot * 16 + colorIdx] >>> (bytePos * 8)) & 0xff;
}
function writePaletteIndexed(vmRef, slot, offset, val) {
  if (slot < 0 || slot >= MEM.PAL.slots) return;
  if (offset < 0 || offset >= MEM.PAL.slotMax) return;
  const luts = vmRef.bank.luts;
  const colorIdx = offset >> 2;
  const bytePos = offset & 3;
  const lutSlot = slot * 16 + colorIdx;
  const cur = luts[lutSlot] >>> 0;
  const mask = (0xff << (bytePos * 8)) >>> 0;
  luts[lutSlot] = ((cur & ~mask) | ((val & 0xff) << (bytePos * 8))) | 0;
}

// --- SON (16 sonidos × 768 B stride) ---
function readSoundIndexed(vmRef, slot, offset) {
  if (slot < 0 || slot >= MEM.SON.slots) return 0;
  if (offset < 0 || offset >= MEM.SON.slotMax) return 0;
  if (!vmRef.sonMem) return 0;
  return vmRef.sonMem[slot * MEM.SON.slotStride + offset];
}

function writeSoundIndexed(vmRef, slot, offset, val) {
  if (slot < 0 || slot >= MEM.SON.slots) return;
  if (offset < 0 || offset >= MEM.SON.slotMax) return;
  if (!vmRef.sonMem) return;
  vmRef.sonMem[slot * MEM.SON.slotStride + offset] = val;
  if (vmRef.synth && vmRef.synth.dirtySounds) vmRef.synth.dirtySounds[slot] = 1;
}
