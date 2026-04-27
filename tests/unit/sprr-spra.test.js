import { describe, it, expect } from 'vitest';
import { createVM } from '../../src/core/vm.js';
import {
  drawPatternAffine, drawPatternAlpha, makeDefaultBlendTable,
} from '../../src/core/sprites.js';
import { WIDTH, HEIGHT, PIXELS } from '../../src/render/framebuffer.js';

// Helper: pattern 8x8 sólido de un color.
function solidPattern(w, h, color) {
  const p = new Uint8Array(w * h);
  p.fill(color);
  return { w, h, pixels: p };
}

// Helper: pattern 8x8 con un pixel marcador en (0,0).
function markedPattern(w, h, body, mark) {
  const p = new Uint8Array(w * h);
  p.fill(body);
  p[0] = mark;
  return { w, h, pixels: p };
}

describe('drawPatternAffine — rotación + escala', () => {
  it('ang=0, esc=64 (1.0x): equivalente a SPR clásico', () => {
    const fb = new Uint8Array(PIXELS);
    const pat = solidPattern(8, 8, 7);
    drawPatternAffine(fb, pat, 50, 50, 0, 64, 0, null);
    let nz = 0;
    for (let y = 46; y < 56; y++) {
      for (let x = 46; x < 56; x++) {
        if (fb[y * WIDTH + x] !== 0) nz++;
      }
    }
    // ~64 pixels (8x8) ± algunos por bbox; al menos 50.
    expect(nz).toBeGreaterThan(50);
  });

  it('ang=64 (90°): rota el pixel marcador a otra esquina', () => {
    const fb = new Uint8Array(PIXELS);
    // Patrón con marcador (color 9) en la esquina superior-izq.
    const pat = markedPattern(8, 8, 7, 9);
    drawPatternAffine(fb, pat, 100, 100, 64, 64, 0, null);
    // Buscar el pixel color 9 en el FB; debe estar girado 90° del centro.
    let foundX = -1, foundY = -1;
    for (let y = 90; y < 110; y++) {
      for (let x = 90; x < 110; x++) {
        if (fb[y * WIDTH + x] === 9) { foundX = x; foundY = y; break; }
      }
      if (foundX !== -1) break;
    }
    expect(foundX).not.toBe(-1);
    // En 0°: marcador debería ir a esquina sup-izq del bbox (centro - 4, centro - 4).
    // En 90°: la esquina sup-izq del SPRITE pasa a esquina sup-der del FB
    // (rotación clockwise alrededor del centro).
    // Verificación cualitativa: foundX debe estar a la derecha del centro.
    expect(foundX).toBeGreaterThanOrEqual(100);
  });

  it('esc=128 (2.0x): el bbox crece y hay más pixels pintados', () => {
    const fb1 = new Uint8Array(PIXELS);
    const fb2 = new Uint8Array(PIXELS);
    const pat = solidPattern(8, 8, 7);
    drawPatternAffine(fb1, pat, 100, 100, 0, 64, 0, null);
    drawPatternAffine(fb2, pat, 100, 100, 0, 128, 0, null);
    let nz1 = 0, nz2 = 0;
    for (let i = 0; i < PIXELS; i++) {
      if (fb1[i] !== 0) nz1++;
      if (fb2[i] !== 0) nz2++;
    }
    // 2x escala → ~4x pixels (área).
    expect(nz2).toBeGreaterThan(nz1 * 2);
  });

  it('color 0 del patrón es transparente', () => {
    const fb = new Uint8Array(PIXELS);
    fb.fill(5);  // pre-llenar
    const px = new Uint8Array(64);  // 8x8, todo 0 (transparente)
    px[0] = 9;  // un solo pixel
    const pat = { w: 8, h: 8, pixels: px };
    drawPatternAffine(fb, pat, 50, 50, 0, 64, 0, null);
    // El fb sigue con 5 en todos lados salvo donde el pixel 9 cayó.
    let nine = 0, five = 0, zero = 0;
    for (let i = 0; i < PIXELS; i++) {
      if (fb[i] === 9) nine++;
      else if (fb[i] === 5) five++;
      else if (fb[i] === 0) zero++;
    }
    expect(nine).toBeGreaterThanOrEqual(1);
    expect(zero).toBe(0);  // nunca borra a 0
    expect(five).toBeGreaterThan(60000);
  });

  it('alpha + blendTable mezcla src y dst', () => {
    const fb = new Uint8Array(PIXELS);
    fb.fill(4);  // dst todo en color 4
    const pat = solidPattern(8, 8, 8);
    const blend = makeDefaultBlendTable();
    drawPatternAffine(fb, pat, 50, 50, 0, 64, 1, blend);
    // Default blend = (src + dst) / 2 = (8 + 4) / 2 = 6.
    let sixes = 0;
    for (let i = 0; i < PIXELS; i++) if (fb[i] === 6) sixes++;
    expect(sixes).toBeGreaterThan(50);
  });
});

