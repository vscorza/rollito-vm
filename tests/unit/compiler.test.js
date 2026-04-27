import { describe, it, expect } from 'vitest';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { createState, VAR_INDEX } from '../../src/core/memory.js';
import { PIXELS, WIDTH } from '../../src/render/framebuffer.js';

function build(source) {
  const fbRef = { fb: new Uint8Array(PIXELS) };
  const parsed = parseProgram(source);
  const compiled = compile(parsed, fbRef);
  const state = createState();
  return { ...compiled, state, fbRef };
}

function run(compiled, fromLine) {
  const { program, lineToIdx, state, fbRef } = compiled;
  let pc = lineToIdx[fromLine];
  expect(pc).toBeDefined();
  let budget = 1_000_000;
  while (pc >= 0 && pc < program.length) {
    pc = program[pc](pc, state, fbRef.fb);
    if (--budget <= 0) throw new Error('budget overrun');
  }
}

describe('compile + run', () => {
  it('asignación simple y leída por otra línea', () => {
    const c = build(`PROGRAMA
10 A=42
20 B=A+1
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(42);
    expect(c.state.vars[VAR_INDEX.B]).toBe(43);
  });

  it('asignaciones compuestas', () => {
    const c = build(`PROGRAMA
10 A=5
20 A+=10
30 A*=2
40 A-=3
50 A/=4
60 RET
`);
    run(c, 10);
    // ((5+10)*2-3)/4 = 27/4 = 6 (entera)
    expect(c.state.vars[VAR_INDEX.A]).toBe(6);
  });

  it('IR salta a otra línea', () => {
    const c = build(`PROGRAMA
10 A=1
20 IR 40
30 A=99
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
  });

  it('SI ENT con número como atajo de IR', () => {
    const c = build(`PROGRAMA
10 A=5
20 SI A>3 ENT 40
30 B=99
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.B]).toBe(0);
  });

  it('SI ENT SINO ejecuta la rama correcta', () => {
    const c = build(`PROGRAMA
10 A=2
20 SI A>5 ENT B=1 SINO B=7
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.B]).toBe(7);
  });

  it('PAR/SIG ejecuta el body N+1 veces', () => {
    const c = build(`PROGRAMA
10 B=0
20 PAR I=1 A 5
30 B+=I
40 SIG
50 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.B]).toBe(15);  // 1+2+3+4+5
  });

  it('LLA / RET implementa subrutinas', () => {
    const c = build(`PROGRAMA
10 A=0
20 LLA 100
30 LLA 100
40 RET
100 A+=10
110 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(20);
  });

  it('FIN halta el handler', () => {
    const c = build(`PROGRAMA
10 A=1
20 FIN
30 A=99
40 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(1);
  });

  it('cadena ":" ejecuta varias sentencias en una línea', () => {
    const c = build(`PROGRAMA
10 A=5:B=A*2:C=B+1
20 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(5);
    expect(c.state.vars[VAR_INDEX.B]).toBe(10);
    expect(c.state.vars[VAR_INDEX.C]).toBe(11);
  });

  it('builtin BOR llena el framebuffer', () => {
    const c = build(`PROGRAMA
10 BOR 7
20 RET
`);
    run(c, 10);
    for (let i = 0; i < PIXELS; i++) {
      expect(c.fbRef.fb[i]).toBe(7);
    }
  });

  it('builtin PIN respeta el clipping', () => {
    const c = build(`PROGRAMA
10 PIN 10,20,3
20 PIN -1,0,9
30 PIN 320,0,9
40 RET
`);
    run(c, 10);
    expect(c.fbRef.fb[20 * WIDTH + 10]).toBe(3);
    // Los otros dos PIN no deben haber escrito nada en el FB.
    expect(c.fbRef.fb[0]).toBe(0);
  });

  it('builtin REC dibuja un rectángulo y respeta clipping', () => {
    const c = build(`PROGRAMA
10 REC 5,5,10,10,4
20 RET
`);
    run(c, 10);
    expect(c.fbRef.fb[5 * WIDTH + 5]).toBe(4);
    expect(c.fbRef.fb[14 * WIDTH + 14]).toBe(4);
    expect(c.fbRef.fb[15 * WIDTH + 14]).toBe(0);
  });

  it('EN CUADRO IR n hoistea como handler', () => {
    const c = build(`PROGRAMA
10 EN CUADRO IR 100
100 BOR 5
110 RET
`);
    expect(c.handlers.CUADRO).toBeDefined();
    expect(c.handlers.CUADRO).toBe(c.lineToIdx[100]);
  });

  it('IR a línea inexistente falla en compile-time', () => {
    expect(() => build(`PROGRAMA
10 IR 9999
`)).toThrow(/9999/);
  });

  it('asignación a variable read-only falla en compile-time', () => {
    expect(() => build(`PROGRAMA
10 CUA=5
`)).toThrow(/read-only/);
  });

  it('expresión con CUA lee el contador', () => {
    const c = build(`PROGRAMA
10 A=CUA
20 RET
`);
    c.state.vars[VAR_INDEX.CUA] = 17;
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.A]).toBe(17);
  });

  it('precedencia: NO A=0 niega la comparación, no la variable', () => {
    const c = build(`PROGRAMA
10 A=5
20 SI NO A=0 ENT B=1 SINO B=2
30 RET
`);
    run(c, 10);
    expect(c.state.vars[VAR_INDEX.B]).toBe(1);
  });
});
