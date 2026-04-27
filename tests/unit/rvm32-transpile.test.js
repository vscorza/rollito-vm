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
  // R15 = byte address de la HLT al final del binario. Cuando el
  // handler ejecute RET (= JR R15), aterriza en HLT y termina.
  rvm.regs[15] = (tr.bin.length - 1) * 4;
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

describe('Transpiler v2-A → RVM-32 — control de flujo (CALL/RET, PAR/SIG)', () => {
  it('LLA + RET round-trip', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=10
105 LLA 200
110 B=A+1
115 RET
200 A=A*2
205 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(20);
    expect(state2.vars[VAR_INDEX.B]).toBe(21);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });

  it('PAR/SIG: suma 1..10', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=0
105 PAR I=1 A 10
110 A=A+I
115 SIG
120 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(55);  // 1+2+...+10
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('PAR anidado: 5x4 = 20 increments', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=0
105 PAR I=1 A 5
110 PAR J=1 A 4
115 A=A+1
120 SIG
125 SIG
130 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(20);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });
});

describe('Transpiler v2-A → RVM-32 — memoria absoluta', () => {
  it('STM/LDM byte round-trip en FREE', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 STM 0x30000,42
105 A=LDM(0x30000)
110 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(42);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('STW/LDW word round-trip en FREE', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 STW 0x30100,0x12345
105 A=LDW(0x30100)
110 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(0x12345);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });

  it('MEMSET + LDM verifica relleno', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 MEMSET 0x30000,7,8
105 A=LDM(0x30003)
110 B=LDM(0x30007)
115 C=LDM(0x30008)
120 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(7);
    expect(state2.vars[VAR_INDEX.B]).toBe(7);
    expect(state2.vars[VAR_INDEX.C]).toBe(0);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });
});

describe('Transpiler v2-A → RVM-32 — builtins via MMIO', () => {
  it('BOR llena el framebuffer', () => {
    const { vm1, vm2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 BOR 5
105 RET
`);
    let count1 = 0, count2 = 0;
    for (let i = 0; i < vm1.fb.length; i++) {
      if (vm1.fb[i] === 5) count1++;
      if (vm2.fb[i] === 5) count2++;
    }
    expect(count1).toBe(64000);
    expect(count2).toBe(64000);
  });

  it('REC dibuja un rectángulo del color esperado', () => {
    const { vm1, vm2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 REC 10,20,5,4,9
105 RET
`);
    // Comparar bytes en la región (10..14, 20..23).
    for (let y = 20; y < 24; y++) {
      for (let x = 10; x < 15; x++) {
        const off = y * 320 + x;
        expect(vm2.fb[off]).toBe(vm1.fb[off]);
        expect(vm2.fb[off]).toBe(9);
      }
    }
  });

  it('MOV/VEL: setea posición y velocidad del actor 0', () => {
    const { vm1, vm2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 MOV 0,50,100
105 VEL 0,3,-2
110 RET
`);
    expect(vm2.spriteState.actors[0]).toBe(50);   // F_X
    expect(vm2.spriteState.actors[1]).toBe(100);  // F_Y
    expect(vm2.spriteState.actors[2]).toBe(3);    // F_VX
    expect(vm2.spriteState.actors[3]).toBe(-2);   // F_VY
    expect(vm1.spriteState.actors[0]).toBe(vm2.spriteState.actors[0]);
    expect(vm1.spriteState.actors[1]).toBe(vm2.spriteState.actors[1]);
  });
});

describe('Transpiler v2-A → RVM-32 — queries via MMIO', () => {
  it('X/Y leen estado del actor', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 MOV 3,77,88
105 A=X(3)
110 B=Y(3)
115 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(77);
    expect(state2.vars[VAR_INDEX.B]).toBe(88);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
  });

  it('ABS/SGN/MIN/MAX', () => {
    const { state1, state2 } = cosim(`PROGRAMA
10 EN CUADRO IR 100
100 A=ABS(0-7)
105 B=SGN(0-3)
110 C=MIN(8,5)
115 D=MAX(2,9)
120 RET
`);
    expect(state2.vars[VAR_INDEX.A]).toBe(7);
    expect(state2.vars[VAR_INDEX.B]).toBe(-1);
    expect(state2.vars[VAR_INDEX.C]).toBe(5);
    expect(state2.vars[VAR_INDEX.D]).toBe(9);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
    expect(state1.vars[VAR_INDEX.B]).toBe(state2.vars[VAR_INDEX.B]);
    expect(state1.vars[VAR_INDEX.C]).toBe(state2.vars[VAR_INDEX.C]);
    expect(state1.vars[VAR_INDEX.D]).toBe(state2.vars[VAR_INDEX.D]);
  });

  it('BTN(b) refleja inputState.buttons', () => {
    const { compiled: c1, vmRef: vm1 } = buildV2a(`PROGRAMA
10 EN CUADRO IR 100
100 A=BTN(2)
105 RET
`);
    const state1 = createState();
    vm1.inputState.buttons[2] = 1;
    runFromBytecode(state1, vm1, c1.code, c1.constants, c1.handlers.CUADRO);

    const { compiled: c2, vmRef: vm2 } = buildV2a(`PROGRAMA
10 EN CUADRO IR 100
100 A=BTN(2)
105 RET
`);
    const state2 = createState();
    vm2.inputState.buttons[2] = 1;
    const tr = transpile(c2);
    const rvm = createRvmState();
    rvm.regs[15] = (tr.bin.length - 1) * 4;
    runRVM32(rvm, state2, vm2, tr.bin, tr.handlers.CUADRO);

    expect(state2.vars[VAR_INDEX.A]).toBe(1);
    expect(state1.vars[VAR_INDEX.A]).toBe(state2.vars[VAR_INDEX.A]);
  });
});
