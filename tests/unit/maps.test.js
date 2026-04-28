import { describe, it, expect } from 'vitest';
import {
  createMapState, setMap, setSolid, readTile, writeTile,
  blitMap, blitMapAlpha, prerenderMap, setActiveBackground,
  actorCollidesMap, actorOnGround,
} from '../../src/core/maps.js';
import { makeDefaultBlendTable } from '../../src/core/sprites.js';
import {
  createSpriteState, ACTOR_FIELDS,
  F_X, F_Y, F_FLAGS, FLAG_HIDDEN,
} from '../../src/core/sprites.js';
import { PIXELS, WIDTH } from '../../src/render/framebuffer.js';

function makePattern(w, h, color) {
  const px = new Uint8Array(w * h);
  px.fill(color);
  return { w, h, pixels: px };
}

describe('createMapState / setMap', () => {
  it('arranca vacío y sin background activo', () => {
    const ms = createMapState();
    expect(ms.activeBackground).toBe(-1);
    for (let i = 0; i < 4; i++) expect(ms.maps[i]).toBeUndefined();
  });

  it('setMap registra el mapa con cells', () => {
    const ms = createMapState();
    const cells = new Uint8Array([0, 1, 1, 0]);
    setMap(ms, 0, 2, 2, cells);
    expect(ms.maps[0].cols).toBe(2);
    expect(ms.maps[0].rows).toBe(2);
    expect(ms.maps[0].cells).toEqual(cells);
    expect(ms.maps[0].dirty).toBe(true);
  });
});

describe('readTile / writeTile', () => {
  it('readTile fuera de rango devuelve 0', () => {
    const ms = createMapState();
    setMap(ms, 0, 3, 3, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(readTile(ms, 0, 0, 0)).toBe(1);
    expect(readTile(ms, 0, 2, 2)).toBe(9);
    expect(readTile(ms, 0, -1, 0)).toBe(0);
    expect(readTile(ms, 0, 3, 0)).toBe(0);
  });

  it('writeTile actualiza la celda y marca dirty', () => {
    const ms = createMapState();
    setMap(ms, 0, 3, 3, new Uint8Array(9));
    ms.maps[0].dirty = false;
    writeTile(ms, 0, 1, 1, 7);
    expect(readTile(ms, 0, 1, 1)).toBe(7);
    expect(ms.maps[0].dirty).toBe(true);
  });
});

describe('setSolid', () => {
  it('marca tiles sólidos', () => {
    const ms = createMapState();
    setMap(ms, 0, 1, 1, new Uint8Array([0]));
    setSolid(ms, 0, [1, 2, 5]);
    expect(ms.maps[0].solid[1]).toBe(1);
    expect(ms.maps[0].solid[2]).toBe(1);
    expect(ms.maps[0].solid[5]).toBe(1);
    expect(ms.maps[0].solid[3]).toBe(0);
  });
});

describe('blitMap + prerenderMap', () => {
  it('pinta sólo tiles no-cero usando los patrones de spriteState', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[1] = makePattern(8, 8, 4);
    setMap(ms, 0, 2, 1, new Uint8Array([0, 1]));  // [empty, tile1]
    const fb = new Uint8Array(PIXELS);
    blitMap(ms, 0, fb, 0, 0, ss.patterns);
    // Tile 0 (vacío) en col 0 → no pinta nada en (0..7, 0..7).
    expect(fb[0]).toBe(0);
    // Tile 1 en col 1 → pinta 8x8 con color 4 en (8..15, 0..7).
    expect(fb[8]).toBe(4);
    expect(fb[7 * WIDTH + 15]).toBe(4);
  });

  it('prerenderMap cachea y se invalida con writeTile', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[1] = makePattern(8, 8, 9);
    setMap(ms, 0, 2, 1, new Uint8Array([1, 0]));
    const buf1 = prerenderMap(ms, 0, ss.patterns);
    expect(buf1).toBeDefined();
    expect(buf1[0]).toBe(9);
    expect(ms.maps[0].dirty).toBe(false);
    // Sin writeTile, llamar de nuevo retorna mismo buffer sin re-render.
    const buf2 = prerenderMap(ms, 0, ss.patterns);
    expect(buf2).toBe(buf1);
    // writeTile invalida.
    writeTile(ms, 0, 1, 0, 1);
    expect(ms.maps[0].dirty).toBe(true);
    prerenderMap(ms, 0, ss.patterns);
    expect(buf1[8]).toBe(9);  // ahora también el segundo tile pintado
  });

  it('setActiveBackground marca dirty', () => {
    const ms = createMapState();
    setMap(ms, 0, 1, 1, new Uint8Array([0]));
    ms.maps[0].dirty = false;
    setActiveBackground(ms, 0);
    expect(ms.activeBackground).toBe(0);
    expect(ms.maps[0].dirty).toBe(true);
  });
});

