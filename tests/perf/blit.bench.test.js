import { describe, it, expect } from 'vitest';
import { blit, paintGradientIndexed, PIXELS } from '../../src/render/framebuffer.js';
import {
  DEFAULT_PALETTE, createPaletteBank, setPalette, setScanlinePalette,
} from '../../src/render/palette.js';

// Hito 1+2: el blit (FB indexado → RGBA via PaletteBank) es el hot path real.
// Dos modos a medir:
//   - fast path: una LUT activa, sin overrides → el caso del 99% de cuadros.
//   - slow path: con un override por scanline para forzar el walk por línea.
//
// Máquina de referencia (TODO completar al primer dev local):
//   - CPU:
//   - Node:
//   - Resultado típico fast: ____ fps. slow: ____ fps.
//
// Umbrales mínimos (docs/PLAN.md §15 Hito 1): ≥ 1000 fps puros en cada uno.
// Hito 2 mantiene el mismo umbral; el camino lento debe seguir siendo
// barato (sólo ~200 chequeos extra por cuadro).

const ITERS = 10_000;
const MIN_FPS = 1000;

describe('blit baseline', () => {
  it(`fast path sostiene ≥ ${MIN_FPS} fps`, () => {
    const fb = new Uint8Array(PIXELS);
    const rgba32 = new Uint32Array(PIXELS);
    const bank = createPaletteBank();
    setPalette(bank, 0, DEFAULT_PALETTE);
    paintGradientIndexed(fb, 0);

    for (let i = 0; i < 200; i++) blit(fb, bank, rgba32);

    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) blit(fb, bank, rgba32);
    const t1 = performance.now();

    const ms = t1 - t0;
    const fps = (ITERS * 1000) / ms;
    console.log(`[bench fast] ${ITERS} blits en ${ms.toFixed(2)} ms → ${fps.toFixed(0)} fps`);
    expect(fps).toBeGreaterThan(MIN_FPS);
  });

  it(`slow path (1 override por scanline) sostiene ≥ ${MIN_FPS} fps`, () => {
    const fb = new Uint8Array(PIXELS);
    const rgba32 = new Uint32Array(PIXELS);
    const bank = createPaletteBank();
    setPalette(bank, 0, DEFAULT_PALETTE);
    setPalette(bank, 1, DEFAULT_PALETTE);
    setScanlinePalette(bank, 100, 1);
    paintGradientIndexed(fb, 0);

    for (let i = 0; i < 200; i++) blit(fb, bank, rgba32);

    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) blit(fb, bank, rgba32);
    const t1 = performance.now();

    const ms = t1 - t0;
    const fps = (ITERS * 1000) / ms;
    console.log(`[bench slow] ${ITERS} blits en ${ms.toFixed(2)} ms → ${fps.toFixed(0)} fps`);
    expect(fps).toBeGreaterThan(MIN_FPS);
  });
});
