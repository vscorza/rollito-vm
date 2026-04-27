import { WIDTH, HEIGHT } from '../render/framebuffer.js';

// Estado de actores. docs/PLAN.md §6.2:
//   "32 slots que combinan imagen (patrón) y estado de actor"
//
// Hito 5 extiende los 8 fields originales a 16 para incluir
// gravedad/mapa enlazado y rect de LIM. Los offsets 0..7 quedan
// idénticos a Hito 4 (los tests siguen funcionando).

export const ACTOR_COUNT = 32;
export const PATTERN_COUNT = 32;
export const ACTOR_FIELDS = 16;

export const F_X = 0, F_Y = 1, F_VX = 2, F_VY = 3;
export const F_FLAGS = 4, F_ANI_A = 5, F_ANI_B = 6, F_ANI_STATE = 7;
export const F_PHYS_MAP = 8;
export const F_PHYS_GRA = 9;
export const F_LIM_X1 = 10, F_LIM_Y1 = 11, F_LIM_X2 = 12, F_LIM_Y2 = 13;

export const FLAG_HIDDEN = 1;
export const FLAG_FLIP_X = 2;
export const FLAG_FLIP_Y = 4;
export const FLAG_ON_GROUND = 8;
export const FLAG_LIM_ACTIVE = 16;

// Cap de velocidad terminal vertical para evitar tunneling cuando un
// actor cae con gravedad alta a través de tiles delgadas. 16 px/cuadro
// es ~960 px/seg — suficiente para casi cualquier juego.
const TERMINAL_VY = 16;

export function createSpriteState() {
  const actors = new Int16Array(ACTOR_COUNT * ACTOR_FIELDS);
  const patternIdx = new Uint8Array(ACTOR_COUNT);
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const off = i * ACTOR_FIELDS;
    actors[off + F_FLAGS] = FLAG_HIDDEN;
    actors[off + F_ANI_A] = -1;
    actors[off + F_PHYS_MAP] = -1;
    patternIdx[i] = i;
  }
  return { actors, patternIdx, patterns: new Array(PATTERN_COUNT) };
}

// Avance pre-cuadro. Para cada actor visible:
//   - Si tiene física (F_PHYS_MAP >= 0): aplicar gravedad, mover con
//     resolución AABB two-pass contra mapa enlazado.
//   - Si no, sumar velocidad directamente.
//   - Aplicar LIM (clamp top-left) si está activo.
//   - Avanzar animación si F_ANI_A >= 0.
export function advanceActors(spriteState, mapState, mapHelpers) {
  const a = spriteState.actors;
  const pIdx = spriteState.patternIdx;
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const off = i * ACTOR_FIELDS;
    if (a[off + F_FLAGS] & FLAG_HIDDEN) continue;

    const physMap = a[off + F_PHYS_MAP];
    if (physMap >= 0 && mapState && mapHelpers) {
      // Gravedad y resolución de colisión.
      let vy = a[off + F_VY] + a[off + F_PHYS_GRA];
      if (vy > TERMINAL_VY) vy = TERMINAL_VY;
      a[off + F_VY] = vy;

      const oldX = a[off + F_X];
      a[off + F_X] = oldX + a[off + F_VX];
      if (mapHelpers.actorCollidesMap(spriteState, mapState, i, physMap, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)) {
        a[off + F_X] = oldX;
        // Frenar X al chocar con pared para que VEL +n no acumule
        // "presión" contra la pared en cuadros siguientes.
        a[off + F_VX] = 0;
      }

      const oldY = a[off + F_Y];
      a[off + F_Y] = oldY + a[off + F_VY];
      if (mapHelpers.actorCollidesMap(spriteState, mapState, i, physMap, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)) {
        const fellOnto = a[off + F_VY] > 0;
        a[off + F_Y] = oldY;
        a[off + F_VY] = 0;
        if (fellOnto) a[off + F_FLAGS] |= FLAG_ON_GROUND;
        else          a[off + F_FLAGS] &= ~FLAG_ON_GROUND;
      } else {
        a[off + F_FLAGS] &= ~FLAG_ON_GROUND;
      }
    } else {
      a[off + F_X] += a[off + F_VX];
      a[off + F_Y] += a[off + F_VY];
    }

    // LIM (clamp top-left).
    if (a[off + F_FLAGS] & FLAG_LIM_ACTIVE) {
      const x1 = a[off + F_LIM_X1], y1 = a[off + F_LIM_Y1];
      const x2 = a[off + F_LIM_X2], y2 = a[off + F_LIM_Y2];
      if (a[off + F_X] < x1) a[off + F_X] = x1;
      if (a[off + F_X] > x2) a[off + F_X] = x2;
      if (a[off + F_Y] < y1) a[off + F_Y] = y1;
      if (a[off + F_Y] > y2) a[off + F_Y] = y2;
    }

    // Animación.
    const aniA = a[off + F_ANI_A];
    if (aniA < 0) continue;
    const aniB = a[off + F_ANI_B];
    const aniState = a[off + F_ANI_STATE];
    let counter = aniState & 0xff;
    const t = (aniState >>> 8) & 0xff;
    counter++;
    if (counter >= t) {
      counter = 0;
      let p = pIdx[i] + 1;
      if (p > aniB) p = aniA;
      pIdx[i] = p;
    }
    a[off + F_ANI_STATE] = ((t & 0xff) << 8) | (counter & 0xff);
  }
}

