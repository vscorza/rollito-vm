import { describe, it, expect } from 'vitest';
import {
  ACTOR_COUNT, ACTOR_FIELDS,
  F_X, F_Y, F_VX, F_VY, F_FLAGS, F_ANI_A, F_ANI_B, F_ANI_STATE,
  FLAG_HIDDEN, FLAG_FLIP_X,
  createSpriteState, advanceActors, renderActors,
  drawPattern, aabbCollide, actorDistance,
} from '../../src/core/sprites.js';
import { PIXELS, WIDTH } from '../../src/render/framebuffer.js';

function setupActor(s, idx, fields) {
  const off = idx * ACTOR_FIELDS;
  for (const [field, value] of Object.entries(fields)) {
    s.actors[off + Number(field)] = value;
  }
}

function makePattern(w, h, fillColor) {
  const px = new Uint8Array(w * h);
  px.fill(fillColor);
  return { w, h, pixels: px };
}

describe('createSpriteState', () => {
  it('arranca con 32 actores ocultos, sin animación, patternIdx[i]=i', () => {
    const s = createSpriteState();
    expect(s.actors.length).toBe(ACTOR_COUNT * ACTOR_FIELDS);
    for (let i = 0; i < ACTOR_COUNT; i++) {
      expect(s.actors[i * ACTOR_FIELDS + F_FLAGS]).toBe(FLAG_HIDDEN);
      expect(s.actors[i * ACTOR_FIELDS + F_ANI_A]).toBe(-1);
      expect(s.patternIdx[i]).toBe(i);
    }
    expect(s.patterns.length).toBe(32);
  });
});

describe('advanceActors', () => {
  it('actores ocultos no se mueven ni animan', () => {
    const s = createSpriteState();
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 50, [F_VX]: 5, [F_VY]: 3 });
    advanceActors(s);
    expect(s.actors[F_X]).toBe(100);
    expect(s.actors[F_Y]).toBe(50);
  });

  it('actores visibles avanzan por su velocidad', () => {
    const s = createSpriteState();
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 50, [F_VX]: 5, [F_VY]: -3, [F_FLAGS]: 0 });
    advanceActors(s);
    expect(s.actors[F_X]).toBe(105);
    expect(s.actors[F_Y]).toBe(47);
    advanceActors(s);
    expect(s.actors[F_X]).toBe(110);
    expect(s.actors[F_Y]).toBe(44);
  });

  it('animación cicla patrón cada t cuadros entre a y b', () => {
    const s = createSpriteState();
    setupActor(s, 0, {
      [F_FLAGS]: 0,
      [F_ANI_A]: 5, [F_ANI_B]: 7,
      [F_ANI_STATE]: (3 << 8) | 0,  // t=3, counter=0
    });
    s.patternIdx[0] = 5;

    advanceActors(s);  // counter 1
    expect(s.patternIdx[0]).toBe(5);
    advanceActors(s);  // counter 2
    expect(s.patternIdx[0]).toBe(5);
    advanceActors(s);  // counter 3 → reset, p++ → 6
    expect(s.patternIdx[0]).toBe(6);
    advanceActors(s); advanceActors(s); advanceActors(s);  // → 7
    expect(s.patternIdx[0]).toBe(7);
    advanceActors(s); advanceActors(s); advanceActors(s);  // → 5 (loopback)
    expect(s.patternIdx[0]).toBe(5);
  });
});

