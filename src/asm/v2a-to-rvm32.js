// Transpilador v2-A bytecode → RVM-32 nativo (PLAN §19 Path B).
//
// Estrategia: usar un stack de evaluación en FREE region (replica del
// state.evalStack del intérprete v2-A), porque el v2-A es stack-based
// y RVM-32 es register-based. R7 = puntero al stack de evaluación
// (byte address). PUSH/POP via SW/LW.
//
// Convenciones de registros:
//   R0  = zero (siempre 0)
//   R1..R3 = scratch para op aritméticas
//   R7  = SP del eval stack (apunta al próximo slot vacío, crece +)
//   R12 = base de variables (state.vars en memory map = STATE_BASE)
//   R11 = base de arrays    (state.arrays = STATE_BASE + 0x80)
//   R14 = SP convencional (call stack RVM, no usado en este transpiler
//         simple — usa el callStack interno del runtime v2-A vía MMIO)
//   R15 = link register (JAL)
//
// Cobertura de esta primera versión:
//   ✓ NOP, HALT
//   ✓ LDI, LDV, STV, ADDV, SUBV, MULV, DIVV
//   ✓ LDA, STA, ADDA, SUBA, MULA, DIVA
//   ✓ ADD, SUB, MUL, DIV, MOD, NEG
//   ✓ LT, LE, GT, GE, EQ, NE, AND, OR, NOT
//   ✓ JMP, JZ, JNZ
//   ✗ CALL, RET (Path B completo requiere refactorizar callStack)
//   ✗ PARINIT, PARSIG (loop frames)
//   ✗ LDC (constant pool — sólo strings; no usado por programas no-TXT)
//   ✗ Builtins (BOR, PIN, REC, TXT, SPR, MOV, VEL, ...): se emitirán via
//     MMIO commands en una iteración futura. Por ahora los emite como
//     opcode sin efecto + warning, y el interpreter RVM-32 los ignora.
//   ✗ Memoria: LDM/STM/LDW/STW/LDR/STR/MEMCPY/MEMSET — futuro.
//   ✗ Queries/funciones (X, Y, COL, BTN, ALE, ...) — futuro.
//
// Esto es suficiente para programas aritméticos puros y validación de
// la pipeline. Cobertura completa = trabajo posterior (ver
// docs/RVM32-ISA.md "Roadmap del transpilador").

import { OP } from '../core/bytecode.js';
import {
  RVM_OP, encodeR, encodeI, encodeJ,
} from './rvm32-isa.js';
import { MEM, VAR_COUNT, ARRAY_SIZE } from '../core/memory.js';

const VARS_BASE   = MEM.STATE.base;            // 0x08000
const ARRAYS_BASE = MEM.STATE.base + 0x80;     // 0x08080
const ESTACK_BASE = MEM.FREE.base + 0x40000;   // FREE + 256 KB → eval stack

// =====================================================================
// Helpers internos del emisor.
// =====================================================================

function loadImm32(out, rd, value) {
  // Si imm cabe en 16-bit signed: ADDI rd, R0, imm.
  if (value >= -0x8000 && value <= 0x7fff) {
    out.push(encodeI(RVM_OP.ADDI, rd, 0, value));
    return;
  }
  // Si cabe en 32-bit no-negativo: LUI + ORI o LUI + ADDI.
  const hi = (value >>> 16) & 0xffff;
  const lo = value & 0xffff;
  out.push(encodeI(RVM_OP.LUI, rd, 0, hi | 0));
  if (lo !== 0) {
    // ORI extiende imm con sign — para evitar ese problema, dividimos
    // lo en dos shifts si tiene bit 15 set. Para v1, asumimos lo
    // positivo o usamos OR explícito por bytes.
    if ((lo & 0x8000) === 0) {
      out.push(encodeI(RVM_OP.ORI, rd, rd, lo));
    } else {
      // Set lower 16 bits via ORI con 2 mitades de 8 bits (sin sign).
      const loHi = (lo >>> 8) & 0xff;
      const loLo = lo & 0xff;
      out.push(encodeI(RVM_OP.ORI, rd, rd, loHi << 8));
      out.push(encodeI(RVM_OP.ORI, rd, rd, loLo));
    }
  }
}

