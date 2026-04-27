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
  readByte, writeByte, readWord, writeWord, nextRandom, VAR_INDEX,
  readByteIndexed, writeByteIndexed, memCopy, memSet,
} from '../core/memory.js';
import {
  ACTOR_FIELDS, F_X, F_Y, F_VX, F_VY, F_FLAGS, F_ANI_A, F_ANI_B,
  F_ANI_STATE, F_PHYS_MAP, F_PHYS_GRA, F_LIM_X1, F_LIM_Y1, F_LIM_X2,
  F_LIM_Y2, FLAG_HIDDEN, FLAG_ON_GROUND, FLAG_LIM_ACTIVE,
  drawPattern, drawPatternAffine, drawPatternAlpha,
  aabbCollide, actorDistance,
} from '../core/sprites.js';
import {
  setSolid, blitMap, readTile, setActiveBackground,
  actorCollidesMap, actorOnGround,
} from '../core/maps.js';
import { drawText } from '../builtins/text.js';
import { DRAW_BUILTINS } from '../builtins/draw.js';
import { playSound, playNoise, silenceChannel } from '../audio/synth.js';
import {
  MMIO_BASE, MMIO_END, MMIO_ARG0, MMIO_CMD, MMIO_RESULT, CMD,
} from './mmio.js';

const BUDGET = 1_000_000;

