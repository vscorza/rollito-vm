// Interpreter RVM-32 (PLAN §19).
//
// Ejecuta binario RVM-32 (Uint32Array de words 32-bit) sobre el mismo
// vmRef que la VM v2-A. La memoria/MMIO es compartida: usa los
// helpers existentes de memory.js (readByte/writeByte/readWord/writeWord).
// Los magic registers de v2-E disparan acciones reales (audio, level
// reload, repaint).
//
// El binario asume:
//   - Banco de registros R0..R15 (R0=0 hardwired).
//   - Stack en SP=R14 creciendo hacia abajo. SP inicial cargado por el
//     loader al inicio de FREE, por ejemplo.
//   - PC byte-address alineado a 4 (cada instrucción son 4 bytes).
//   - Bytecode reside en CODE region (0x00000..0x07FFF) o en su propio
//     buffer; el caller pasa el Uint32Array y un PC de inicio.
//
// La función expone también el banco de registros para tests/debug.

import { RVM_OP, decode } from './rvm32-isa.js';
import {
  readByte, writeByte, readWord, writeWord,
} from '../core/memory.js';

const BUDGET = 1_000_000;

// Crea un estado RVM-32 inicializado: 16 registros + flags.
// Registros pre-cargados con la convención del transpiler v2-A → RVM-32:
//   R7  = ESTACK_BASE = 0x70000 (eval stack del bytecode v2-A)
//   R11 = ARRAYS_BASE = 0x08080 (state.arrays)
//   R12 = VARS_BASE   = 0x08000 (state.vars)
//   R14 = SP          = 0x80000 (final de memoria, crece hacia abajo)
// El caller puede sobreescribir antes de runRVM32 para tests low-level.
export function createRvmState() {
  const regs = new Int32Array(16);
  regs[7]  = 0x70000 | 0;
  regs[11] = 0x08080 | 0;
  regs[12] = 0x08000 | 0;
  regs[14] = 0x80000 | 0;
  return {
    regs,
    pc: 0,
  };
}

// Ejecuta hasta HLT, RET (vía JR R15 con stack vacío) o budget.
// Retorna la cantidad de instrucciones ejecutadas.
export function runRVM32(rvmState, vmState, vmRef, code, startPc, options = {}) {
  const maxBudget = options.budget | 0 || BUDGET;
  const stopOnHlt = options.stopOnHlt !== false;
  const regs = rvmState.regs;
  // R0 siempre cero.
  regs[0] = 0;
  let pc = (startPc | 0) >>> 0;
  let executed = 0;
  while (executed < maxBudget) {
    if ((pc & 3) !== 0) throw new Error(`RVM-32: PC desalineado 0x${pc.toString(16)}`);
    const wordIdx = pc >>> 2;
    if (wordIdx < 0 || wordIdx >= code.length) {
      // Fuera del bytecode → halt.
      break;
    }
    const word = code[wordIdx];
    const d = decode(word);
    let nextPc = pc + 4;
    switch (d.op) {
      case RVM_OP.NOP: break;
      case RVM_OP.HLT:
        if (stopOnHlt) return executed + 1;
        break;

      // -------------------- memoria --------------------
      case RVM_OP.LB: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        const b = readByte(vmState, vmRef, addr);
        regs[d.rd] = (b << 24) >> 24;  // sign-extend
        break;
      }
      case RVM_OP.LBU: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        regs[d.rd] = readByte(vmState, vmRef, addr) & 0xff;
        break;
      }
      case RVM_OP.LW: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        regs[d.rd] = readWord(vmState, vmRef, addr) | 0;
        break;
      }
      case RVM_OP.SB: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        writeByte(vmState, vmRef, addr, regs[d.rd] & 0xff);
        break;
      }
      case RVM_OP.SW: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        writeWord(vmState, vmRef, addr, regs[d.rd] | 0);
        break;
      }

      // -------------------- ALU R-type --------------------
      case RVM_OP.ADD: regs[d.rd] = (regs[d.rs1] + regs[d.rs2]) | 0; break;
      case RVM_OP.SUB: regs[d.rd] = (regs[d.rs1] - regs[d.rs2]) | 0; break;
      case RVM_OP.AND: regs[d.rd] = regs[d.rs1] & regs[d.rs2]; break;
      case RVM_OP.OR:  regs[d.rd] = regs[d.rs1] | regs[d.rs2]; break;
      case RVM_OP.XOR: regs[d.rd] = regs[d.rs1] ^ regs[d.rs2]; break;
      case RVM_OP.SHL: regs[d.rd] = regs[d.rs1] << (regs[d.rs2] & 31); break;
      case RVM_OP.SHR: regs[d.rd] = regs[d.rs1] >>> (regs[d.rs2] & 31); break;
      case RVM_OP.SAR: regs[d.rd] = regs[d.rs1] >> (regs[d.rs2] & 31); break;
      case RVM_OP.MUL: regs[d.rd] = Math.imul(regs[d.rs1], regs[d.rs2]); break;

      // -------------------- ALU I-type --------------------
      case RVM_OP.ADDI: regs[d.rd] = (regs[d.rs1] + d.imm16) | 0; break;
      case RVM_OP.ANDI: regs[d.rd] = regs[d.rs1] & d.imm16; break;
      case RVM_OP.ORI:  regs[d.rd] = regs[d.rs1] | d.imm16; break;
      case RVM_OP.XORI: regs[d.rd] = regs[d.rs1] ^ d.imm16; break;
      case RVM_OP.LUI:  regs[d.rd] = (d.imm16 << 16) | 0; break;

      // -------------------- branches --------------------
      case RVM_OP.BEQ:
        if (regs[d.rd] === regs[d.rs1]) nextPc = (pc + d.imm16 * 4) | 0;
        break;
      case RVM_OP.BNE:
        if (regs[d.rd] !== regs[d.rs1]) nextPc = (pc + d.imm16 * 4) | 0;
        break;
      case RVM_OP.BLT:
        if (regs[d.rd] < regs[d.rs1]) nextPc = (pc + d.imm16 * 4) | 0;
        break;
      case RVM_OP.BGE:
        if (regs[d.rd] >= regs[d.rs1]) nextPc = (pc + d.imm16 * 4) | 0;
        break;

      // -------------------- jumps --------------------
      case RVM_OP.JMP:
        nextPc = (pc + d.imm20 * 4) | 0;
        break;
      case RVM_OP.JAL:
        regs[d.rd] = (pc + 4) | 0;
        nextPc = (pc + d.imm20 * 4) | 0;
        break;
      case RVM_OP.JR:
        nextPc = regs[d.rs1] | 0;
        break;

      default:
        throw new Error(`RVM-32: opcode desconocido 0x${d.op.toString(16)} @ pc=0x${pc.toString(16)}`);
    }
    // R0 siempre 0 (lo restablecemos por si una instrucción lo escribió).
    regs[0] = 0;
    pc = nextPc >>> 0;
    executed++;
  }
  rvmState.pc = pc;
  return executed;
}