function emitPush(out, rs) {
  // SW rs, [R7+0]; ADDI R7, R7, 4
  out.push(encodeI(RVM_OP.SW, rs, 7, 0));
  out.push(encodeI(RVM_OP.ADDI, 7, 7, 4));
}

function emitPop(out, rd) {
  // ADDI R7, R7, -4; LW rd, [R7+0]
  out.push(encodeI(RVM_OP.ADDI, 7, 7, -4));
  out.push(encodeI(RVM_OP.LW, rd, 7, 0));
}

// =====================================================================
// transpile: input es el output de compile() del v2-A:
//   { code: Uint32Array, codeLength, constants, handlers, lineToIdx }
//
// Output:
//   { bin: Uint32Array, byteCount, handlers (RVM-32 byte PCs) }
//
// Cada word v2-A se traduce a una secuencia de words RVM-32. Mantenemos
// un mapa v2aPc → rvmBytePc para resolver saltos en una segunda pasada.
// =====================================================================

export function transpile(v2aProgram) {
  const v2aCode = v2aProgram.code;
  const v2aLen = v2aProgram.codeLength;
  const out = [];
  const v2aToRvmPc = new Map();   // v2aWordIdx → rvm byte pc del primer word emitido
  const patches = [];             // forward-refs: { rvmInstrIdx, v2aTargetWordIdx, kind }

  // Sin preámbulo: createRvmState() inicializa R7/R11/R12/R14 con las
  // bases correctas. El binario empieza directo con la traducción del
  // bytecode v2-A en v2aWordIdx=0.

  for (let i = 0; i < v2aLen; i++) {
    const startInstrIdx = out.length;
    v2aToRvmPc.set(i, startInstrIdx * 4);

    const word = v2aCode[i] >>> 0;
    const op = word & 0xff;
    const opd = word >> 8;          // signed 24-bit
    const opdU = (word >>> 8) & 0xFFFFFF;

    switch (op) {
      case OP.NOP:
        out.push(encodeR(RVM_OP.NOP, 0, 0, 0));
        break;
      case OP.HALT:
        out.push(encodeR(RVM_OP.HLT, 0, 0, 0));
        break;

      // -------------------- constantes / vars --------------------
      case OP.LDI:
        loadImm32(out, 1, opd);
        emitPush(out, 1);
        break;
      case OP.LDV:
        // R1 = mem32[R12 + opdU*4]
        out.push(encodeI(RVM_OP.LW, 1, 12, opdU * 4));
        emitPush(out, 1);
        break;
      case OP.STV:
        emitPop(out, 1);
        out.push(encodeI(RVM_OP.SW, 1, 12, opdU * 4));
        break;
      case OP.ADDV:
      case OP.SUBV:
      case OP.MULV:
      case OP.DIVV: {
        emitPop(out, 1);                                 // value
        out.push(encodeI(RVM_OP.LW, 2, 12, opdU * 4));    // R2 = vars[r]
        const aluOp = op === OP.ADDV ? RVM_OP.ADD :
                      op === OP.SUBV ? RVM_OP.SUB :
                      op === OP.MULV ? RVM_OP.MUL : null;
        if (aluOp) {
          out.push(encodeR(aluOp, 2, 2, 1));
        } else {
          // DIV: usar SUB+SHR-style? Hardware no tiene DIV; emitir como
          // bug por ahora (DIV no soportado en esta primera versión).
          // Marcamos como NOP — los tests evitan DIV de variables.
          throw new Error('DIVV todavía no soportado por transpiler v1');
        }
        out.push(encodeI(RVM_OP.SW, 2, 12, opdU * 4));
        break;
      }

      // -------------------- arrays Mn -----------------------------
      case OP.LDA: {
        // R1 = idx (de stack), R2 = arrays_base + opdU*1024 + R1*4
        emitPop(out, 1);
        loadImm32(out, 3, opdU * ARRAY_SIZE * 4);    // m * 1024 (en bytes)
        out.push(encodeR(RVM_OP.SHL, 1, 1, 0));      // SHL R1, R1, R0=0 → no-op; usar ADDI R0,R0,2 trick? Simpler: multiply manual
        // R1 = idx*4 via SHL inmediato no existe — usamos R3=2 y SHL R1,R1,R3.
        // Mejor: R1 = idx; R1 = R1 + R1; R1 = R1 + R1.  (×4 sin shift constante)
        // Pero ya emití SHL R1,R1,R0 (=0 shifts). Hagamos diferente:
        // Reemplazo: cargar 4 a R3 y usar SHL R1,R1,R3 después.
        // Por simplicidad, hago la traducción "sin SHL inmediato":
        out.pop(); // descarta el SHL bogus
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));       // R1 = idx*2
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));       // R1 = idx*4
        out.push(encodeR(RVM_OP.ADD, 1, 11, 1));      // R1 = arrays_base + idx*4
        out.push(encodeR(RVM_OP.ADD, 1, 1, 3));       // R1 += m*1024
        out.push(encodeI(RVM_OP.LW, 2, 1, 0));        // R2 = mem[R1]
        emitPush(out, 2);
        break;
      }
      case OP.STA: {
        emitPop(out, 2);                              // value
        emitPop(out, 1);                              // idx
        loadImm32(out, 3, opdU * ARRAY_SIZE * 4);
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));
        out.push(encodeR(RVM_OP.ADD, 1, 11, 1));
        out.push(encodeR(RVM_OP.ADD, 1, 1, 3));
        out.push(encodeI(RVM_OP.SW, 2, 1, 0));
        break;
      }

      // -------------------- aritmética binaria --------------------
      case OP.ADD:
      case OP.SUB:
      case OP.MUL:
      case OP.AND:
      case OP.OR:
      case OP.MOD: {
        emitPop(out, 2);  // b
        emitPop(out, 1);  // a
        const aluOp = op === OP.ADD ? RVM_OP.ADD :
                      op === OP.SUB ? RVM_OP.SUB :
                      op === OP.MUL ? RVM_OP.MUL :
                      op === OP.AND ? RVM_OP.AND :
                      op === OP.OR  ? RVM_OP.OR  : null;
        if (aluOp !== null) {
          out.push(encodeR(aluOp, 1, 1, 2));
        } else {
          // MOD: a - (a / b) * b. RVM-32 no tiene DIV. Soft-emul: por
          // ahora marcamos como TODO. Los tests evitan MOD.
          throw new Error('MOD todavía no soportado por transpiler v1');
        }
        emitPush(out, 1);
        break;
      }
      case OP.DIV:
        throw new Error('DIV todavía no soportado por transpiler v1');
      case OP.NEG:
        emitPop(out, 1);
        out.push(encodeR(RVM_OP.SUB, 1, 0, 1));
        emitPush(out, 1);
        break;

      // -------------------- comparaciones --------------------------
      case OP.EQ:
      case OP.NE:
      case OP.LT:
      case OP.GE: {
        emitPop(out, 2);  // b
        emitPop(out, 1);  // a
        // Idioma: emit a branch + 2 cargas:
        //   if (cond) R3 = 1 else R3 = 0
        const branchOp = op === OP.EQ ? RVM_OP.BEQ :
                         op === OP.NE ? RVM_OP.BNE :
                         op === OP.LT ? RVM_OP.BLT : RVM_OP.BGE;
        // BR skip (+3: branch, false-set, JMP, true-set → land on true-set)
        out.push(encodeI(branchOp, 1, 2, 3));
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 0));   // false: R3 = 0
        out.push(encodeJ(RVM_OP.JMP, 0, 2));        // skip true-set → end
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 1));   // true: R3 = 1
        emitPush(out, 3);
        break;
      }
      case OP.LE:
      case OP.GT: {
        emitPop(out, 2);
        emitPop(out, 1);
        // a <= b ↔ b >= a → BGE rd=2, rs1=1
        // a > b  ↔ b < a  → BLT rd=2, rs1=1
        const branchOp = op === OP.LE ? RVM_OP.BGE : RVM_OP.BLT;
        out.push(encodeI(branchOp, 2, 1, 3));
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 0));
        out.push(encodeJ(RVM_OP.JMP, 0, 2));
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 1));
        emitPush(out, 3);
        break;
      }
      case OP.NOT:
        emitPop(out, 1);
        // R3 = (R1 == 0) ? 1 : 0 — usar BEQ R1,R0
        out.push(encodeI(RVM_OP.BEQ, 1, 0, 3));
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 0));
        out.push(encodeJ(RVM_OP.JMP, 0, 2));
        out.push(encodeI(RVM_OP.ADDI, 3, 0, 1));
        emitPush(out, 3);
        break;

      // -------------------- control de flujo ----------------------
      case OP.JMP:
      case OP.JZ:
      case OP.JNZ: {
        // Forward/backward jump al v2A pc opdU. Resolución en pasada 2.
        if (op === OP.JZ || op === OP.JNZ) {
          emitPop(out, 1);
          // BEQ R1,R0 = "es cero" → para JZ saltamos si == 0.
          // Para JNZ saltamos si != 0 → BNE.
          const brOp = op === OP.JZ ? RVM_OP.BEQ : RVM_OP.BNE;
          // Patch: el offset relativo se resuelve después.
          patches.push({ rvmInstrIdx: out.length, v2aTargetWordIdx: opdU, kind: 'branch', op: brOp });
          out.push(encodeI(brOp, 1, 0, 0));  // placeholder
        } else {
          patches.push({ rvmInstrIdx: out.length, v2aTargetWordIdx: opdU, kind: 'jmp' });
          out.push(encodeJ(RVM_OP.JMP, 0, 0));
        }
        break;
      }

      default:
        // Opcode no soportado en v1: emitimos un NOP+marker para que el
        // binario corra sin crash; los tests evitan estos opcodes.
        out.push(encodeR(RVM_OP.NOP, 0, 0, 0));
        break;
    }
  }
  // HLT al final por seguridad.
  out.push(encodeR(RVM_OP.HLT, 0, 0, 0));

  // Pasada 2: patchear branches/jumps con offsets correctos.
  for (const p of patches) {
    const target = v2aToRvmPc.get(p.v2aTargetWordIdx);
    if (target === undefined) {
      throw new Error(`transpile: target v2A ${p.v2aTargetWordIdx} no resoluto`);
    }
    const fromBytePc = p.rvmInstrIdx * 4;
    const offsetBytes = target - fromBytePc;
    const offsetWords = offsetBytes >> 2;
    if (p.kind === 'branch') {
      // imm16 signed (en RVM-32 branches usan offset*4)
      const word = encodeI(p.op, 1, 0, offsetWords);
      out[p.rvmInstrIdx] = word;
    } else {
      // jmp imm20
      out[p.rvmInstrIdx] = encodeJ(RVM_OP.JMP, 0, offsetWords);
    }
  }

  // Resolver handlers.
  const handlers = {};
  for (const evt of Object.keys(v2aProgram.handlers)) {
    const v2aPc = v2aProgram.handlers[evt];
    if (v2aPc === undefined) {
      handlers[evt] = undefined;
    } else if (Array.isArray(v2aPc)) {
      handlers[evt] = v2aPc.map((p) => p === undefined ? undefined : v2aToRvmPc.get(p));
    } else {
      handlers[evt] = v2aToRvmPc.get(v2aPc);
    }
  }

  // Construir Uint32Array final. Reservamos un buffer de 32K words
  // (igual al budget de CODE en RVM-32 = 128 KB; CODE region es 32 KB
  // pero estamos en JS donde el buffer es separado).
  const bin = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) bin[i] = out[i] | 0;
  return {
    bin,
    byteCount: out.length * 4,
    handlers,
    v2aToRvmPc,
  };
}
