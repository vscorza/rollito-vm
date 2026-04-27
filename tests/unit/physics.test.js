import { describe, it, expect } from 'vitest';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { createState, VAR_INDEX } from '../../src/core/memory.js';
import {
  createSpriteState, advanceActors, ACTOR_FIELDS,
  F_X, F_Y, F_VX, F_VY, F_FLAGS, F_PHYS_MAP, F_PHYS_GRA, F_LIM_X1, F_LIM_X2,
  FLAG_HIDDEN, FLAG_ON_GROUND, FLAG_LIM_ACTIVE,
} from '../../src/core/sprites.js';
import {
  createMapState, setMap, setSolid, actorCollidesMap,
} from '../../src/core/maps.js';
import { createInputState } from '../../src/core/input.js';
import { runFromBytecode } from '../../src/core/interpreter.js';
import { PIXELS } from '../../src/render/framebuffer.js';

function makePattern(w, h, color) {
  const px = new Uint8Array(w * h);
  px.fill(color);
  return { w, h, pixels: px };
}

function build(source) {
  const vmRef = {
    fb: new Uint8Array(PIXELS),
    spriteState: createSpriteState(),
    mapState: createMapState(),
    inputState: createInputState(),
  };
  const parsed = parseProgram(source);
  for (const sprite of parsed.sprites) {
    vmRef.spriteState.patterns[sprite.index] = {
      w: sprite.width, h: sprite.height, pixels: sprite.pixels,
    };
  }
  for (const m of parsed.maps || []) {
    setMap(vmRef.mapState, m.index, m.cols, m.rows, m.cells);
  }
  const compiled = compile(parsed, vmRef);
  const state = createState();
  return { ...compiled, state, vmRef };
}

function run(c, fromLine) {
  const pc = c.lineToIdx[fromLine];
  runFromBytecode(c.state, c.vmRef, c.code, c.constants, pc);
}

const PHYS = { actorCollidesMap };

describe('GRA + advance: gravedad y caída', () => {
  it('actor con GRA cae acumulando vy y se detiene al llegar al piso', () => {
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    ss.patterns[1] = makePattern(8, 8, 2);
    const ms = createMapState();
    // 4 cols × 4 rows, fila inferior sólida (tile 1).
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 1, 1, 1,
    ]));
    setSolid(ms, 0, [1]);
    // Actor 8x8 en (8, 0). Floor empieza en y=24 (fila 3 × 8 px).
    const a = ss.actors;
    a[F_X] = 8; a[F_Y] = 0; a[F_FLAGS] = 0;
    a[F_PHYS_MAP] = 0; a[F_PHYS_GRA] = 1;

    // Itero hasta que el actor toque suelo.
    let frames = 0;
    while ((a[F_FLAGS] & FLAG_ON_GROUND) === 0 && frames < 100) {
      advanceActors(ss, ms, PHYS);
      frames++;
    }
    expect(frames).toBeLessThan(100);
    // Floor en y=24; actor 8 alto. Revert deja y entre [24-vy_max, 16].
    // Lo importante: ON_GROUND seteado, vy=0, y bottom no atraviesa.
    expect(a[F_Y]).toBeLessThanOrEqual(16);
    expect(a[F_Y] + 8).toBeLessThanOrEqual(24);
    expect(a[F_VY]).toBe(0);
    expect(a[F_FLAGS] & FLAG_ON_GROUND).toBe(FLAG_ON_GROUND);
  });

  it('movimiento horizontal se bloquea contra pared sólida', () => {
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    ss.patterns[1] = makePattern(8, 8, 2);
    const ms = createMapState();
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 1,
      0, 0, 0, 1,
      0, 0, 0, 1,
      0, 0, 0, 1,
    ]));
    setSolid(ms, 0, [1]);
    const a = ss.actors;
    a[F_X] = 16; a[F_Y] = 8; a[F_FLAGS] = 0;
    a[F_VX] = 4; a[F_VY] = 0;
    a[F_PHYS_MAP] = 0; a[F_PHYS_GRA] = 0;
    advanceActors(ss, ms, PHYS);
    advanceActors(ss, ms, PHYS);
    advanceActors(ss, ms, PHYS);
    // No supera x=24 (la pared está en col 3 → x=24).
    expect(a[F_X]).toBeLessThanOrEqual(24);
    expect(a[F_VX]).toBe(0);
  });

  it('ON_GROUND se limpia al saltar (vy < 0)', () => {
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    ss.patterns[1] = makePattern(8, 8, 2);
    const ms = createMapState();
    setMap(ms, 0, 4, 4, new Uint8Array([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 1, 1, 1,
    ]));
    setSolid(ms, 0, [1]);
    const a = ss.actors;
    a[F_X] = 8; a[F_Y] = 16; a[F_FLAGS] = FLAG_ON_GROUND;
    a[F_VX] = 0; a[F_VY] = -5;
    a[F_PHYS_MAP] = 0; a[F_PHYS_GRA] = 1;
    advanceActors(ss, ms, PHYS);
    expect(a[F_FLAGS] & FLAG_ON_GROUND).toBe(0);
  });
});

describe('LIM clamp', () => {
  it('actor confinado a rectángulo tras advance', () => {
    const ss = createSpriteState();
    ss.patterns[0] = makePattern(8, 8, 1);
    const a = ss.actors;
    a[F_X] = 100; a[F_Y] = 50; a[F_VX] = 50; a[F_VY] = 0;
    a[F_FLAGS] = FLAG_LIM_ACTIVE;
    a[F_LIM_X1] = 10; a[F_LIM_X2] = 110;
    advanceActors(ss, null, null);
    expect(a[F_X]).toBe(110);
    a[F_X] = 0;
    a[F_VX] = -50;
    advanceActors(ss, null, null);
    expect(a[F_X]).toBe(10);
  });
});

describe('SAL respeta PIE', () => {
  it('SAL aplica vy=-f sólo si ON_GROUND, y limpia el flag', () => {
    const c = build(`
SPRITE 0 8x8
11111111
11111111
11111111
11111111
11111111
11111111
11111111
11111111

PROGRAMA
10 SAL 0,5
20 RET
`);
    // Sin ON_GROUND → no salta.
    run(c, 10);
    expect(c.vmRef.spriteState.actors[F_VY]).toBe(0);

    // Con ON_GROUND → salta y se limpia el flag.
    c.vmRef.spriteState.actors[F_FLAGS] = FLAG_ON_GROUND;
    run(c, 10);
    expect(c.vmRef.spriteState.actors[F_VY]).toBe(-5);
    expect(c.vmRef.spriteState.actors[F_FLAGS] & FLAG_ON_GROUND).toBe(0);
  });
});

describe('BTN / TEC', () => {
  it('BTN(b) refleja el estado de inputState.buttons', () => {
    const c = build(`PROGRAMA
10 A=BTN(0)
20 B=BTN(4)
30 RET
`);
    c.vmRef.inputState.buttons[0] = 1;
    c.vmRef.inputState.buttons[4] = 1;
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
    expect(c.state.vars[VAR_INDEX.B]).toBe(1);
  });

  it('TEC(k) refleja el estado de inputState.keys', () => {
    const c = build(`PROGRAMA
10 A=TEC(32)
20 RET
`);
    c.vmRef.inputState.keys[32] = 1;
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
  });
});
