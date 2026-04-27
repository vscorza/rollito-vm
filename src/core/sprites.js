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

// =====================================================================
// drawPatternAffine — sprite con rotación + escala (nearest neighbor).
//
// El usuario provee ang (0..255 = 0..360°) y esc (1..255, 64 = 1.0x).
// Internamente computamos los 4 coeficientes 8.8 del map inverso:
//   sx = (dx - cx) * a + (dy - cy) * b + ox
//   sy = (dx - cx) * c + (dy - cy) * d + oy
//
// Donde (cx, cy) es el centro del sprite (w/2, h/2) y (a..d) son los
// coeficientes de la matriz inversa de rotación * escala. Para
// rotación R y escala S, M = S*R y M^-1 = (1/S) * R^-1. Como R es
// ortogonal, R^-1 = R^T.
//
// El bounding box destino se aproxima conservadoramente como un cuadro
// de lado max(w, h) * scale * sqrt(2). Para evitar Math.sqrt corrido
// usamos un bound suelto: 2 * max(w, h) * (esc / 64), capeado a la
// pantalla.
//
// Anchor: el sprite se rota alrededor de su centro y se posiciona con
// (x, y) = top-left del bounding box destino. Para alinear con el
// SPR clásico (que usa top-left del sprite no rotado), el caller debe
// pasar (x, y) ya pre-ajustados (compensando el "crecimiento" del bbox).
//
// El espíritu de la GPU futura es nearest-neighbor: si el coordenada
// muestrada (sx, sy) cae fuera del rectángulo del patrón, el pixel
// se descarta (transparent). Si dentro y color != 0, se escribe.
// Si alpha > 0, se aplica blend table.
// =====================================================================

const TRIG_LUT_SIZE = 256;
const TRIG_LUT = new Int16Array(TRIG_LUT_SIZE);
for (let i = 0; i < TRIG_LUT_SIZE; i++) {
  // 8.8 fixed point: 256 = 1.0
  TRIG_LUT[i] = Math.round(Math.sin((i / TRIG_LUT_SIZE) * Math.PI * 2) * 256);
}
function lutSin(angU8) { return TRIG_LUT[angU8 & 0xff]; }
function lutCos(angU8) { return TRIG_LUT[(angU8 + 64) & 0xff]; }

export function drawPatternAffine(fb, pat, x, y, angU8, escU8, alpha, blendTable) {
  const w = pat.w, h = pat.h, pixels = pat.pixels;
  if (escU8 <= 0) return;
  // Inverse coefficients in 16.16 fixed point.
  // forward: sx = M00*X + M01*Y, sy = M10*X + M11*Y, M = S*R.
  // For R(ang) = [[cos, -sin], [sin, cos]] and uniform S = esc/64:
  //   forward: M00 = (esc/64)*cos, M01 = -(esc/64)*sin
  //            M10 = (esc/64)*sin, M11 = (esc/64)*cos
  //   inverse: invDet = 1 / (esc/64)^2 = 4096/esc^2
  //            iM = invDet * [[ M11, -M01 ], [ -M10, M00 ]]
  //                = (1/(esc/64)) * [[ cos, sin ], [ -sin, cos ]]
  //                = (64/esc) * [[ cos, sin ], [ -sin, cos ]]
  // En 16.16:  iM00 = (cos8.8 * 64 / esc) << 8 = cos8.8 << 8 / esc * 64
  // Nota: usamos enteros, sin Math.round más allá del LUT.
  const cosA = lutCos(angU8);  // 8.8 signed
  const sinA = lutSin(angU8);
  // (64 / esc) en 16.16:  (64 << 16) / esc
  const invScale = ((64 << 16) / escU8) | 0;
  // iM* en 16.16: (cosA / 256) * (64/esc) * 65536  → cosA * invScale / 256
  const iM00 = (cosA * invScale) >> 8;
  const iM01 = (sinA * invScale) >> 8;
  const iM10 = (-sinA * invScale) >> 8;
  const iM11 = (cosA * invScale) >> 8;

  // Bounding box destino: estimación conservadora.
  const r = (Math.max(w, h) * escU8) >> 5;  // max(w,h) * (esc/64) * 2 ≈ diagonal
  const cx = (w >> 1), cy = (h >> 1);
  const bx0 = Math.max(0, x - r);
  const bx1 = Math.min(WIDTH, x + r);
  const by0 = Math.max(0, y - r);
  const by1 = Math.min(HEIGHT, y + r);

  for (let dy = by0; dy < by1; dy++) {
    const ddy = dy - y;
    for (let dx = bx0; dx < bx1; dx++) {
      const ddx = dx - x;
      // (sx, sy) = iM * (ddx, ddy) en 16.16.
      const sxf = iM00 * ddx + iM01 * ddy;
      const syf = iM10 * ddx + iM11 * ddy;
      // De 16.16 a int + offset al centro del sprite.
      const sx = (sxf >> 16) + cx;
      const sy = (syf >> 16) + cy;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const c = pixels[sy * w + sx];
      if (c === 0) continue;
      const fbIdx = dy * WIDTH + dx;
      if (alpha === 0 || !blendTable) {
        fb[fbIdx] = c;
      } else {
        // BLEND_TABLE indexada por (src << 4) | dst, ambos 4-bit.
        const dst = fb[fbIdx] & 0x0f;
        fb[fbIdx] = blendTable[((c & 0x0f) << 4) | dst];
      }
    }
  }
}

// =====================================================================
// drawPatternAlpha — SPR clásico (sin rotar) con blend table opcional.
//
// alpha=0 es equivalente a drawPattern.
// alpha>0 aplica blendTable[(src<<4)|dst] en cada pixel no transparente.
// =====================================================================

export function drawPatternAlpha(fb, pat, x, y, alpha, blendTable) {
  const w = pat.w, h = pat.h, pixels = pat.pixels;
  let py0 = 0, py1 = h, px0 = 0, px1 = w;
  if (y < 0) py0 = -y;
  if (y + h > HEIGHT) py1 = HEIGHT - y;
  if (x < 0) px0 = -x;
  if (x + w > WIDTH) px1 = WIDTH - x;
  if (py0 >= py1 || px0 >= px1) return;
  const useBlend = alpha !== 0 && blendTable;
  for (let py = py0; py < py1; py++) {
    const fy = y + py;
    const fbRow = fy * WIDTH;
    const srcRow = py * w;
    for (let px = px0; px < px1; px++) {
      const fx = x + px;
      const c = pixels[srcRow + px];
      if (c === 0) continue;
      const fbIdx = fbRow + fx;
      if (useBlend) {
        const dst = fb[fbIdx] & 0x0f;
        fb[fbIdx] = blendTable[((c & 0x0f) << 4) | dst];
      } else {
        fb[fbIdx] = c;
      }
    }
  }
}

// =====================================================================
// makeDefaultBlendTable — tabla de blend "darken 50%" por defecto.
//
// Output[(src << 4) | dst] = índice de paleta resultante de mezclar
// src y dst al 50%. Sin acceso a las paletas RGB acá, usamos una
// heurística: el color de mayor índice (más claro en la default
// PICO-8 palette) se "oscurece" hacia el de menor índice. Para
// sombras, el caller puede instalar una tabla custom usando
// `STR $RPAL,blendSlot,...` o vía un nuevo MMIO en el futuro.
//
// Default pragmático: out = (src + dst) >> 1.
// =====================================================================

export function makeDefaultBlendTable() {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const src = (i >> 4) & 0x0f;
    const dst = i & 0x0f;
    t[i] = (src + dst) >> 1;
  }
  return t;
}