// Crea un estado RVM-32 inicializado: 16 registros + flags.
// Registros pre-cargados con la convención del transpiler v2-A → RVM-32:
//   R6  = LSTACK_BASE = 0x60000 (loop stack PAR/SIG, crece hacia abajo)
//   R7  = ESTACK_BASE = 0x70000 (eval stack del bytecode v2-A)
//   R11 = ARRAYS_BASE = 0x08080 (state.arrays)
//   R12 = VARS_BASE   = 0x08000 (state.vars)
//   R14 = SP          = 0x80000 (call stack convencional, crece hacia abajo)
// El caller puede sobreescribir antes de runRVM32 para tests low-level.
export function createRvmState() {
  const regs = new Int32Array(16);
  regs[6]  = 0x60000 | 0;
  regs[7]  = 0x70000 | 0;
  regs[11] = 0x08080 | 0;
  regs[12] = 0x08000 | 0;
  regs[14] = 0x80000 | 0;
  return {
    regs,
    pc: 0,
    // MMIO scratch del transpilador (SW a MMIO_ARG*; SW a MMIO_CMD
    // dispara la acción).
    mmioArgs: new Int32Array(8),
    mmioResult: 0,
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
        const aMasked = (addr >>> 0) & 0x7FFFF;
        if (aMasked === MMIO_RESULT) {
          regs[d.rd] = rvmState.mmioResult | 0;
        } else {
          regs[d.rd] = readWord(vmState, vmRef, addr) | 0;
        }
        break;
      }
      case RVM_OP.SB: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        writeByte(vmState, vmRef, addr, regs[d.rd] & 0xff);
        break;
      }
      case RVM_OP.SW: {
        const addr = (regs[d.rs1] + d.imm16) | 0;
        const aMasked = (addr >>> 0) & 0x7FFFF;
        if (aMasked >= MMIO_BASE && aMasked < MMIO_END) {
          handleMmioWrite(rvmState, vmState, vmRef, aMasked, regs[d.rd] | 0);
        } else {
          writeWord(vmState, vmRef, addr, regs[d.rd] | 0);
        }
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

// =====================================================================
// MMIO dispatcher: SW al rango [MMIO_BASE, MMIO_END) escribe args/CMD;
// el CMD dispara la acción correspondiente leyendo args de mmioArgs[].
// Queries dejan el resultado en rvmState.mmioResult (LW MMIO_RESULT lo
// devuelve).
// =====================================================================

function handleMmioWrite(rvmState, vmState, vmRef, addr, val) {
  if (addr >= MMIO_ARG0 && addr < MMIO_CMD) {
    const idx = (addr - MMIO_ARG0) >>> 2;
    rvmState.mmioArgs[idx] = val | 0;
    return;
  }
  if (addr === MMIO_CMD) {
    dispatchMmioCmd(rvmState, vmState, vmRef, val & 0xff);
    return;
  }
  if (addr === MMIO_RESULT) {
    rvmState.mmioResult = val | 0;
    return;
  }
  // Direcciones reservadas dentro del rango pero no asignadas: ignorar.
}

function dispatchMmioCmd(rvmState, vmState, vmRef, cmd) {
  const A = rvmState.mmioArgs;
  switch (cmd) {
    // -------------------- drawing --------------------
    case CMD.BOR:
      DRAW_BUILTINS.BOR.fn(vmRef.fb, A[0]);
      return;
    case CMD.PIN:
      DRAW_BUILTINS.PIN.fn(vmRef.fb, A[0], A[1], A[2]);
      return;
    case CMD.REC:
      DRAW_BUILTINS.REC.fn(vmRef.fb, A[0], A[1], A[2], A[3], A[4]);
      return;
    case CMD.TXT: {
      // ARG2 = strIdx en pool; el caller debe haber pasado vmRef.constants
      // o equivalente. Para v1 asumimos que el transpiler emite una
      // copia local del string en CODE region y pasa el bytePc; pero
      // mantener constants en vmRef.rvmConstants es más simple. Si no
      // existe, se ignora.
      const strs = vmRef.rvmConstants;
      const idx = A[2];
      const s = strs && strs[idx] ? strs[idx] : '';
      drawText(vmRef.fb, A[0] | 0, A[1] | 0, s, A[3]);
      return;
    }

    // -------------------- sprites (drawing) --------------------
    case CMD.SPR: {
      const pat = vmRef.spriteState.patterns[A[0]];
      if (pat) drawPattern(vmRef.fb, pat, A[1], A[2], (A[3] & 1) !== 0, (A[3] & 2) !== 0);
      return;
    }
    case CMD.SPRR: {
      const pat = vmRef.spriteState.patterns[A[0]];
      if (pat) drawPatternAffine(vmRef.fb, pat, A[1], A[2], A[3] & 0xff, A[4] & 0xff, 0, vmRef.blendTable);
      return;
    }
    case CMD.SPRA: {
      const pat = vmRef.spriteState.patterns[A[0]];
      if (pat) drawPatternAlpha(vmRef.fb, pat, A[1], A[2], A[3] & 0x0f, vmRef.blendTable);
      return;
    }

    // -------------------- sprites (state) --------------------
    case CMD.MOV: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      a[off + F_X] = A[1];
      a[off + F_Y] = A[2];
      a[off + F_FLAGS] &= ~FLAG_HIDDEN;
      return;
    }
    case CMD.VEL: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      a[off + F_VX] = A[1];
      a[off + F_VY] = A[2];
      return;
    }
    case CMD.ANI: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      a[off + F_ANI_A] = A[1];
      a[off + F_ANI_B] = A[2];
      a[off + F_ANI_STATE] = ((A[3] | 0) & 0xff) << 8;
      vmRef.spriteState.patternIdx[A[0]] = A[1] & 0xff;
      return;
    }
    case CMD.OCU: {
      const off = A[0] * ACTOR_FIELDS + F_FLAGS;
      const a = vmRef.spriteState.actors;
      if (A[1]) a[off] |= FLAG_HIDDEN;
      else      a[off] &= ~FLAG_HIDDEN;
      return;
    }
    case CMD.INV: {
      const field = A[1] === 0 ? F_VX : F_VY;
      const off = A[0] * ACTOR_FIELDS + field;
      const a = vmRef.spriteState.actors;
      a[off] = -a[off];
      return;
    }
    case CMD.PAT:
      vmRef.spriteState.patternIdx[A[0]] = A[1] & 0xff;
      return;

    // -------------------- maps + physics --------------------
    case CMD.MAP_:
      blitMap(vmRef.mapState, A[0], vmRef.fb, A[1], A[2], vmRef.spriteState.patterns);
      return;
    case CMD.FON:
      setActiveBackground(vmRef.mapState, A[0]);
      return;
    case CMD.SOL: {
      const cnt = A[1] | 0;
      const tiles = new Array(cnt);
      for (let i = 0; i < cnt; i++) tiles[i] = A[2 + i];
      setSolid(vmRef.mapState, A[0], tiles);
      return;
    }
    case CMD.GRA: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      a[off + F_PHYS_MAP] = A[1];
      a[off + F_PHYS_GRA] = A[2];
      return;
    }
    case CMD.SAL: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      if (a[off + F_FLAGS] & FLAG_ON_GROUND) {
        a[off + F_VY] = -(A[1] | 0);
        a[off + F_FLAGS] &= ~FLAG_ON_GROUND;
      }
      return;
    }
    case CMD.LIM: {
      const off = A[0] * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      a[off + F_LIM_X1] = A[1];
      a[off + F_LIM_Y1] = A[2];
      a[off + F_LIM_X2] = A[3];
      a[off + F_LIM_Y2] = A[4];
      a[off + F_FLAGS] |= FLAG_LIM_ACTIVE;
      return;
    }

    // -------------------- audio --------------------
    case CMD.SON:
      playSound(vmRef.synth, A[0], A[1]);
      return;
    case CMD.RUI:
      playNoise(vmRef.synth, A[0]);
      return;
    case CMD.SIL:
      silenceChannel(vmRef.synth, A[0]);
      return;

    // -------------------- lifecycle --------------------
    case CMD.CARNIV:
      vmState.vars[VAR_INDEX.NIV] = A[0] | 0;
      vmState.pendingLevelLoad = true;
      return;

    // -------------------- queries (write to mmioResult) --------------
    case CMD.Q_X:
      rvmState.mmioResult = vmRef.spriteState.actors[A[0] * ACTOR_FIELDS + F_X];
      return;
    case CMD.Q_Y:
      rvmState.mmioResult = vmRef.spriteState.actors[A[0] * ACTOR_FIELDS + F_Y];
      return;
    case CMD.Q_VX:
      rvmState.mmioResult = vmRef.spriteState.actors[A[0] * ACTOR_FIELDS + F_VX];
      return;
    case CMD.Q_VY:
      rvmState.mmioResult = vmRef.spriteState.actors[A[0] * ACTOR_FIELDS + F_VY];
      return;
    case CMD.Q_VIS: {
      const flags = vmRef.spriteState.actors[A[0] * ACTOR_FIELDS + F_FLAGS];
      rvmState.mmioResult = (flags & FLAG_HIDDEN) ? 0 : 1;
      return;
    }
    case CMD.Q_COL:
      rvmState.mmioResult = aabbCollide(vmRef.spriteState, A[0], A[1]);
      return;
    case CMD.Q_DIS:
      rvmState.mmioResult = actorDistance(vmRef.spriteState, A[0], A[1]);
      return;
    case CMD.Q_COLM:
      rvmState.mmioResult = actorCollidesMap(
        vmRef.spriteState, vmRef.mapState, A[0], A[1],
        F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
      return;
    case CMD.Q_PIE: {
      const n = A[0] | 0;
      const off = n * ACTOR_FIELDS;
      const a = vmRef.spriteState.actors;
      if (a[off + F_FLAGS] & FLAG_ON_GROUND) {
        rvmState.mmioResult = 1;
      } else {
        const m = a[off + F_PHYS_MAP];
        rvmState.mmioResult = m < 0 ? 0 : actorOnGround(
          vmRef.spriteState, vmRef.mapState, n, m,
          F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
      }
      return;
    }
    case CMD.Q_TIL:
      rvmState.mmioResult = readTile(vmRef.mapState, A[0], A[1], A[2]);
      return;
    case CMD.Q_BTN: {
      const b = A[0] | 0;
      rvmState.mmioResult = (b < 0 || b >= 8) ? 0 : (vmRef.inputState.buttons[b] ? 1 : 0);
      return;
    }
    case CMD.Q_TEC: {
      const k = A[0] | 0;
      rvmState.mmioResult = (k < 0 || k >= 256) ? 0 : (vmRef.inputState.keys[k] ? 1 : 0);
      return;
    }
    case CMD.Q_ALE: {
      const n = A[0] | 0;
      rvmState.mmioResult = n <= 0 ? 0 : (nextRandom(vmState) % n);
      return;
    }
    case CMD.Q_ABS:
      rvmState.mmioResult = A[0] < 0 ? -A[0] : A[0];
      return;
    case CMD.Q_SGN:
      rvmState.mmioResult = A[0] > 0 ? 1 : A[0] < 0 ? -1 : 0;
      return;
    case CMD.Q_RAI:
      rvmState.mmioResult = A[0] < 0 ? 0 : (Math.sqrt(A[0]) | 0);
      return;
    case CMD.Q_SEN:
      rvmState.mmioResult = Math.round(Math.sin(A[0] * Math.PI / 180) * 1000) | 0;
      return;
    case CMD.Q_COS:
      rvmState.mmioResult = Math.round(Math.cos(A[0] * Math.PI / 180) * 1000) | 0;
      return;
    case CMD.Q_MIN:
      rvmState.mmioResult = A[0] < A[1] ? A[0] : A[1];
      return;
    case CMD.Q_MAX:
      rvmState.mmioResult = A[0] > A[1] ? A[0] : A[1];
      return;
    case CMD.Q_DIV:
      rvmState.mmioResult = A[1] === 0 ? 0 : ((A[0] / A[1]) | 0);
      return;
    case CMD.Q_MOD:
      rvmState.mmioResult = A[1] === 0 ? 0 : (A[0] % A[1]);
      return;

    // -------------------- memoria indirecta -------------------------
    case CMD.LDR:
      rvmState.mmioResult = readByteIndexed(vmRef, A[0], A[1], A[2]);
      return;
    case CMD.STR:
      writeByteIndexed(vmRef, A[0], A[1], A[2], A[3]);
      return;
    case CMD.MEMCPY:
      memCopy(vmState, vmRef, A[0], A[1], A[2]);
      return;
    case CMD.MEMSET:
      memSet(vmState, vmRef, A[0], A[1], A[2]);
      return;

    default:
      throw new Error(`MMIO_CMD desconocido: 0x${cmd.toString(16)}`);
  }
}
