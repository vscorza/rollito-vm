import { WIDTH, HEIGHT, PIXELS } from '../render/framebuffer.js';
import { drawPattern, drawPatternAlpha } from './sprites.js';

// Estado de mapas. Hasta 4 mapas (índice 0..3). Cada mapa tiene:
//   - cols, rows         (dimensiones en celdas)
//   - cells: Uint8Array(cols*rows)  índice de tile 0..15 (0 = vacío)
//   - tileW, tileH       (computado al pre-renderizar o al consultar)
//   - solid: Uint8Array(16)         mask "este índice es sólido"
//   - preRendered, dirty (cache del FON)

export const MAX_MAPS = 4;
export const TILE_RANGE = 16;

export function createMapState() {
  return {
    maps: new Array(MAX_MAPS),  // sparse
    activeBackground: -1,
  };
}

export function setMap(mapState, index, cols, rows, cells) {
  mapState.maps[index] = {
    cols, rows, cells,
    tileW: 0, tileH: 0,        // se resuelven al pre-renderizar o consultar
    solid: new Uint8Array(TILE_RANGE),
    preRendered: null,
    dirty: true,
  };
}

export function setSolid(mapState, mapIdx, tileIndices) {
  const m = mapState.maps[mapIdx];
  if (!m) throw new Error(`SOL: mapa ${mapIdx} no definido`);
  for (let i = 0; i < tileIndices.length; i++) {
    const t = tileIndices[i] & 0x0f;
    m.solid[t] = 1;
  }
}

// Resuelve tileW/tileH desde el primer tile no-cero referenciado en el mapa.
// Si todas las celdas son 0, queda en 0/0 (mapa vacío, render no hace nada).
function resolveTileSize(map, patterns) {
  if (map.tileW > 0) return;
  for (let i = 0; i < map.cells.length; i++) {
    const t = map.cells[i];
    if (t === 0) continue;
    const pat = patterns[t];
    if (pat) {
      map.tileW = pat.w;
      map.tileH = pat.h;
      return;
    }
  }
}

export function readTile(mapState, mapIdx, col, row) {
  const m = mapState.maps[mapIdx];
  if (!m) return 0;
  if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return 0;
  return m.cells[row * m.cols + col];
}

export function writeTile(mapState, mapIdx, col, row, value) {
  const m = mapState.maps[mapIdx];
  if (!m) return;
  if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return;
  m.cells[row * m.cols + col] = value & 0x0f;
  m.dirty = true;
}

// AABB del actor vs cualquier tile sólido del mapa. Usa las dims del
// patrón actual del actor.
export function actorCollidesMap(spriteState, mapState, actorIdx, mapIdx, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN) {
  const m = mapState.maps[mapIdx];
  if (!m) return 0;
  resolveTileSize(m, spriteState.patterns);
  if (m.tileW === 0) return 0;
  const a = spriteState.actors;
  const off = actorIdx * ACTOR_FIELDS;
  if (a[off + F_FLAGS] & FLAG_HIDDEN) return 0;
  const pat = spriteState.patterns[spriteState.patternIdx[actorIdx]];
  if (!pat) return 0;
  const x = a[off + F_X];
  const y = a[off + F_Y];
  const w = pat.w;
  const h = pat.h;
  return rectCollidesMap(m, x, y, w, h);
}

function rectCollidesMap(m, x, y, w, h) {
  const tw = m.tileW, th = m.tileH;
  let tx1 = Math.floor(x / tw);
  let ty1 = Math.floor(y / th);
  let tx2 = Math.floor((x + w - 1) / tw);
  let ty2 = Math.floor((y + h - 1) / th);
  if (tx1 < 0) tx1 = 0;
  if (ty1 < 0) ty1 = 0;
  if (tx2 >= m.cols) tx2 = m.cols - 1;
  if (ty2 >= m.rows) ty2 = m.rows - 1;
  if (tx1 > tx2 || ty1 > ty2) return 0;
  const cells = m.cells;
  const solid = m.solid;
  for (let ty = ty1; ty <= ty2; ty++) {
    const row = ty * m.cols;
    for (let tx = tx1; tx <= tx2; tx++) {
      if (solid[cells[row + tx]]) return 1;
    }
  }
  return 0;
}

