import { describe, it, expect } from 'vitest';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { createState, VAR_INDEX } from '../../src/core/memory.js';
import {
  createSpriteState, ACTOR_FIELDS,
  F_X, F_Y, F_VX, F_VY, F_FLAGS, F_ANI_A, F_ANI_B,
  FLAG_HIDDEN, FLAG_FLIP_X,
} from '../../src/core/sprites.js';
import { PIXELS } from '../../src/render/framebuffer.js';

function build(source, withSprites = []) {
  const vmRef = {
    fb: new Uint8Array(PIXELS),
    spriteState: createSpriteState(),
  };
  for (const sp of withSprites) {
    vmRef.spriteState.patterns[sp.index] = {
      w: sp.w, h: sp.h, pixels: sp.pixels,
    };
  }
  const parsed = parseProgram(source);
  // Cargar sprites del .retro source también.
  for (const sprite of parsed.sprites) {
    vmRef.spriteState.patterns[sprite.index] = {
      w: sprite.width, h: sprite.height, pixels: sprite.pixels,
    };
  }
  const compiled = compile(parsed, vmRef);
  const state = createState();
  return { ...compiled, state, vmRef };
}

function run(c, fromLine) {
  const { program, lineToIdx, state } = c;
  let pc = lineToIdx[fromLine];
  expect(pc).toBeDefined();
  let budget = 1_000_000;
  while (pc >= 0 && pc < program.length) {
    pc = program[pc](pc, state);
    if (--budget <= 0) throw new Error('budget overrun');
  }
}

describe('SPRITE block parsing', () => {
  it('carga un sprite 8x8 con todos los índices hex', () => {
    const c = build(`
SPRITE 3 8x8
00111100
01222210
12222221
12222221
12222221
12222221
01222210
00111100

PROGRAMA
10 RET
`);
    const pat = c.vmRef.spriteState.patterns[3];
    expect(pat).toBeDefined();
    expect(pat.w).toBe(8);
    expect(pat.h).toBe(8);
    expect(pat.pixels[0]).toBe(0);
    expect(pat.pixels[2]).toBe(1);
    expect(pat.pixels[3 * 8 + 4]).toBe(2);
  });

  it('rechaza tamaño inválido', () => {
    expect(() => build(`
SPRITE 0 7x7
0000000
0000000
0000000
0000000
0000000
0000000
0000000

PROGRAMA
10 RET
`)).toThrow(/inválido/);
  });

  it('rechaza fila con cantidad de dígitos errónea', () => {
    expect(() => build(`
SPRITE 0 8x8
00000000
00000000
000
00000000
00000000
00000000
00000000
00000000

PROGRAMA
10 RET
`)).toThrow(/dígitos hex/);
  });
});

