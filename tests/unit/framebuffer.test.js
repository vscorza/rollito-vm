import { describe, it, expect } from 'vitest';
import {
  WIDTH, HEIGHT, PIXELS,
  blit, paintGradientIndexed,
} from '../../src/render/framebuffer.js';
import {
  PALETTE_SIZE,
  createPaletteBank, setPalette, setActivePalette, setScanlinePalette,
} from '../../src/render/palette.js';

function flatPalette(hex) {
  return new Array(16).fill(hex);
}

describe('paintGradientIndexed', () => {
  it('cubre los 16 índices de paleta', () => {
    const fb = new Uint8Array(PIXELS);
    paintGradientIndexed(fb, 0);
    expect(PIXELS).toBe(WIDTH * HEIGHT);
    expect(PIXELS).toBe(64000);
    const seen = new Uint8Array(16);
    for (let i = 0; i < fb.length; i++) seen[fb[i]] = 1;
    let total = 0;
    for (let i = 0; i < 16; i++) total += seen[i];
    expect(total).toBe(16);
  });

  it('escribe sólo índices 0-15', () => {
    const fb = new Uint8Array(PIXELS);
    paintGradientIndexed(fb, 17);
    for (let i = 0; i < fb.length; i++) {
      expect(fb[i]).toBeGreaterThanOrEqual(0);
      expect(fb[i]).toBeLessThanOrEqual(15);
    }
  });

  it('es determinista para un mismo frame', () => {
    const a = new Uint8Array(PIXELS);
    const b = new Uint8Array(PIXELS);
    paintGradientIndexed(a, 42);
    paintGradientIndexed(b, 42);
    expect(a).toEqual(b);
  });
});

describe('blit fast path (sin scanline overrides)', () => {
  it('mapea cada índice del FB a la entrada activeLut', () => {
    const bank = createPaletteBank();
    const p = new Array(16);
    for (let i = 0; i < 16; i++) p[i] = i.toString(16).padStart(2, '0').repeat(3);
    setPalette(bank, 0, p);

    const fb = new Uint8Array(PIXELS);
    for (let i = 0; i < PIXELS; i++) fb[i] = i & 0x0f;

    const out = new Uint32Array(PIXELS);
    blit(fb, bank, out);
    for (let i = 0; i < PIXELS; i++) {
      expect(out[i]).toBe(bank.views[0][fb[i]]);
    }
  });

  it('cambiar la paleta activa cambia el blit sin tocar el FB', () => {
    const bank = createPaletteBank();
    setPalette(bank, 0, flatPalette('FF0000'));
    setPalette(bank, 1, flatPalette('00FF00'));
    const fb = new Uint8Array(PIXELS);
    paintGradientIndexed(fb, 0);

    const a = new Uint32Array(PIXELS);
    const b = new Uint32Array(PIXELS);
    blit(fb, bank, a);
    setActivePalette(bank, 1);
    blit(fb, bank, b);
    expect(a[0]).not.toBe(b[0]);
    expect(a[PIXELS - 1]).not.toBe(b[PIXELS - 1]);
  });
});

describe('blit slow path (con scanline overrides)', () => {
  it('aplica el override desde la línea marcada hasta el fin (block contiguo)', () => {
    const bank = createPaletteBank();
    setPalette(bank, 0, flatPalette('FF0000'));
    setPalette(bank, 1, flatPalette('00FF00'));

    // FB lleno con índice 0.
    const fb = new Uint8Array(PIXELS);

    setScanlinePalette(bank, 100, 1);
    const out = new Uint32Array(PIXELS);
    blit(fb, bank, out);

    // Líneas 0..99 → paleta 0 (rojo). Líneas 100..199 → paleta 1 (verde).
    const red = bank.views[0][0];
    const green = bank.views[1][0];
    expect(out[0]).toBe(red);
    expect(out[99 * WIDTH]).toBe(red);
    expect(out[100 * WIDTH]).toBe(green);
    expect(out[(HEIGHT - 1) * WIDTH]).toBe(green);
  });

  it('múltiples overrides forman bloques sucesivos', () => {
    const bank = createPaletteBank();
    setPalette(bank, 0, flatPalette('FF0000'));
    setPalette(bank, 1, flatPalette('00FF00'));
    setPalette(bank, 2, flatPalette('0000FF'));

    const fb = new Uint8Array(PIXELS);
    setScanlinePalette(bank, 50, 1);
    setScanlinePalette(bank, 100, 2);

    const out = new Uint32Array(PIXELS);
    blit(fb, bank, out);

    const red = bank.views[0][0];
    const green = bank.views[1][0];
    const blue = bank.views[2][0];
    expect(out[0]).toBe(red);
    expect(out[49 * WIDTH]).toBe(red);
    expect(out[50 * WIDTH]).toBe(green);
    expect(out[99 * WIDTH]).toBe(green);
    expect(out[100 * WIDTH]).toBe(blue);
    expect(out[(HEIGHT - 1) * WIDTH]).toBe(blue);
  });

  it('sin overrides el resultado matchea el camino rápido', () => {
    const bank = createPaletteBank();
    setPalette(bank, 0, flatPalette('FF8040'));
    const fb = new Uint8Array(PIXELS);
    paintGradientIndexed(fb, 7);

    const fast = new Uint32Array(PIXELS);
    blit(fb, bank, fast);

    // Forzar el camino lento prendiendo el flag manualmente, sin
    // overrides reales. Debe dar el mismo resultado.
    bank.scanlineDirty = true;
    const slow = new Uint32Array(PIXELS);
    blit(fb, bank, slow);

    expect(slow).toEqual(fast);
  });
});
