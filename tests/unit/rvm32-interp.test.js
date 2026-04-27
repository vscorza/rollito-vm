import { describe, it, expect } from 'vitest';
import { RVM_OP, encodeR, encodeI, encodeJ } from '../../src/asm/rvm32-isa.js';
import { runRVM32, createRvmState } from '../../src/asm/interpreter.js';
import { createState } from '../../src/core/memory.js';
import { PIXELS } from '../../src/render/framebuffer.js';

// Mock vmRef minimal: el interpreter sólo escribe a memoria a través
// de readByte/writeByte/readWord/writeWord. Para tests de ALU/control
// no necesita memoria; para LW/SW alcanza con un freeMem.
function makeVmRef() {
  return {
    fb: new Uint8Array(PIXELS),
    spriteState: { actors: new Int16Array(32 * 16), patternIdx: new Uint8Array(32), patterns: [] },
    mapState: { maps: [], activeBackground: -1 },
    inputState: { buttons: new Uint8Array(8), keys: new Uint8Array(256) },
    bank: { luts: new Uint32Array(64) },
    codeMem: new Uint8Array(0x8000),
    sonMem: new Uint8Array(0x3000),
    freeMem: new Uint8Array(0x50000),
    synth: { sounds: [], dirtySounds: new Uint8Array(16), channels: [] },
    blendTable: new Uint8Array(256),
  };
}

function buildBin(words) {
  const bin = new Uint32Array(words.length);
  for (let i = 0; i < words.length; i++) bin[i] = words[i];
  return bin;
}

function run(words, options = {}) {
  const rvm = createRvmState();
  const state = createState();
  const vmRef = makeVmRef();
  const bin = buildBin(words);
  runRVM32(rvm, state, vmRef, bin, 0, options);
  return { rvm, state, vmRef };
}

describe('RVM-32 interpreter — ALU + branches', () => {
  it('LUI + ORI compone constante 0xCAFE7ABE (positive imm16)', () => {
    // LUI carga bits 16..31; ORI sign-extiende imm16. Para valores con
    // bit 15 set en la parte baja (como 0xBABE → -17730), el patrón
    // RISC-V estándar es LUI+ADDI con compensación. Para test simple,
    // usamos 0x7ABE (positivo) para que ORI funcione directo.
    const { rvm } = run([
      encodeI(RVM_OP.LUI, 1, 0, 0xCAFE),       // R1 = 0xCAFE0000
      encodeI(RVM_OP.ORI, 1, 1, 0x7ABE),       // R1 |= 0x7ABE
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[1] >>> 0).toBe(0xCAFE7ABE);
  });

  it('ADD/SUB/MUL', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 7),           // R1 = 7
      encodeI(RVM_OP.ADDI, 2, 0, 5),           // R2 = 5
      encodeR(RVM_OP.ADD, 3, 1, 2),            // R3 = 12
      encodeR(RVM_OP.SUB, 4, 1, 2),            // R4 = 2
      encodeR(RVM_OP.MUL, 5, 1, 2),            // R5 = 35
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(12);
    expect(rvm.regs[4]).toBe(2);
    expect(rvm.regs[5]).toBe(35);
  });

  it('R0 es siempre cero (lecturas y escrituras)', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 0, 0, 99),          // intento escribir R0
      encodeR(RVM_OP.ADD, 1, 0, 0),            // R1 = R0 + R0 = 0
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[0]).toBe(0);
    expect(rvm.regs[1]).toBe(0);
  });

  it('BEQ toma la rama si rd==rs1', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 5),
      encodeI(RVM_OP.ADDI, 2, 0, 5),
      // BEQ R1==R2: salta +2 (= salta al HLT, salta el ADDI siguiente)
      encodeI(RVM_OP.BEQ, 1, 2, 2),
      encodeI(RVM_OP.ADDI, 3, 0, 99),          // skipped
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0);
  });

  it('BNE NO toma la rama si rd==rs1', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 5),
      encodeI(RVM_OP.ADDI, 2, 0, 5),
      encodeI(RVM_OP.BNE, 1, 2, 2),
      encodeI(RVM_OP.ADDI, 3, 0, 99),          // ejecuta
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(99);
  });

  it('BLT: signed comparison', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, -5),
      encodeI(RVM_OP.ADDI, 2, 0, 3),
      // si R1 < R2 → +2.  -5 < 3 sí → salta.
      encodeI(RVM_OP.BLT, 1, 2, 2),
      encodeI(RVM_OP.ADDI, 3, 0, 99),
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0);
  });
});

