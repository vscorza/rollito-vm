import { describe, it, expect } from 'vitest';
import {
  PALETTE_SIZE, MAX_PALETTES, DEFAULT_PALETTE,
  createPaletteBank, setPalette, setActivePalette,
  setScanlinePalette, clearScanlineOverrides,
} from '../../src/render/palette.js';
import { HEIGHT } from '../../src/render/framebuffer.js';

describe('createPaletteBank', () => {
  it('aloca 4 LUTs vacías y 4 vistas', () => {
    const bank = createPaletteBank();
    expect(bank.luts.length).toBe(MAX_PALETTES * PALETTE_SIZE);
    expect(bank.views.length).toBe(MAX_PALETTES);
    for (let i = 0; i < MAX_PALETTES; i++) {
      expect(bank.views[i].length).toBe(PALETTE_SIZE);
    }
  });

  it('arranca con paleta activa 0 y sin overrides', () => {
    const bank = createPaletteBank();
    expect(bank.active).toBe(0);
    expect(bank.activeLut).toBe(bank.views[0]);
    expect(bank.scanlineDirty).toBe(false);
    expect(bank.scanlineOverride.length).toBe(HEIGHT);
    for (let i = 0; i < HEIGHT; i++) {
      expect(bank.scanlineOverride[i]).toBe(-1);
    }
  });
});

describe('setPalette', () => {
  it('llena el slot correcto sin tocar los otros', () => {
    const bank = createPaletteBank();
    const flat = ['FF0000', '00FF00', '0000FF', 'FFFFFF',
                  '000000', '000000', '000000', '000000',
                  '000000', '000000', '000000', '000000',
                  '000000', '000000', '000000', '000000'];
    setPalette(bank, 2, flat);
    expect(bank.views[2][0] >>> 0).toBe(0xff0000ff);
    expect(bank.views[2][1] >>> 0).toBe(0xff00ff00);
    expect(bank.views[2][2] >>> 0).toBe(0xffff0000);
    expect(bank.views[2][3] >>> 0).toBe(0xffffffff);
    for (let i = 0; i < PALETTE_SIZE; i++) {
      expect(bank.views[0][i]).toBe(0);
      expect(bank.views[1][i]).toBe(0);
      expect(bank.views[3][i]).toBe(0);
    }
  });

  it('descompone correctamente un color hex con bits altos', () => {
    const bank = createPaletteBank();
    const p = new Array(16).fill('000000');
    p[0] = 'FF8040';
    setPalette(bank, 0, p);
    // R=FF, G=80, B=40, A=FF → (A<<24)|(B<<16)|(G<<8)|R = 0xFF4080FF.
    expect(bank.views[0][0] >>> 0).toBe(0xff4080ff);
  });

  it('la paleta default tiene 16 colores', () => {
    expect(DEFAULT_PALETTE.length).toBe(16);
    expect(DEFAULT_PALETTE[0]).toBe('000000');
    expect(DEFAULT_PALETTE[15]).toBe('FFCCAA');
  });
});

describe('setActivePalette', () => {
  it('actualiza activeLut a la vista correspondiente', () => {
    const bank = createPaletteBank();
    setActivePalette(bank, 3);
    expect(bank.active).toBe(3);
    expect(bank.activeLut).toBe(bank.views[3]);
  });
});

describe('setScanlinePalette / clearScanlineOverrides', () => {
  it('marca dirty al setear un override válido', () => {
    const bank = createPaletteBank();
    expect(bank.scanlineDirty).toBe(false);
    setScanlinePalette(bank, 100, 1);
    expect(bank.scanlineDirty).toBe(true);
    expect(bank.scanlineOverride[100]).toBe(1);
  });

  it('clear restaura todos los overrides a -1 y baja el flag', () => {
    const bank = createPaletteBank();
    setScanlinePalette(bank, 50, 1);
    setScanlinePalette(bank, 100, 2);
    clearScanlineOverrides(bank);
    expect(bank.scanlineDirty).toBe(false);
    for (let i = 0; i < HEIGHT; i++) {
      expect(bank.scanlineOverride[i]).toBe(-1);
    }
  });

  it('un override de -1 no marca dirty (sirve para "limpiar una línea")', () => {
    const bank = createPaletteBank();
    setScanlinePalette(bank, 100, -1);
    expect(bank.scanlineDirty).toBe(false);
  });
});