describe('drawPatternAlpha — alpha sin rotar', () => {
  it('alpha=0: equivalente a SPR clásico', () => {
    const fb = new Uint8Array(PIXELS);
    fb.fill(2);
    const pat = solidPattern(8, 8, 9);
    drawPatternAlpha(fb, pat, 10, 10, 0, null);
    expect(fb[10 * WIDTH + 10]).toBe(9);
    expect(fb[10 * WIDTH + 17]).toBe(9);
    expect(fb[17 * WIDTH + 10]).toBe(9);
    expect(fb[0]).toBe(2);
  });

  it('alpha=1 con blendTable mezcla', () => {
    const fb = new Uint8Array(PIXELS);
    fb.fill(2);
    const pat = solidPattern(8, 8, 8);
    const blend = makeDefaultBlendTable();
    drawPatternAlpha(fb, pat, 10, 10, 1, blend);
    // (8 + 2) / 2 = 5
    expect(fb[10 * WIDTH + 10]).toBe(5);
  });

  it('respeta clipping en bordes', () => {
    const fb = new Uint8Array(PIXELS);
    const pat = solidPattern(8, 8, 9);
    drawPatternAlpha(fb, pat, -4, -4, 0, null);
    // Sólo la esquina inferior-derecha del sprite cae en el FB.
    expect(fb[0]).toBe(9);
    expect(fb[3 * WIDTH + 3]).toBe(9);
    // Píxeles fuera del sprite son 0.
    expect(fb[5 * WIDTH + 5]).toBe(0);
  });

  it('clipping al borde derecho/inferior', () => {
    const fb = new Uint8Array(PIXELS);
    const pat = solidPattern(8, 8, 9);
    drawPatternAlpha(fb, pat, WIDTH - 4, HEIGHT - 4, 0, null);
    // 4x4 visible.
    expect(fb[(HEIGHT - 1) * WIDTH + (WIDTH - 1)]).toBe(9);
    // Y no hay buffer overrun.
  });
});

describe('SPRR/SPRA en .retro: lexer + compiler + interpreter', () => {
  it('SPRR n,x,y,ang,esc compila y dibuja', () => {
    const vm = createVM(`
SPRITE 1 8x8
99999999
99999999
99999999
99999999
99999999
99999999
99999999
99999999
PROGRAMA
10 EN CUADRO IR 100
100 SPRR 1,100,100,0,64
110 RET
`);
    vm.runFrame();
    let nz = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] === 9) nz++;
    expect(nz).toBeGreaterThan(50);
  });

  it('SPRA n,x,y,a compila y aplica alpha cuando a>0', () => {
    const vm = createVM(`
SPRITE 1 8x8
88888888
88888888
88888888
88888888
88888888
88888888
88888888
88888888
PROGRAMA
10 EN CUADRO IR 100
100 REC 0,0,320,200,4
105 SPRA 1,50,50,1
110 RET
`);
    vm.runFrame();
    // Default blend (8+4)/2 = 6 en el área del sprite.
    let sixes = 0;
    for (let y = 50; y < 58; y++) {
      for (let x = 50; x < 58; x++) {
        if (vm.fb[y * WIDTH + x] === 6) sixes++;
      }
    }
    expect(sixes).toBe(64);
  });

  it('SPRA con a=0 es equivalente a SPR (sin blend)', () => {
    const vm = createVM(`
SPRITE 1 8x8
88888888
88888888
88888888
88888888
88888888
88888888
88888888
88888888
PROGRAMA
10 EN CUADRO IR 100
100 REC 0,0,320,200,4
105 SPRA 1,50,50,0
110 RET
`);
    vm.runFrame();
    // Sin blend, los 64 pixels son 8.
    let eights = 0;
    for (let y = 50; y < 58; y++) {
      for (let x = 50; x < 58; x++) {
        if (vm.fb[y * WIDTH + x] === 8) eights++;
      }
    }
    expect(eights).toBe(64);
  });
});