describe('RVM-32 interpreter — control flow', () => {
  it('JMP loop hasta condición', () => {
    // Loop: contar de 0 a 10 en R1. Cuando R1==R2, salir al HLT.
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 0),                    // pc=0:  R1 = 0
      encodeI(RVM_OP.ADDI, 2, 0, 10),                   // pc=4:  R2 = 10
      // top: pc=8
      encodeI(RVM_OP.ADDI, 1, 1, 1),                    // pc=8:  R1++
      encodeI(RVM_OP.BEQ, 1, 2, 2),                     // pc=12: si R1==R2 → +2*4 = pc=20 (HLT)
      encodeJ(RVM_OP.JMP, 0, -2),                       // pc=16: JMP -2*4 = pc=8 (top)
      encodeR(RVM_OP.HLT, 0, 0, 0),                     // pc=20
    ]);
    expect(rvm.regs[1]).toBe(10);
  });

  it('JAL + JR: call y return manual', () => {
    // main: R1 = 0; JAL func; R1 += 1; HLT.
    // func: R1 = 100; JR R15.
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 0),                    // pc=0
      encodeJ(RVM_OP.JAL, 15, 3),                       // pc=4: jump +3*4=12 → pc=16 (func)
      encodeI(RVM_OP.ADDI, 1, 1, 1),                    // pc=8: R1++ después del retorno
      encodeR(RVM_OP.HLT, 0, 0, 0),                     // pc=12
      encodeI(RVM_OP.ADDI, 1, 0, 100),                  // pc=16: func: R1 = 100
      encodeR(RVM_OP.JR, 0, 15, 0),                     // pc=20: PC = R15
    ]);
    // R15 después de JAL = 8 → JR R15 → pc=8 → R1++ → R1=101.
    expect(rvm.regs[1]).toBe(101);
  });
});

describe('RVM-32 interpreter — memoria', () => {
  it('SW/LW round-trip en FREE', () => {
    const { rvm } = run([
      // R1 = 0x30000 (FREE base) — no entra en imm16 directo, usar LUI
      encodeI(RVM_OP.LUI, 1, 0, 3),                     // R1 = 0x30000
      encodeI(RVM_OP.ADDI, 2, 0, 0x1234),               // R2 = 0x1234
      encodeI(RVM_OP.SW, 2, 1, 0),                      // mem32[R1+0] = R2
      encodeI(RVM_OP.LW, 3, 1, 0),                      // R3 = mem32[R1+0]
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0x1234);
  });

  it('SB/LBU round-trip en FB', () => {
    const { rvm, vmRef } = run([
      encodeI(RVM_OP.LUI, 1, 0, 2),                     // R1 = 0x20000 (FB)
      encodeI(RVM_OP.ADDI, 2, 0, 7),                    // R2 = 7
      encodeI(RVM_OP.SB, 2, 1, 0),                      // fb[0] = 7
      encodeI(RVM_OP.LBU, 3, 1, 0),                     // R3 = fb[0]
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(7);
    expect(vmRef.fb[0]).toBe(7);
  });

  it('budget se respeta: programa infinito termina con budget exhausted', () => {
    // JMP a sí mismo, sin HLT.
    const { rvm } = run([
      encodeJ(RVM_OP.JMP, 0, 0),                        // JMP +0 → loop infinito
    ], { budget: 100 });
    // Sale por budget; no throw.
    expect(rvm.pc).toBeDefined();
  });
});

describe('RVM-32 interpreter — DIV/REM nativos', () => {
  it('DIV signed truncate', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 17),
      encodeI(RVM_OP.ADDI, 2, 0, 5),
      encodeR(RVM_OP.DIV, 3, 1, 2),       // 17/5 = 3
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(3);
  });

  it('DIV con negativos', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, -17),
      encodeI(RVM_OP.ADDI, 2, 0, 5),
      encodeR(RVM_OP.DIV, 3, 1, 2),       // -17/5 = -3 (truncate towards 0)
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(-3);
  });

  it('REM signed', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 17),
      encodeI(RVM_OP.ADDI, 2, 0, 5),
      encodeR(RVM_OP.REM, 3, 1, 2),       // 17%5 = 2
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(2);
  });

  it('DIV por cero → 0 (sin throw)', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 42),
      encodeI(RVM_OP.ADDI, 2, 0, 0),
      encodeR(RVM_OP.DIV, 3, 1, 2),
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0);
  });

  it('REM por cero → 0', () => {
    const { rvm } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 42),
      encodeI(RVM_OP.ADDI, 2, 0, 0),
      encodeR(RVM_OP.REM, 3, 1, 2),
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0);
  });
});