describe('blitMapAlpha', () => {
  it('alpha>0 mezcla via blendTable y respeta cell 0', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[1] = makePattern(8, 8, 8);  // src color 8
    setMap(ms, 0, 2, 1, new Uint8Array([0, 1]));
    const fb = new Uint8Array(PIXELS);
    fb.fill(2);  // dst color 2 en todo el FB
    const bt = makeDefaultBlendTable();
    blitMapAlpha(ms, 0, fb, 0, 0, 4, bt, ss.patterns);
    // Cell 0 → no toca: pixel (0,0) sigue en 2.
    expect(fb[0]).toBe(2);
    // Cell 1 (col 1) → blend (8,2)/2 = 5.
    expect(fb[8]).toBe(5);
    expect(fb[7 * WIDTH + 15]).toBe(5);
  });

  it('cells fuera de la tabla de patrones se saltan', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[1] = makePattern(8, 8, 6);
    setMap(ms, 0, 2, 1, new Uint8Array([1, 5]));  // cell 5 = patrón vacío
    const fb = new Uint8Array(PIXELS);
    const bt = makeDefaultBlendTable();
    blitMapAlpha(ms, 0, fb, 0, 0, 4, bt, ss.patterns);
    // cell 1 pinta (blend con dst=0 → (6+0)/2 = 3).
    expect(fb[0]).toBe(3);
    // cell 5 sin patrón: nada en cols 8..15.
    expect(fb[8]).toBe(0);
  });
});

describe('actorCollidesMap', () => {
  it('detecta colisión cuando actor solapa tile sólido', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);  // actor
    ss.patterns[1] = makePattern(8, 8, 2);  // tile
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]));
    setSolid(ms, 0, [1]);
    const a = ss.actors;
    a[F_X] = 9; a[F_Y] = 9;
    a[F_FLAGS] = 0;
    expect(actorCollidesMap(ss, ms, 0, 0, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)).toBe(1);
  });

  it('no colisiona si actor está sobre tile no-sólido', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    ss.patterns[1] = makePattern(8, 8, 2);
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]));
    // No setSolid → tile 1 no es sólido.
    ss.actors[F_X] = 9; ss.actors[F_Y] = 9; ss.actors[F_FLAGS] = 0;
    expect(actorCollidesMap(ss, ms, 0, 0, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)).toBe(0);
  });

  it('actorOnGround chequea franja debajo del bbox', () => {
    const ms = createMapState();
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    ss.patterns[1] = makePattern(8, 8, 2);
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 1, 1, 1,
      1, 1, 1, 1,
    ]));
    setSolid(ms, 0, [1]);
    ss.actors[F_X] = 0; ss.actors[F_Y] = 8;  // top right above floor
    ss.actors[F_FLAGS] = 0;
    expect(actorOnGround(ss, ms, 0, 0, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)).toBe(1);
    ss.actors[F_Y] = 0;  // arriba en el aire
    expect(actorOnGround(ss, ms, 0, 0, F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN)).toBe(0);
  });
});
