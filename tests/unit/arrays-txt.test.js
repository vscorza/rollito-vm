import { describe, it, expect } from 'vitest';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { createState, VAR_INDEX, ARRAY_SIZE } from '../../src/core/memory.js';
import { createSpriteState } from '../../src/core/sprites.js';
import { createMapState } from '../../src/core/maps.js';
import { createInputState } from '../../src/core/input.js';
import { createSynth } from '../../src/audio/synth.js';
import { PIXELS, WIDTH } from '../../src/render/framebuffer.js';

function build(source) {
  const vmRef = {
    fb: new Uint8Array(PIXELS),
    spriteState: createSpriteState(),
    mapState: createMapState(),
    inputState: createInputState(),
    synth: createSynth(null),
  };
  const parsed = parseProgram(source);
  const compiled = compile(parsed, vmRef);
  const state = createState();
  return { ...compiled, state, vmRef };
}

function run(c, fromLine) {
  let pc = c.lineToIdx[fromLine];
  let budget = 1_000_000;
  while (pc >= 0 && pc < c.program.length) {
    pc = c.program[pc](pc, c.state);
    if (--budget <= 0) throw new Error('budget overrun');
  }
}

describe('Arreglos M0..M7', () => {
  it('asigna y lee Mn(i)', () => {
    const c = build(`PROGRAMA
10 M0(3)=42
20 A=M0(3)
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(42);
  });

  it('cada Mn es un arreglo independiente', () => {
    const c = build(`PROGRAMA
10 M0(0)=1:M1(0)=2:M7(0)=99
20 A=M0(0):B=M1(0):C=M7(0)
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
    expect(c.state.vars[VAR_INDEX.B]).toBe(2);
    expect(c.state.vars[VAR_INDEX.C]).toBe(99);
  });

  it('M0(I) en un PAR pobla el arreglo', () => {
    const c = build(`PROGRAMA
10 PAR I=0 A 9
20 M0(I)=I*I
30 SIG
40 A=M0(7)
50 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(49);
  });

  it('índice fuera de rango se ignora silenciosamente en escritura', () => {
    const c = build(`PROGRAMA
10 M0(-1)=99
20 M0(256)=88
30 RET
`);
    expect(() => run(c, 10)).not.toThrow();
    // Nada se escribió en posiciones válidas adyacentes.
    expect(c.state.arrays[0]).toBe(0);
    expect(c.state.arrays[ARRAY_SIZE - 1]).toBe(0);
  });

  it('lectura fuera de rango devuelve 0', () => {
    const c = build(`PROGRAMA
10 A=M0(-1)
20 B=M0(500)
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(0);
    expect(c.state.vars[VAR_INDEX.B]).toBe(0);
  });

  it('Mn(i) += expr suma sin pisar el valor previo', () => {
    const c = build(`PROGRAMA
10 M0(5)=10
20 M0(5)+=7
30 A=M0(5)
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(17);
  });

  it('Mn(i) -= expr decrementa', () => {
    const c = build(`PROGRAMA
10 M0(0)=20
20 M0(0)-=5
30 A=M0(0)
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(15);
  });

  it('Mn(i) *= expr multiplica; /= divide entera', () => {
    const c = build(`PROGRAMA
10 M0(0)=4
20 M0(0)*=3
30 M0(1)=20
40 M0(1)/=6
50 A=M0(0):B=M0(1)
60 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(12);
    expect(c.state.vars[VAR_INDEX.B]).toBe(3);
  });

  it('Mn(i) += dentro de un PAR I=...', () => {
    const c = build(`PROGRAMA
10 PAR I=0 A 4
20 M0(I)=I
25 M0(I)+=10
30 SIG
40 A=M0(0):B=M0(4)
50 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(10);
    expect(c.state.vars[VAR_INDEX.B]).toBe(14);
  });

  it('compound op fuera de rango se ignora silenciosamente', () => {
    const c = build(`PROGRAMA
10 M0(-1)+=99
20 M0(256)+=99
30 RET
`);
    expect(() => run(c, 10)).not.toThrow();
    expect(c.state.arrays[0]).toBe(0);
  });
});

describe('TXT statement + fuente 8x8', () => {
  it('TXT 0,0,"A" pinta pixels en color 1 dentro de la región 8x8', () => {
    const c = build(`PROGRAMA
10 TXT 0,0,"A"
20 RET
`);
    run(c, 10);
    let pixelsLit = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (c.vmRef.fb[y * WIDTH + x] === 1) pixelsLit++;
      }
    }
    // La 'A' tiene aproximadamente 20 pixels prendidos.
    expect(pixelsLit).toBeGreaterThan(10);
    expect(pixelsLit).toBeLessThan(40);
  });

  it('TXT con color personalizado usa ese índice', () => {
    const c = build(`PROGRAMA
10 TXT 8,8,"A",7
20 RET
`);
    run(c, 10);
    let pixelsColor7 = 0;
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        if (c.vmRef.fb[y * WIDTH + x] === 7) pixelsColor7++;
      }
    }
    expect(pixelsColor7).toBeGreaterThan(10);
  });

  it('TXT con texto multi-char avanza 8px por caracter', () => {
    const c = build(`PROGRAMA
10 TXT 0,0,"AB"
20 RET
`);
    run(c, 10);
    // La A debe tener pixels en x=0..7, la B en x=8..15.
    let aLit = 0, bLit = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) if (c.vmRef.fb[y * WIDTH + x]) aLit++;
      for (let x = 8; x < 16; x++) if (c.vmRef.fb[y * WIDTH + x]) bLit++;
    }
    expect(aLit).toBeGreaterThan(5);
    expect(bLit).toBeGreaterThan(5);
  });

  it('caracteres no soportados se renderizan como espacio (sin pixels)', () => {
    const c = build(`PROGRAMA
10 TXT 0,0,"@@@"
20 RET
`);
    expect(() => run(c, 10)).not.toThrow();
    let lit = 0;
    for (let i = 0; i < 8 * WIDTH; i++) if (c.vmRef.fb[i]) lit++;
    expect(lit).toBe(0);
  });

  it('case-insensitive: "hola" usa los mismos glifos que "HOLA"', () => {
    const a = build(`PROGRAMA
10 TXT 0,0,"hola"
20 RET
`);
    const b = build(`PROGRAMA
10 TXT 0,0,"HOLA"
20 RET
`);
    run(a, 10); run(b, 10);
    for (let i = 0; i < 8 * WIDTH; i++) {
      expect(a.vmRef.fb[i]).toBe(b.vmRef.fb[i]);
    }
  });

  it('error si tercer arg no es literal de string', () => {
    expect(() => build(`PROGRAMA
10 TXT 0,0,A
20 RET
`)).toThrow(/literal de string/);
  });

  it('error si TXT recibe sólo 2 args', () => {
    expect(() => build(`PROGRAMA
10 TXT 0,0
20 RET
`)).toThrow(/3 o 4 args/);
  });
});