describe('RVM-32 interpreter — LH/LHU/SH', () => {
  it('LH sign-extiende; LHU zero-extiende', () => {
    const { rvm } = run([
      // STM 0x30000, 0x80; STM 0x30001, 0xFF (= 0xFF80 as Int16 → -128)
      encodeI(RVM_OP.LUI, 1, 0, 3),                     // R1 = 0x30000
      encodeI(RVM_OP.ADDI, 2, 0, 0x80),
      encodeI(RVM_OP.SB, 2, 1, 0),
      encodeI(RVM_OP.ADDI, 2, 0, 0xFF),
      encodeI(RVM_OP.SB, 2, 1, 1),
      encodeI(RVM_OP.LH, 3, 1, 0),                       // R3 = -128 (signed)
      encodeI(RVM_OP.LHU, 4, 1, 0),                      // R4 = 0xFF80 (unsigned)
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(-128);
    expect(rvm.regs[4]).toBe(0xFF80);
  });

  it('SH escribe 2 bytes little-endian', () => {
    const { rvm, vmRef } = run([
      encodeI(RVM_OP.LUI, 1, 0, 3),                     // R1 = 0x30000
      encodeI(RVM_OP.ADDI, 2, 0, 0x1234),
      encodeI(RVM_OP.SH, 2, 1, 0),
      encodeI(RVM_OP.LBU, 3, 1, 0),                       // 0x34
      encodeI(RVM_OP.LBU, 4, 1, 1),                       // 0x12
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(rvm.regs[3]).toBe(0x34);
    expect(rvm.regs[4]).toBe(0x12);
  });
});

describe('RVM-32 interpreter — $RNG register', () => {
  it('LW de $RNG (0xB300) avanza xorshift32', () => {
    const { rvm, state } = run([
      encodeI(RVM_OP.LUI, 1, 0, 0),                  // R1 = 0
      // Usar half-trick para 0xB300: 0x5980 + 0x5980 = 0xB300.
      encodeI(RVM_OP.ADDI, 1, 0, 0x5980),
      encodeR(RVM_OP.ADD, 1, 1, 1),                  // R1 = 0xB300
      encodeI(RVM_OP.LW, 2, 1, 0),                   // R2 = next rng
      encodeI(RVM_OP.LW, 3, 1, 0),                   // R3 = next next rng
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    // R2 y R3 distintos (xorshift produce distintos valores cada vez).
    expect(rvm.regs[2]).not.toBe(0);
    expect(rvm.regs[3]).not.toBe(0);
    expect(rvm.regs[2]).not.toBe(rvm.regs[3]);
    expect(state.seed).not.toBe(0);
  });

  it('STW a $RNG_SEED (0xB304) setea el seed', () => {
    const { state } = run([
      encodeI(RVM_OP.ADDI, 1, 0, 12345),             // R1 = 12345
      encodeI(RVM_OP.ADDI, 2, 0, 0x5980),
      encodeR(RVM_OP.ADD, 2, 2, 2),                  // R2 = 0xB300
      encodeI(RVM_OP.ADDI, 2, 2, 4),                 // R2 = 0xB304
      encodeI(RVM_OP.SW, 1, 2, 0),                   // [R2] = R1
      encodeR(RVM_OP.HLT, 0, 0, 0),
    ]);
    expect(state.seed).toBe(12345);
  });
});