describe('drawPattern', () => {
  it('dibuja patrón con transparencia (color 0)', () => {
    const fb = new Uint8Array(PIXELS);
    // Patrón 3×3: borde 4, centro 0 (transparente).
    const px = new Uint8Array([4, 4, 4, 4, 0, 4, 4, 4, 4]);
    const pat = { w: 3, h: 3, pixels: px };
    fb.fill(7);  // pre-pinta el FB con 7
    drawPattern(fb, pat, 10, 10, false, false);
    // El centro (11,11) NO se sobreescribe (transparencia).
    expect(fb[11 * WIDTH + 11]).toBe(7);
    // El borde sí.
    expect(fb[10 * WIDTH + 10]).toBe(4);
    expect(fb[10 * WIDTH + 12]).toBe(4);
  });

  it('respeta clipping en bordes', () => {
    const fb = new Uint8Array(PIXELS);
    const pat = makePattern(8, 8, 5);
    drawPattern(fb, pat, -4, -4, false, false);
    expect(fb[0]).toBe(5);
    expect(fb[3 * WIDTH + 3]).toBe(5);
    // Posiciones más allá del patrón (que igual estaban dentro de pantalla)
    // siguen en 0.
    expect(fb[4 * WIDTH + 4]).toBe(0);
  });

  it('flipX espeja horizontalmente', () => {
    const fb = new Uint8Array(PIXELS);
    const px = new Uint8Array([1, 2, 3, 4]);
    const pat = { w: 4, h: 1, pixels: px };
    drawPattern(fb, pat, 0, 0, true, false);
    expect(fb[0]).toBe(4);
    expect(fb[1]).toBe(3);
    expect(fb[2]).toBe(2);
    expect(fb[3]).toBe(1);
  });
});

describe('renderActors', () => {
  it('dibuja sólo actores visibles con patrón válido', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(4, 4, 9);
    s.patterns[1] = makePattern(4, 4, 11);
    setupActor(s, 0, { [F_X]: 5, [F_Y]: 5, [F_FLAGS]: 0 });           // visible
    setupActor(s, 1, { [F_X]: 30, [F_Y]: 5, [F_FLAGS]: FLAG_HIDDEN }); // oculto

    const fb = new Uint8Array(PIXELS);
    renderActors(s, fb);
    expect(fb[5 * WIDTH + 5]).toBe(9);
    expect(fb[5 * WIDTH + 30]).toBe(0);
  });

  it('respeta el flag flipX del actor', () => {
    const s = createSpriteState();
    const px = new Uint8Array([1, 2, 3, 4]);
    s.patterns[0] = { w: 4, h: 1, pixels: px };
    setupActor(s, 0, { [F_X]: 0, [F_Y]: 0, [F_FLAGS]: FLAG_FLIP_X });
    const fb = new Uint8Array(PIXELS);
    renderActors(s, fb);
    expect(fb[0]).toBe(4);
    expect(fb[3]).toBe(1);
  });
});

describe('aabbCollide', () => {
  it('detecta solape entre dos actores visibles', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    s.patterns[1] = makePattern(8, 8, 2);
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: 0 });
    setupActor(s, 1, { [F_X]: 105, [F_Y]: 102, [F_FLAGS]: 0 });
    expect(aabbCollide(s, 0, 1)).toBe(1);
  });

  it('no colisiona si están separados', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    s.patterns[1] = makePattern(8, 8, 2);
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: 0 });
    setupActor(s, 1, { [F_X]: 200, [F_Y]: 100, [F_FLAGS]: 0 });
    expect(aabbCollide(s, 0, 1)).toBe(0);
  });

  it('actor oculto = no colisiona', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    s.patterns[1] = makePattern(8, 8, 2);
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: 0 });
    setupActor(s, 1, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: FLAG_HIDDEN });
    expect(aabbCollide(s, 0, 1)).toBe(0);
  });

  it('mismo actor consigo mismo = 0 (no auto-colisión)', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: 0 });
    expect(aabbCollide(s, 0, 0)).toBe(0);
  });

  it('toque por borde NO cuenta como colisión (estricto)', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    s.patterns[1] = makePattern(8, 8, 2);
    setupActor(s, 0, { [F_X]: 100, [F_Y]: 100, [F_FLAGS]: 0 });
    setupActor(s, 1, { [F_X]: 108, [F_Y]: 100, [F_FLAGS]: 0 });
    expect(aabbCollide(s, 0, 1)).toBe(0);
  });
});

describe('actorDistance', () => {
  it('distancia entre centros de actores 8x8', () => {
    const s = createSpriteState();
    s.patterns[0] = makePattern(8, 8, 1);
    s.patterns[1] = makePattern(8, 8, 2);
    setupActor(s, 0, { [F_X]: 0, [F_Y]: 0 });
    setupActor(s, 1, { [F_X]: 10, [F_Y]: 0 });
    // Centros: (4,4) vs (14,4) → dx=10 dy=0 → 10.
    expect(actorDistance(s, 0, 1)).toBe(10);
  });
});