describe('MOV / VEL / OCU', () => {
  it('MOV setea posición y muestra', () => {
    const c = build(`PROGRAMA
10 MOV 0,160,100
20 RET
`);
    run(c, 10);
    const a = c.vmRef.spriteState.actors;
    expect(a[F_X]).toBe(160);
    expect(a[F_Y]).toBe(100);
    expect(a[F_FLAGS] & FLAG_HIDDEN).toBe(0);
  });

  it('VEL setea velocidades sin tocar posición', () => {
    const c = build(`PROGRAMA
10 MOV 0,50,50
20 VEL 0,3,-2
30 RET
`);
    run(c, 10);
    const a = c.vmRef.spriteState.actors;
    expect(a[F_VX]).toBe(3);
    expect(a[F_VY]).toBe(-2);
  });

  it('OCU 0,1 oculta; OCU 0,0 muestra', () => {
    const c = build(`PROGRAMA
10 MOV 0,5,5
20 OCU 0,1
30 RET
`);
    run(c, 10);
    expect(c.vmRef.spriteState.actors[F_FLAGS] & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
    const c2 = build(`PROGRAMA
10 MOV 0,5,5
20 OCU 0,1
30 OCU 0,0
40 RET
`);
    run(c2, 10);
    expect(c2.vmRef.spriteState.actors[F_FLAGS] & FLAG_HIDDEN).toBe(0);
  });
});

describe('INV n,EJE', () => {
  it('INV 0,X invierte vx', () => {
    const c = build(`PROGRAMA
10 MOV 0,100,100
20 VEL 0,5,3
30 INV 0,X
40 RET
`);
    run(c, 10);
    const a = c.vmRef.spriteState.actors;
    expect(a[F_VX]).toBe(-5);
    expect(a[F_VY]).toBe(3);
  });

  it('INV 0,Y invierte vy', () => {
    const c = build(`PROGRAMA
10 MOV 0,100,100
20 VEL 0,5,3
30 INV 0,Y
40 RET
`);
    run(c, 10);
    expect(c.vmRef.spriteState.actors[F_VY]).toBe(-3);
  });

  it('INV con segundo arg que no es X/Y falla en compile-time', () => {
    expect(() => build(`PROGRAMA
10 INV 0,Z
20 RET
`)).toThrow(/X o Y/);
  });
});

describe('PAT y ANI', () => {
  it('PAT n,p reasigna patternIdx[n]', () => {
    const c = build(`PROGRAMA
10 PAT 5,3
20 RET
`);
    run(c, 10);
    expect(c.vmRef.spriteState.patternIdx[5]).toBe(3);
  });

  it('ANI configura el ciclo y arranca en patrón a', () => {
    const c = build(`PROGRAMA
10 ANI 0,4,7,8
20 RET
`);
    run(c, 10);
    const a = c.vmRef.spriteState.actors;
    expect(a[F_ANI_A]).toBe(4);
    expect(a[F_ANI_B]).toBe(7);
    expect(c.vmRef.spriteState.patternIdx[0]).toBe(4);
  });
});

describe('Funciones X/Y/VX/VY/VIS/COL/DIS', () => {
  it('X(n) y Y(n) leen la posición del actor', () => {
    const c = build(`PROGRAMA
10 MOV 0,123,45
20 A=X(0)
30 B=Y(0)
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(123);
    expect(c.state.vars[VAR_INDEX.B]).toBe(45);
  });

  it('VIS(n) refleja el flag oculto', () => {
    const c = build(`PROGRAMA
10 MOV 0,10,10
20 A=VIS(0)
30 OCU 0,1
40 B=VIS(0)
50 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
    expect(c.state.vars[VAR_INDEX.B]).toBe(0);
  });

  it('COL en SI ENT ramifica según colisión', () => {
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

SPRITE 1 8x8
22222222
22222222
22222222
22222222
22222222
22222222
22222222
22222222

PROGRAMA
10 MOV 0,100,100
20 MOV 1,103,103
30 SI COL(0,1) ENT A=1 SINO A=0
40 MOV 1,200,100
50 SI COL(0,1) ENT B=1 SINO B=0
60 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
    expect(c.state.vars[VAR_INDEX.B]).toBe(0);
  });
});

describe('SPR (modo inmediato)', () => {
  it('SPR n,x,y dibuja sin afectar el estado del actor', () => {
    const c = build(`
SPRITE 0 8x8
55555555
55555555
55555555
55555555
55555555
55555555
55555555
55555555

PROGRAMA
10 SPR 0,30,40
20 RET
`);
    run(c, 10);
    const fb = c.vmRef.fb;
    expect(fb[40 * 320 + 30]).toBe(5);
    // El actor 0 sigue oculto (SPR no toca su estado).
    expect(c.vmRef.spriteState.actors[F_FLAGS] & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
  });

  it('SPR con flag flipX espeja horizontalmente', () => {
    const c = build(`
SPRITE 0 8x8
12345678
00000000
00000000
00000000
00000000
00000000
00000000
00000000

PROGRAMA
10 SPR 0,0,0,1
20 RET
`);
    run(c, 10);
    const fb = c.vmRef.fb;
    expect(fb[0]).toBe(8);
    expect(fb[7]).toBe(1);
  });
});
