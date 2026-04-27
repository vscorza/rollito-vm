import { HEIGHT } from './framebuffer.js';

export const PALETTE_SIZE = 16;
export const MAX_PALETTES = 4;

// Paleta default — la del ejemplo de docs/PLAN.md §5 (estilo PICO-8).
export const DEFAULT_PALETTE = [
  '000000', '1D2B53', '7E2553', '008751',
  'AB5236', '5F574F', 'C2C3C7', 'FFF1E8',
  'FF004D', 'FFA300', 'FFEC27', '00E436',
  '29ADFF', '83769C', 'FF77A8', 'FFCCAA',
];

// El "bank" agrupa todo el estado de paleta del VM:
//   - 4 LUTs precomputadas en un único Uint32Array(64).
//   - 4 vistas subarray para acceder a cada LUT sin copiar.
//   - Índice activo global (0..3) y vista directa de su LUT (hot path).
//   - Int8Array(200) con overrides por scanline (-1 = sin override).
//   - Flag scanlineDirty: la blit lo chequea antes de entrar al camino lento.
//
// Se aloca una vez al cargar el juego. Las funciones de mutación no
// reasignan typed arrays — sólo updatean entradas y vistas.
export function createPaletteBank() {
  const luts = new Uint32Array(MAX_PALETTES * PALETTE_SIZE);
  const views = new Array(MAX_PALETTES);
  for (let i = 0; i < MAX_PALETTES; i++) {
    views[i] = luts.subarray(i * PALETTE_SIZE, (i + 1) * PALETTE_SIZE);
  }
  return {
    luts,
    views,
    active: 0,
    activeLut: views[0],
    scanlineOverride: new Int8Array(HEIGHT).fill(-1),
    scanlineDirty: false,
  };
}

// Carga la paleta n (0..MAX_PALETTES-1) desde un array de 16 strings hex
// "RRGGBB" y precomputa su LUT.
export function setPalette(bank, n, hexPalette) {
  const base = n * PALETTE_SIZE;
  const luts = bank.luts;
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const c = hexPalette[i];
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    luts[base + i] = (0xff << 24) | (b << 16) | (g << 8) | r;
  }
}

// Activa la paleta global. Próximo blit ya la usa.
export function setActivePalette(bank, n) {
  bank.active = n;
  bank.activeLut = bank.views[n];
}

// Marca un override por scanline. La línea `fromLine` (y siguientes,
// hasta el próximo override o fin de cuadro) usará la paleta `n`.
// Pasar n = -1 limpia el override en esa línea (vuelve al flujo natural).
// docs/PLAN.md §5: "el cambio por scanline se aplica en bloques contiguos".
export function setScanlinePalette(bank, fromLine, n) {
  bank.scanlineOverride[fromLine] = n;
  if (n >= 0) bank.scanlineDirty = true;
}

// Resetea todos los overrides al estado "sin overrides". Llamado típico
// al inicio del cuadro siguiente cuando el cuadro previo los activó.
export function clearScanlineOverrides(bank) {
  bank.scanlineOverride.fill(-1);
  bank.scanlineDirty = false;
}
