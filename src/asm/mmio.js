// MMIO commands del intérprete RVM-32 (PLAN §19, RVM32-ISA.md §6).
//
// El transpilador v2-A → RVM-32 mapea cada builtin/query de v2-A
// (SPR, MOV, BOR, COL, BTN, etc.) a una secuencia de SW a registros
// de args + un SW final a CMD que dispara la acción. Las queries
// dejan el resultado en RESULT que se lee con LW.
//
// Esto evita reimplementar los helpers (drawPattern, blitMap,
// playSound, aabbCollide...) en RVM-32 — el intérprete los llama
// cuando ve un SW a la dirección MMIO correspondiente.
//
// Las direcciones viven en el espacio reservado de los magic registers
// (STATE_BASE + 0x3100..0x3FFF) — después de los 5 magic registers
// existentes ($MR_SILENCE, $MR_PLAY, $MR_NOISE, $MR_CARNIV, $MR_REPAINT).
// memory.js no toca este rango: la intercepción ocurre en
// interpreter.js antes de delegar al writeWord/readWord general.

// =====================================================================
// Direcciones MMIO. Todas absolutas; 0x0B000 = STATE_BASE + 0x3000.
// =====================================================================

export const MMIO_BASE = 0x0B100;
export const MMIO_END  = 0x0B200;  // exclusive

export const MMIO_ARG0 = 0x0B100;
export const MMIO_ARG1 = 0x0B104;
export const MMIO_ARG2 = 0x0B108;
export const MMIO_ARG3 = 0x0B10C;
export const MMIO_ARG4 = 0x0B110;
export const MMIO_ARG5 = 0x0B114;
export const MMIO_ARG6 = 0x0B118;
export const MMIO_ARG7 = 0x0B11C;

// Comando: SW val a esta dirección dispara la acción según val.
export const MMIO_CMD    = 0x0B120;

// Resultado de la última query (lectura): LW lee acá.
export const MMIO_RESULT = 0x0B124;

// =====================================================================
// Códigos de comando (van en el SW val a MMIO_CMD).
// Numerados por categoría para debugging.
// =====================================================================

export const CMD = Object.freeze({
  // -------------------- statements (no result) --------------------
  // Drawing
  BOR:   0x01,  // ARG0 = color
  PIN:   0x02,  // ARG0..2 = x, y, c
  REC:   0x03,  // ARG0..4 = x, y, w, h, c
  TXT:   0x04,  // ARG0..3 = x, y, strIdx, color (strIdx = pool index)

  // Sprites (drawing)
  SPR:   0x10,  // ARG0..3 = n, x, y, flags
  SPRR:  0x11,  // ARG0..4 = n, x, y, ang, esc
  SPRA:  0x12,  // ARG0..3 = n, x, y, alpha

  // Sprites (state)
  MOV:   0x20,  // ARG0..2 = n, x, y
  VEL:   0x21,  // ARG0..2 = n, vx, vy
  ANI:   0x22,  // ARG0..3 = n, a, b, t
  OCU:   0x23,  // ARG0..1 = n, v
  INV:   0x24,  // ARG0..1 = n, axis (0=X, 1=Y)
  PAT:   0x25,  // ARG0..1 = n, p

  // Maps & physics
  MAP_:  0x30,  // ARG0..2 = n, x, y
  FON:   0x31,  // ARG0 = n
  SOL:   0x32,  // ARG0 = mapIdx, ARG1 = count, ARG2..n = tiles (max 6)
  GRA:   0x33,  // ARG0..2 = n, m, g
  SAL:   0x34,  // ARG0..1 = n, f
  LIM:   0x35,  // ARG0..4 = n, x1, y1, x2, y2

  // Audio (espejado de los magic registers existentes; presente acá por
  // simetría — el transpilador puede usar cualquiera).
  SON:   0x40,  // ARG0..1 = n, c
  RUI:   0x41,  // ARG0 = n
  SIL:   0x42,  // ARG0 = c

  // Lifecycle
  CARNIV: 0x50, // ARG0 = n

  // -------------------- queries (result en MMIO_RESULT) --------------
  // Actor-state reads
  Q_X:    0x80,  // ARG0 = n → X(n)
  Q_Y:    0x81,  // ARG0 = n → Y(n)
  Q_VX:   0x82,
  Q_VY:   0x83,
  Q_VIS:  0x84,

  // Collision / distance
  Q_COL:  0x90,  // ARG0..1 = a, b → 0/1
  Q_DIS:  0x91,  // ARG0..1 = a, b → distance
  Q_COLM: 0x92,  // ARG0..1 = actor, mapIdx → 0/1
  Q_PIE:  0x93,  // ARG0 = actor → 0/1

  // Map / tile
  Q_TIL:  0xA0,  // ARG0..2 = m, c, f → tile

  // Input
  Q_BTN:  0xA8,  // ARG0 = b → 0/1
  Q_TEC:  0xA9,  // ARG0 = k → 0/1

  // Random
  Q_ALE:  0xB0,  // ARG0 = n → ALE(n)

  // Math
  Q_ABS:  0xC0,  // ARG0 → |x|
  Q_SGN:  0xC1,  // ARG0 → sign(x)
  Q_RAI:  0xC2,  // ARG0 → sqrt(x)|0
  Q_SEN:  0xC3,  // ARG0 → sin(deg)*1000
  Q_COS:  0xC4,
  Q_MIN:  0xC5,  // ARG0..1 → min
  Q_MAX:  0xC6,
  Q_DIV:  0xC7,  // ARG0..1 → (a/b)|0  (integer division)
  Q_MOD:  0xC8,  // ARG0..1 → a%b

  // -------------------- memoria indirecta (LDR/STR + MEMCPY/MEMSET) --
  LDR:    0xE0,  // ARG0..2 = region, slot, offset → byte
  STR:    0xE1,  // ARG0..3 = region, slot, offset, val
  MEMCPY: 0xE8,  // ARG0..2 = src, dst, n
  MEMSET: 0xE9,  // ARG0..2 = dst, val, n
});

export const CMD_NAME = (() => {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(CMD)) out[v] = k;
  return out;
})();

// Helper: ¿está addr en el rango MMIO interceptado?
export function isMmio(addr) {
  return addr >= MMIO_BASE && addr < MMIO_END;
}