// Render post-cuadro. Itera los 32 actores, salta ocultos y los que no
// tienen patrón cargado, dibuja con flips y transparencia (color 0).
export function renderActors(spriteState, fb) {
  const a = spriteState.actors;
  const pIdx = spriteState.patternIdx;
  const patterns = spriteState.patterns;
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const off = i * ACTOR_FIELDS;
    const flags = a[off + F_FLAGS];
    if (flags & FLAG_HIDDEN) continue;
    const pat = patterns[pIdx[i]];
    if (!pat) continue;
    drawPattern(
      fb, pat,
      a[off + F_X], a[off + F_Y],
      (flags & FLAG_FLIP_X) !== 0,
      (flags & FLAG_FLIP_Y) !== 0,
    );
  }
}

// Dibuja un patrón en el FB. Pixel value 0 es transparente.
export function drawPattern(fb, pat, x, y, flipX, flipY) {
  const w = pat.w, h = pat.h, pixels = pat.pixels;
  let py0 = 0, py1 = h, px0 = 0, px1 = w;
  if (y < 0) py0 = -y;
  if (y + h > HEIGHT) py1 = HEIGHT - y;
  if (x < 0) px0 = -x;
  if (x + w > WIDTH) px1 = WIDTH - x;
  if (py0 >= py1 || px0 >= px1) return;
  for (let py = py0; py < py1; py++) {
    const fy = y + py;
    const sy = flipY ? (h - 1 - py) : py;
    const fbRow = fy * WIDTH;
    const srcRow = sy * w;
    for (let px = px0; px < px1; px++) {
      const fx = x + px;
      const sx = flipX ? (w - 1 - px) : px;
      const c = pixels[srcRow + sx];
      if (c !== 0) fb[fbRow + fx] = c;
    }
  }
}

// AABB actor vs actor.
export function aabbCollide(spriteState, s1, s2) {
  if (s1 === s2) return 0;
  const a = spriteState.actors;
  const f1 = a[s1 * ACTOR_FIELDS + F_FLAGS];
  const f2 = a[s2 * ACTOR_FIELDS + F_FLAGS];
  if ((f1 & FLAG_HIDDEN) || (f2 & FLAG_HIDDEN)) return 0;
  const p1 = spriteState.patterns[spriteState.patternIdx[s1]];
  const p2 = spriteState.patterns[spriteState.patternIdx[s2]];
  if (!p1 || !p2) return 0;
  const x1 = a[s1 * ACTOR_FIELDS + F_X];
  const y1 = a[s1 * ACTOR_FIELDS + F_Y];
  const x2 = a[s2 * ACTOR_FIELDS + F_X];
  const y2 = a[s2 * ACTOR_FIELDS + F_Y];
  if (x1 + p1.w <= x2) return 0;
  if (x2 + p2.w <= x1) return 0;
  if (y1 + p1.h <= y2) return 0;
  if (y2 + p2.h <= y1) return 0;
  return 1;
}

export function actorDistance(spriteState, s1, s2) {
  const a = spriteState.actors;
  const p1 = spriteState.patterns[spriteState.patternIdx[s1]];
  const p2 = spriteState.patterns[spriteState.patternIdx[s2]];
  const w1 = p1 ? p1.w : 0, h1 = p1 ? p1.h : 0;
  const w2 = p2 ? p2.w : 0, h2 = p2 ? p2.h : 0;
  const cx1 = a[s1 * ACTOR_FIELDS + F_X] + (w1 >> 1);
  const cy1 = a[s1 * ACTOR_FIELDS + F_Y] + (h1 >> 1);
  const cx2 = a[s2 * ACTOR_FIELDS + F_X] + (w2 >> 1);
  const cy2 = a[s2 * ACTOR_FIELDS + F_Y] + (h2 >> 1);
  const dx = cx1 - cx2, dy = cy1 - cy2;
  return Math.sqrt(dx * dx + dy * dy) | 0;
}
