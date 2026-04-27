import { describe, it, expect } from 'vitest';
import { compile } from '../../src/parser/compiler.js';
import { parseProgram } from '../../src/parser/parser.js';
import { createState, VAR_INDEX } from '../../src/core/memory.js';
import { runFromBytecode } from '../../src/core/interpreter.js';
import { transpile } from '../../src/asm/v2a-to-rvm32.js';
import { runRVM32, createRvmState } from '../../src/asm/interpreter.js';
import { PIXELS } from '../../src/render/framebuffer.js';

// Build minimal vmRef sin dependencias gráficas/audio.
function makeVmRef() {
  return {
    fb: new Uint8Array(PIXELS),
    spriteState: {
      actors: new Int16Array(32 * 16),
      patternIdx: new Uint8Array(32),
      patterns: [],
    },
    mapState: { maps: [], activeBackground: -1 },
    inputState: { buttons: new Uint8Array(8), keys: new Uint8Array(256) },
    bank: { luts: new Uint32Array(64), views: [], scanlineOverride: new Int8Array(200) },
    codeMem: new Uint8Array(0x8000),
    sonMem: new Uint8Array(0x3000),
    freeMem: new Uint8Array(0x50000),
    synth: { sounds: [], dirtySounds: new Uint8Array(16), channels: [] },
    blendTable: new Uint8Array(256),
  };
}

// Compila un programa v2-A y lo devuelve junto al state inicial.
function buildV2a(source) {
  const parsed = parseProgram(source);
  const vmRef = makeVmRef();
  const compiled = compile(parsed, vmRef);
  return { compiled, vmRef };
}

// Cosim: corre el handler indicado en v2-A y en RVM-32 transpilado;
// compara state.vars y state.arrays al final.
function cosim(source, handlerName = 'CUADRO') {
  const { compiled: c1, vmRef: vm1 } = buildV2a(source);
  const state1 = createState();
  const handler1 = c1.handlers[handlerName];
  if (handler1 === undefined) throw new Error(`No handler ${handlerName}`);
  runFromBytecode(state1, vm1, c1.code, c1.constants, handler1);

  const { compiled: c2, vmRef: vm2 } = buildV2a(source);
  const state2 = createState();
  const tr = transpile(c2);
  const rvm = createRvmState();
  runRVM32(rvm, state2, vm2, tr.bin, tr.handlers[handlerName]);

  return { state1, state2, vm1, vm2 };
}

describe('Transpiler v2-A → RVM-32 — cosim', () => {
  it('asignación constante', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=42
110 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(42);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('aritmética básica', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=5+3
105 B=A*2
110 C=B-1
115 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(8);
    expect(state2.vars[VAR_INDEX.B]).toBe(16);
    expect(state2.vars[VAR_INDEX.C]).toBe(15);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
    expect(state1.vars[VAR_INDEX.C]).toBe(state2.vars[VAR_INDEX.C]);
  });

  it('arrays Mn(i)', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 M0(3)=42
105 M0(7)=99
110 A=M0(3)+M0(7)
115 RET
`);
    expect(state2.arrays[3]).toBe(42);
    expect(state2.arrays[7]).toBe(99);
    expect(state2.vars[VAR_INDEX.A]).toBe(141);
    expect(state1.arrays[3]).toBe(state2.arrays[3]);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('compound assign +=, -=, *=', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=10
105 A+=5
110 A-=3
115 A*=2
120 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(24);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('SI/ENT con comparación toma rama true', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=10
105 SI A>5 ENT B=99
110 RET
`);
    expect(state2.vars[VAR_INDEX.B]).toBe(99);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });

  it('SI/ENT con comparación NO toma rama false', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=2
105 SI A>5 ENT B=99
110 RET
`);
    expect(state2.vars[VAR_INDEX.B]).toBe(0);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });

  it('IR (jump) salta correctamente hacia adelante', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=1
105 IR 120
110 A=99
120 B=A+10
125 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(1);
    expect(state2.vars[VAR_INDEX.B]).toBe(11);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });

  it('comparaciones LT/LE/GT/GE/EQ/NE producen 0/1', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=(5<10)+(5<=5)+(5>3)+(5>=5)+(5=5)+(5<>3)
105 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(6);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });
});
