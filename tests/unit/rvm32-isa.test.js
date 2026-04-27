import { describe, it, expect } from 'vitest';
import {
  RVM_OP, encodeR, encodeI, encodeJ, decode, disasm, getFormat,
} from '../../src/asm/rvm32-isa.js';

describe('RVM-32 ISA encoding', () => {
  it('encode/decode R-type round-trip', () => {
    const w = encodeR(RVM_OP.ADD, 3, 1, 2, 0);
    const d = decode(w);
    expect(d.op).toBe(RVM_OP.ADD);
    expect(d.rd).toBe(3);
    expect(d.rs1).toBe(1);
    expect(d.rs2).toBe(2);
    expect(d.func).toBe(0);
  });

  it('encode/decode I-type con imm16 positivo', () => {
    const w = encodeI(RVM_OP.ADDI, 5, 6, 1234);
    const d = decode(w);
    expect(d.op).toBe(RVM_OP.ADDI);
    expect(d.rd).toBe(5);
    expect(d.rs1).toBe(6);
    expect(d.imm16).toBe(1234);
  });

  it('encode/decode I-type con imm16 negativo (signed)', () => {
    const w = encodeI(RVM_OP.ADDI, 5, 6, -1234);
    const d = decode(w);
    expect(d.imm16).toBe(-1234);
  });

  it('encode/decode J-type con imm20 positivo', () => {
    const w = encodeJ(RVM_OP.JMP, 0, 100);
    const d = decode(w);
    expect(d.op).toBe(RVM_OP.JMP);
    expect(d.imm20).toBe(100);
  });

  it('encode/decode J-type con imm20 negativo (back-branch)', () => {
    const w = encodeJ(RVM_OP.JMP, 0, -50);
    const d = decode(w);
    expect(d.imm20).toBe(-50);
  });

  it('JAL: rd se preserva', () => {
    const w = encodeJ(RVM_OP.JAL, 15, 200);
    const d = decode(w);
    expect(d.rd).toBe(15);
    expect(d.imm20).toBe(200);
  });

  it('todos los opcodes tienen formato definido', () => {
    for (const [name, code] of Object.entries(RVM_OP)) {
      const fmt = getFormat(code);
      expect(['R', 'I', 'J', 'N']).toContain(fmt);
    }
  });

  it('disasm produce strings legibles', () => {
    expect(disasm(encodeR(RVM_OP.ADD, 1, 2, 3), 0))
      .toMatch(/ADD\s+R1,R2,R3/);
    expect(disasm(encodeI(RVM_OP.LW, 4, 5, 16), 0x10))
      .toMatch(/LW\s+R4,R5,16/);
    expect(disasm(encodeJ(RVM_OP.JMP, 0, -8), 0x20))
      .toMatch(/JMP\s+-8/);
  });

  it('encoding aprovecha 32 bits (no overflow en imm16 ni imm20)', () => {
    const w1 = encodeI(RVM_OP.LW, 0xf, 0xf, 0x7fff);
    expect(decode(w1).imm16).toBe(0x7fff);
    const w2 = encodeI(RVM_OP.LW, 0xf, 0xf, -0x8000);
    expect(decode(w2).imm16).toBe(-0x8000);
    const w3 = encodeJ(RVM_OP.JMP, 0, 0x7ffff);
    expect(decode(w3).imm20).toBe(0x7ffff);
    const w4 = encodeJ(RVM_OP.JMP, 0, -0x80000);
    expect(decode(w4).imm20).toBe(-0x80000);
  });

  it('opcodes únicos (no colisiones)', () => {
    const seen = new Set();
    for (const [name, code] of Object.entries(RVM_OP)) {
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('DIV/REM/LH/LHU/SH están definidos con formatos correctos', () => {
    expect(RVM_OP.DIV).toBe(0x29);
    expect(RVM_OP.REM).toBe(0x2A);
    expect(RVM_OP.LH).toBe(0x15);
    expect(RVM_OP.LHU).toBe(0x16);
    expect(RVM_OP.SH).toBe(0x17);
    expect(getFormat(RVM_OP.DIV)).toBe('R');
    expect(getFormat(RVM_OP.REM)).toBe('R');
    expect(getFormat(RVM_OP.LH)).toBe('I');
    expect(getFormat(RVM_OP.LHU)).toBe('I');
    expect(getFormat(RVM_OP.SH)).toBe('I');
  });
});