// Test "actor está pisando suelo": chequea sólido en una franja de
// 1 pixel inmediatamente debajo de su bbox.
export function actorOnGround(spriteState, mapState, actorIdx, mapIdx, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN) {
  const m = mapState.maps[mapIdx];
  if (!m) return 0;
  resolveTileSize(m, spriteState.patterns);
  if (m.tileW === 0) return 0;
  const a = spriteState.actors;
  const off = actorIdx * ACTOR_FIELDS;
  if (a[off + F_FLAGS] & FLAG_HIDDEN) return 0;
  const pat = spriteState.patterns[spriteState.patternIdx[actorIdx]];
  if (!pat) return 0;
  const x = a[off + F_X];
  const y = a[off + F_Y] + pat.h;
  return rectCollidesMap(m, x, y, pat.w, 1);
}

// Pinta el mapa una sola vez en (x, y) sobre el fb (modo MAP n,x,y).
export function blitMap(mapState, mapIdx, fb, dx, dy, patterns) {
  const m = mapState.maps[mapIdx];
  if (!m) return;
  resolveTileSize(m, patterns);
  if (m.tileW === 0) return;
  const tw = m.tileW, th = m.tileH;
  const cStart = dx < 0 ? Math.max(0, ((-dx) / tw) | 0) : 0;
  const cEndRaw = dx + m.cols * tw > WIDTH ? Math.ceil((WIDTH - dx) / tw) : m.cols;
  const cEnd = cEndRaw < m.cols ? (cEndRaw < 0 ? 0 : cEndRaw) : m.cols;
  if (cStart >= cEnd) return;
  const rStart = dy < 0 ? Math.max(0, ((-dy) / th) | 0) : 0;
  const rEndRaw = dy + m.rows * th > HEIGHT ? Math.ceil((HEIGHT - dy) / th) : m.rows;
  const rEnd = rEndRaw < m.rows ? (rEndRaw < 0 ? 0 : rEndRaw) : m.rows;
  if (rStart >= rEnd) return;
  for (let r = rStart; r < rEnd; r++) {
    const rowBase = r * m.cols;
    const py = dy + r * th;
    for (let c = cStart; c < cEnd; c++) {
      const t = m.cells[rowBase + c];
      if (t === 0) continue;
      const pat = patterns[t];
      if (!pat) continue;
      drawPattern(fb, pat, dx + c * tw, py, false, false);
    }
  }
}

// Variante alpha-blended (MAP n,x,y,a con a>0). Comparte el camino lento
// de drawPatternAlpha → consulta blendTable por pixel no-transparente.
export function blitMapAlpha(mapState, mapIdx, fb, dx, dy, alpha, blendTable, patterns) {
  const m = mapState.maps[mapIdx];
  if (!m) return;
  resolveTileSize(m, patterns);
  if (m.tileW === 0) return;
  const tw = m.tileW, th = m.tileH;
  const cStart = dx < 0 ? Math.max(0, ((-dx) / tw) | 0) : 0;
  const cEndRaw = dx + m.cols * tw > WIDTH ? Math.ceil((WIDTH - dx) / tw) : m.cols;
  const cEnd = cEndRaw < m.cols ? (cEndRaw < 0 ? 0 : cEndRaw) : m.cols;
  if (cStart >= cEnd) return;
  const rStart = dy < 0 ? Math.max(0, ((-dy) / th) | 0) : 0;
  const rEndRaw = dy + m.rows * th > HEIGHT ? Math.ceil((HEIGHT - dy) / th) : m.rows;
  const rEnd = rEndRaw < m.rows ? (rEndRaw < 0 ? 0 : rEndRaw) : m.rows;
  if (rStart >= rEnd) return;
  for (let r = rStart; r < rEnd; r++) {
    const rowBase = r * m.cols;
    const py = dy + r * th;
    for (let c = cStart; c < cEnd; c++) {
      const t = m.cells[rowBase + c];
      if (t === 0) continue;
      const pat = patterns[t];
      if (!pat) continue;
      drawPatternAlpha(fb, pat, dx + c * tw, py, alpha, blendTable);
    }
  }
}

// Pre-renderiza el mapa entero a un Uint8Array(PIXELS). Usado por FON.
// Reusa el buffer si ya existe (evita allocations en cambios de nivel).
export function prerenderMap(mapState, mapIdx, patterns) {
  const m = mapState.maps[mapIdx];
  if (!m) return null;
  if (!m.preRendered) m.preRendered = new Uint8Array(PIXELS);
  if (!m.dirty) return m.preRendered;
  m.preRendered.fill(0);
  blitMap(mapState, mapIdx, m.preRendered, 0, 0, patterns);
  m.dirty = false;
  return m.preRendered;
}

export function setActiveBackground(mapState, mapIdx) {
  mapState.activeBackground = mapIdx;
  if (mapIdx >= 0) {
    const m = mapState.maps[mapIdx];
    if (m) m.dirty = true;  // forzar re-render al primer uso
  }
}
