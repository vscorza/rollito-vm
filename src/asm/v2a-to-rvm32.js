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
import { MEM, ARRAY_SIZE } from '../core/memory.js';
import {
  MMIO_ARG0, MMIO_CMD, MMIO_RESULT, CMD,
} from './mmio.js';

const VARS_BASE   = MEM.STATE.base;            // 0x08000
const ARRAYS_BASE = MEM.STATE.base + 0x80;     // 0x08080
const ESTACK_BASE = MEM.FREE.base + 0x40000;   // FREE + 256 KB → eval stack
const LSTACK_BASE = MEM.FREE.base + 0x30000;   // FREE + 192 KB → loop stack

// =====================================================================
// Helpers internos del emisor.
// =====================================================================

// Carga un valor Int32 arbitrario a rd. Maneja correctamente valores
// con bit 15 set en la mitad baja (que ORI/ADDI sign-extenderían
// corrompiendo los bits altos). Usa R9 como scratch cuando hace falta.
function loadImm32(out, rd, value) {
  const v = value | 0;
  if (v >= -0x8000 && v <= 0x7fff) {
    out.push(encodeI(RVM_OP.ADDI, rd, 0, v));
    return;
  }
  // Valores 16-bit unsigned con bit 15 set (0x8000..0xFFFF):
  // construimos via ADD self ("doblar la mitad").
  if (v >= 0 && v <= 0xFFFF) {
    const half = v >>> 1;
    out.push(encodeI(RVM_OP.ADDI, rd, 0, half));
    out.push(encodeR(RVM_OP.ADD, rd, rd, rd));
    if (v & 1) out.push(encodeI(RVM_OP.ADDI, rd, rd, 1));
    return;
  }
  // 32-bit: LUI hi (no sign issue ya que LUI shifts off los upper).
  // Para lo: si bit 15 set, build via half-trick en R9; OR a rd.
  const hi = (v >>> 16) & 0xffff;
  const lo = v & 0xffff;
  out.push(encodeI(RVM_OP.LUI, rd, 0, hi & 0xffff));
  if (lo === 0) return;
  if ((lo & 0x8000) === 0) {
    out.push(encodeI(RVM_OP.ORI, rd, rd, lo));
    return;
  }
  // lo tiene bit 15: build clean en R9 con half-trick, después OR.
  const half = lo >>> 1;
  out.push(encodeI(RVM_OP.ADDI, 9, 0, half));
  out.push(encodeR(RVM_OP.ADD, 9, 9, 9));
  if (lo & 1) out.push(encodeI(RVM_OP.ADDI, 9, 9, 1));
  out.push(encodeR(RVM_OP.OR, rd, rd, 9));
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
// MMIO emit helpers para builtins/queries.
// =====================================================================

// Empuja el valor de Rsrc al ARG[idx] del MMIO.
function emitMmioStoreArg(out, idx, rsrc) {
  // SW Rsrc, [R5 + idx*4]; pero R5 no está reservado. Usemos:
  //   loadImm R8, MMIO_ARG0 + idx*4
  //   SW Rsrc, R8, 0
  // Demasiado caro. En vez: cargamos R8 = MMIO_ARG0 una vez por funcion
  // (caller-saved). Para v1 simple, hacemos load + SW cada vez.
  loadImm32(out, 8, MMIO_ARG0 + idx * 4);
  out.push(encodeI(RVM_OP.SW, rsrc, 8, 0));
}

// SW val a MMIO_CMD = code (dispara el comando).
function emitMmioCmd(out, code) {
  loadImm32(out, 8, MMIO_CMD);
  loadImm32(out, 1, code);
  out.push(encodeI(RVM_OP.SW, 1, 8, 0));
}

// LW Rdst, MMIO_RESULT.
function emitMmioLoadResult(out, rdst) {
  loadImm32(out, 8, MMIO_RESULT);
  out.push(encodeI(RVM_OP.LW, rdst, 8, 0));
}

// Statement con N args: pop N en ARG[N-1..0], luego CMD.
function emitMmioStmt(out, arity, cmdCode) {
  // El stack tiene los args en orden push: arg0, arg1, ..., arg[N-1] arriba.
  // Pop top primero → ARG[N-1].
  for (let i = arity - 1; i >= 0; i--) {
    emitPop(out, 1);
    emitMmioStoreArg(out, i, 1);
  }
  emitMmioCmd(out, cmdCode);
}

// Query con N args: pop args, set ARGn, CMD, push RESULT.
function emitMmioQuery(out, arity, cmdCode) {
  for (let i = arity - 1; i >= 0; i--) {
    emitPop(out, 1);
    emitMmioStoreArg(out, i, 1);
  }
  emitMmioCmd(out, cmdCode);
  emitMmioLoadResult(out, 1);
  emitPush(out, 1);
}

// INV usa el operand del bytecode (0=X, 1=Y) en lugar de un arg en stack.
function emitMmioStmtImmAxis(out, axis) {
  emitPop(out, 1);                          // n
  emitMmioStoreArg(out, 0, 1);
  loadImm32(out, 1, axis & 0xff);
  emitMmioStoreArg(out, 1, 1);
  emitMmioCmd(out, CMD.INV);
}

// Aliases locales para los CMD de memoria indirecta.
const CMD_LDR    = CMD.LDR;
const CMD_STR    = CMD.STR;
const CMD_MEMCPY = CMD.MEMCPY;
const CMD_MEMSET = CMD.MEMSET;

// =====================================================================
// Refactor A.4: math primitives inline native (V2-ARCH-DECISIONS §8).
// =====================================================================

// ABS x:  pop R1; SAR R2, R1, R3=31; XOR R1, R1, R2; SUB R1, R1, R2; push.
function emitAbsInline(out) {
  emitPop(out, 1);
  out.push(encodeI(RVM_OP.ADDI, 3, 0, 31));
  out.push(encodeR(RVM_OP.SAR, 2, 1, 3));
  out.push(encodeR(RVM_OP.XOR, 1, 1, 2));
  out.push(encodeR(RVM_OP.SUB, 1, 1, 2));
  emitPush(out, 1);
}

// SGN x:  pop R1; SAR R2, R1, R3=31; if R1==0 push 0 else push (1 OR sign).
function emitSgnInline(out) {
  emitPop(out, 1);
  out.push(encodeI(RVM_OP.ADDI, 3, 0, 31));
  out.push(encodeR(RVM_OP.SAR, 2, 1, 3));        // R2 = -1 si neg, 0 si pos/zero
  out.push(encodeI(RVM_OP.BEQ, 1, 0, 3));         // BEQ R1,R0 → skip 2 (zero case)
  out.push(encodeI(RVM_OP.ADDI, 1, 0, 1));        // R1 = 1
  out.push(encodeR(RVM_OP.OR, 1, 1, 2));          // R1 = 1 | sign (= 1 if pos, -1 if neg)
  emitPush(out, 1);                                // push R1 (zero case skips here, R1 ya = 0)
}

// MIN(a,b) / MAX(a,b): pop b, a; if (cond a vs b) keep a else replace with b.
function emitMinMaxInline(out, isMin) {
  emitPop(out, 2);  // b
  emitPop(out, 1);  // a
  // MIN: si a < b → keep R1 (skip MOV R1=R2). BLT R1, R2, +2.
  // MAX: si a > b → keep R1. Equivale BGE R1+1 ≥ R2 → BLT R2, R1, +2.
  if (isMin) {
    out.push(encodeI(RVM_OP.BLT, 1, 2, 2));   // skip next instr
  } else {
    out.push(encodeI(RVM_OP.BLT, 2, 1, 2));   // si b<a (= a>b), skip next
  }
  out.push(encodeR(RVM_OP.ADD, 1, 0, 2));     // R1 = R2 (else branch)
  emitPush(out, 1);
}

// =====================================================================
// Refactor B.11: SEN/COS via trig LUT en TRIG_LUT_BASE (0x0A700).
// La LUT vive en vmRef.trigLut (Int16Array de 256), accedida con LH a
// 0x0A700 + idx*2. COS = SEN(deg + 90°) = SEN(deg + 64) en idx-space.
// =====================================================================

const TRIG_LUT_BASE = 0x0A700;

function emitTrigLut(out, isCos) {
  emitPop(out, 1);                              // R1 = deg
  if (isCos) {
    out.push(encodeI(RVM_OP.ADDI, 1, 1, 64));    // +90° offset
  }
  out.push(encodeI(RVM_OP.ANDI, 1, 1, 0xFF));    // R1 = idx (0..255). ANDI sign-extiende imm pero 0xFF = 255 cabe.
  out.push(encodeR(RVM_OP.ADD, 1, 1, 1));        // *2 (Int16 = 2 bytes)
  loadImm32(out, 3, TRIG_LUT_BASE);
  out.push(encodeR(RVM_OP.ADD, 1, 1, 3));         // R1 = LUT addr
  out.push(encodeI(RVM_OP.LH, 1, 1, 0));           // sign-extended Int16
  emitPush(out, 1);
}

// =====================================================================
// Refactor B.6-11: peephole de LDI (V2-ARCH-DECISIONS §"Peephole de LDI").
// Si el `op` actual es uno que consume sólo 1 arg desde la stack y ese
// arg vino de un LDI immediate, fusiona con LH/LBU directos a la
// región correspondiente sin tocar el eval stack del v2-A.
//
// Retorna true si la fusión ocurrió. False: el caller debe flush el LDI
// y continuar con la emisión normal.
// =====================================================================

// Offsets de los fields del actor (Int16, 2 bytes c/u). Coinciden con
// src/core/sprites.js: F_X..F_VY.
const ACTOR_FIELD_OFFSET = {
  X:    0,   // F_X
  Y:    2,   // F_Y * 2 bytes
  VX:   4,
  VY:   6,
  FLAGS: 8,
};
const STATE_ACTORS_OFFSET = 0x2080;     // offset dentro de STATE region
const STATE_INPUT_BTN     = 0x2560;     // offset de inputState.buttons[]
const STATE_INPUT_KEYS    = 0x2568;     // offset de inputState.keys[]
const RNG_ADDR            = 0x0B300;

function tryPeepholeLdi(out, op, opdU, ldiValue) {
  switch (op) {
    case OP.BTN: {
      // BTN(b literal): LBU a STATE+0x2560+b.
      // Validar bound 0..7. Si fuera de rango, devolver 0 (igual que MMIO).
      if (ldiValue < 0 || ldiValue >= 8) {
        loadImm32(out, 1, 0);
        emitPush(out, 1);
        return true;
      }
      out.push(encodeI(RVM_OP.LBU, 1, 12, STATE_INPUT_BTN + ldiValue));
      emitPush(out, 1);
      return true;
    }
    case OP.TEC: {
      if (ldiValue < 0 || ldiValue >= 256) {
        loadImm32(out, 1, 0);
        emitPush(out, 1);
        return true;
      }
      out.push(encodeI(RVM_OP.LBU, 1, 12, STATE_INPUT_KEYS + ldiValue));
      emitPush(out, 1);
      return true;
    }
    case OP.X_:    return peepActorField(out, ldiValue, 'X');
    case OP.Y_:    return peepActorField(out, ldiValue, 'Y');
    case OP.VX_:   return peepActorField(out, ldiValue, 'VX');
    case OP.VY_:   return peepActorField(out, ldiValue, 'VY');
    case OP.VIS:   return peepActorVis(out, ldiValue);
    case OP.ALE:   return peepAle(out, ldiValue);
    default:
      return false;
  }
}

function peepActorField(out, n, field) {
  // n debe ser 0..31 (ACTOR_COUNT). Imm16 max es ±32767. STATE_ACTORS +
  // n*32 + field_off cabe en imm16 para n<32.
  if (n < 0 || n >= 32) return false;
  const off = STATE_ACTORS_OFFSET + n * 32 + ACTOR_FIELD_OFFSET[field];
  out.push(encodeI(RVM_OP.LH, 1, 12, off));   // signed Int16 read
  emitPush(out, 1);
  return true;
}

function peepActorVis(out, n) {
  // VIS(n): (flags & FLAG_HIDDEN) ? 0 : 1. FLAG_HIDDEN = 1.
  // Leemos F_FLAGS Int16, AND con 1, XOR con 1 → 1 si visible, 0 si hidden.
  if (n < 0 || n >= 32) return false;
  const off = STATE_ACTORS_OFFSET + n * 32 + ACTOR_FIELD_OFFSET.FLAGS;
  out.push(encodeI(RVM_OP.LHU, 1, 12, off));
  out.push(encodeI(RVM_OP.ANDI, 1, 1, 1));
  out.push(encodeI(RVM_OP.XORI, 1, 1, 1));
  emitPush(out, 1);
  return true;
}

// =====================================================================
// Refactor C.12: análisis CFG para CALL/RET callee-saves-link.
//
// Funciones = LLA-targets ∪ handlers. Para cada entry, walk forward DFS:
//   - RET/HALT: terminar.
//   - CALL: marcar la función como non-leaf, continuar.
//   - JMP/JZ/JNZ: explorar el target + el siguiente.
//
// Una función es non-leaf si su walk encuentra algún CALL (LLA).
// Las funciones non-leaf emiten prologue (ADDI R14,-4; SW R15,R14,0) en
// el entry y epilogue (LW R15; ADDI R14,+4; JR R15) en cada RET reachable.
// Las leaf emiten sólo JR R15 en RET, sin prologue.
//
// Handlers se tratan igual: si llaman, son non-leaf y necesitan
// prologue/epilogue. R15 al entry de handlers viene del JS (sentinel
// HLT addr); el prologue lo guarda en stack para que sobreviva CALLs.
// =====================================================================

function analyzeFunctions(v2aCode, v2aLen, handlers) {
  const entries = new Set();
  // Handlers como entries.
  for (const v of Object.values(handlers)) {
    if (typeof v === 'number') entries.add(v);
    else if (Array.isArray(v)) {
      for (const p of v) if (typeof p === 'number') entries.add(p);
    }
  }
  // LLA targets como entries.
  for (let i = 0; i < v2aLen; i++) {
    const w = v2aCode[i] >>> 0;
    if ((w & 0xff) === OP.CALL) {
      entries.add((w >>> 8) & 0xFFFFFF);
    }
  }

  const isNonLeafEntry = new Set();
  const retIsNonLeaf = new Set();
  const fnByPc = new Map();   // pc → entry de la función que lo contiene
  for (const entry of entries) {
    const visited = new Set();
    const queue = [entry];
    let nonLeaf = false;
    const rets = [];
    while (queue.length) {
      const pc = queue.shift();
      if (visited.has(pc) || pc < 0 || pc >= v2aLen) continue;
      if (pc !== entry && entries.has(pc)) continue;
      visited.add(pc);
      // El primer entry que visita pc se queda con él. Subsiguientes
      // walks (de otras funciones) no sobreescriben.
      if (!fnByPc.has(pc)) fnByPc.set(pc, entry);
      const w = v2aCode[pc] >>> 0;
      const op = w & 0xff;
      const opd = (w >>> 8) & 0xFFFFFF;
      if (op === OP.RET || op === OP.HALT) { rets.push(pc); continue; }
      if (op === OP.CALL) { nonLeaf = true; queue.push(pc + 1); continue; }
      if (op === OP.JMP) { queue.push(opd); continue; }
      if (op === OP.JZ || op === OP.JNZ) {
        queue.push(opd);
        queue.push(pc + 1);
        continue;
      }
      if (op === OP.PARSIG) {
        queue.push(pc + 1);
        continue;
      }
      queue.push(pc + 1);
    }
    if (nonLeaf) {
      isNonLeafEntry.add(entry);
      for (const ret of rets) retIsNonLeaf.add(ret);
    }
  }
  return { isNonLeafEntry, retIsNonLeaf, allEntries: entries, fnByPc };
}

function peepAle(out, n) {
  // ALE(n_literal): LW $RNG → REMU n. v2-A usa nextRandom(state) % n
  // donde nextRandom devuelve unsigned 32-bit. RVM-32 REMU replica.
  if (n <= 0) {
    loadImm32(out, 1, 0);
    emitPush(out, 1);
    return true;
  }
  loadImm32(out, 3, RNG_ADDR);
  out.push(encodeI(RVM_OP.LW, 1, 3, 0));        // R1 = next xorshift32 (signed Int32)
  loadImm32(out, 2, n);
  out.push(encodeR(RVM_OP.REMU, 1, 1, 2));      // R1 = (R1 unsigned) % n
  emitPush(out, 1);
  return true;
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

  // Refactor C.12: análisis CFG para CALL/RET callee-saves-link.
  // Identificamos las funciones (LLA targets + handlers) y para cada una
  // determinamos si es non-leaf (contiene al menos un LLA en su body).
  // Funciones non-leaf emiten prologue al entry y epilogue en cada RET.
  const { isNonLeafEntry, retIsNonLeaf, allEntries, fnByPc } = analyzeFunctions(
    v2aCode, v2aLen, v2aProgram.handlers,
  );

  // Refactor B.6: defer LDI peephole (V2-ARCH-DECISIONS §"Peephole de LDI").
  // pendingLdi !== null indica que la última instrucción v2-A fue LDI y
  // su push se difirió, esperando ver si la próxima es fusable.
  let pendingLdi = null;

  function flushPendingLdi() {
    if (pendingLdi !== null) {
      loadImm32(out, 1, pendingLdi.value);
      emitPush(out, 1);
      pendingLdi = null;
    }
  }

  for (let i = 0; i < v2aLen; i++) {
    const word = v2aCode[i] >>> 0;
    const op = word & 0xff;
    const opd = word >> 8;          // signed 24-bit
    const opdU = (word >>> 8) & 0xFFFFFF;

    // LDI: defer push, registrar el v2aPc. Si i es entry non-leaf,
    // emitir el prologue. v2aToRvmPc[i] apunta al PROLOGUE (no a after)
    // para que CALLs aterricen en el save.
    if (op === OP.LDI) {
      flushPendingLdi();
      v2aToRvmPc.set(i, out.length * 4);
      if (isNonLeafEntry.has(i)) {
        out.push(encodeI(RVM_OP.ADDI, 14, 14, -4));
        out.push(encodeI(RVM_OP.SW, 15, 14, 0));
      }
      pendingLdi = { value: opd, v2aPc: i };
      continue;
    }

    // Si hay LDI deferido, intentar peephole con el opcode actual.
    if (pendingLdi !== null) {
      const peephRvmPc = out.length * 4;
      if (tryPeepholeLdi(out, op, opdU, pendingLdi.value)) {
        // NO sobreescribimos v2aToRvmPc[pendingLdi.v2aPc]: si la LDI era
        // un function entry, ya apunta al prologue. JAL al entry pasa
        // por el prologue y cae naturalmente al fused emit.
        v2aToRvmPc.set(i, peephRvmPc);
        pendingLdi = null;
        continue;
      }
      flushPendingLdi();
    }

    const startInstrIdx = out.length;
    v2aToRvmPc.set(i, startInstrIdx * 4);

    // Refactor C.12: prologue de funciones non-leaf.
    if (isNonLeafEntry.has(i)) {
      out.push(encodeI(RVM_OP.ADDI, 14, 14, -4));
      out.push(encodeI(RVM_OP.SW, 15, 14, 0));
    }

    switch (op) {
      case OP.NOP:
        out.push(encodeR(RVM_OP.NOP, 0, 0, 0));
        break;
      case OP.HALT:
        out.push(encodeR(RVM_OP.HLT, 0, 0, 0));
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
      case OP.MULV: {
        emitPop(out, 1);
        out.push(encodeI(RVM_OP.LW, 2, 12, opdU * 4));
        const aluOp = op === OP.ADDV ? RVM_OP.ADD :
                      op === OP.SUBV ? RVM_OP.SUB :
                                        RVM_OP.MUL;
        out.push(encodeR(aluOp, 2, 2, 1));
        out.push(encodeI(RVM_OP.SW, 2, 12, opdU * 4));
        break;
      }
      case OP.DIVV: {
        // Refactor A.5: opcode nativo DIV.
        emitPop(out, 2);                                  // divisor
        out.push(encodeI(RVM_OP.LW, 1, 12, opdU * 4));    // R1 = vars[r]
        out.push(encodeR(RVM_OP.DIV, 1, 1, 2));
        out.push(encodeI(RVM_OP.SW, 1, 12, opdU * 4));
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
      case OP.OR: {
        emitPop(out, 2);
        emitPop(out, 1);
        const aluOp = op === OP.ADD ? RVM_OP.ADD :
                      op === OP.SUB ? RVM_OP.SUB :
                      op === OP.MUL ? RVM_OP.MUL :
                      op === OP.AND ? RVM_OP.AND :
                                       RVM_OP.OR;
        out.push(encodeR(aluOp, 1, 1, 2));
        emitPush(out, 1);
        break;
      }
      case OP.DIV:
      case OP.MOD: {
        // Refactor A.5: opcodes nativos DIV/REM (V2-ARCH §2).
        emitPop(out, 2);  // b
        emitPop(out, 1);  // a
        out.push(encodeR(op === OP.DIV ? RVM_OP.DIV : RVM_OP.REM, 1, 1, 2));
        emitPush(out, 1);
        break;
      }
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
        if (op === OP.JZ || op === OP.JNZ) {
          emitPop(out, 1);
          const brOp = op === OP.JZ ? RVM_OP.BEQ : RVM_OP.BNE;
          patches.push({ rvmInstrIdx: out.length, v2aTargetWordIdx: opdU, kind: 'branch', op: brOp });
          out.push(encodeI(brOp, 1, 0, 0));
        } else {
          patches.push({ rvmInstrIdx: out.length, v2aTargetWordIdx: opdU, kind: 'jmp' });
          out.push(encodeJ(RVM_OP.JMP, 0, 0));
        }
        break;
      }
      case OP.CALL: {
        // Refactor C.12: callee-saves-link. CALL = JAL R15, target.
        patches.push({ rvmInstrIdx: out.length, v2aTargetWordIdx: opdU, kind: 'jal' });
        out.push(encodeJ(RVM_OP.JAL, 15, 0));
        // Si la próxima instrucción v2-A es entrada de otra función
        // (fall-through entre handlers), emitir un RET sintético acá
        // para cerrar la función actual y evitar que su epilogue se
        // ejecute dentro del siguiente function entry.
        if (i + 1 < v2aLen && allEntries.has(i + 1)) {
          const myFn = fnByPc.get(i);
          if (myFn !== undefined && isNonLeafEntry.has(myFn)) {
            out.push(encodeI(RVM_OP.LW, 15, 14, 0));
            out.push(encodeI(RVM_OP.ADDI, 14, 14, 4));
          }
          out.push(encodeR(RVM_OP.JR, 0, 15, 0));
        }
        break;
      }
      case OP.RET:
        // En non-leaf: epilogue (LW R15; ADDI R14, +4; JR R15).
        // En leaf/handler: sólo JR R15.
        if (retIsNonLeaf.has(i)) {
          out.push(encodeI(RVM_OP.LW, 15, 14, 0));
          out.push(encodeI(RVM_OP.ADDI, 14, 14, 4));
        }
        out.push(encodeR(RVM_OP.JR, 0, 15, 0));
        break;

      // -------------------- PAR / SIG -----------------------------
      case OP.PARINIT: {
        // pop end → R2
        emitPop(out, 2);
        // ADDI R6, R6, -16 ; ADDI R1, R0, var_idx ; SW R1, R6, 0
        // SW R2, R6, 4 ; JAL R3, 1 ; ADDI R3, R3, 8 ; SW R3, R6, 8
        out.push(encodeI(RVM_OP.ADDI, 6, 6, -16));
        loadImm32(out, 1, opdU);                   // var_idx (4-bit, sm)
        out.push(encodeI(RVM_OP.SW, 1, 6, 0));
        out.push(encodeI(RVM_OP.SW, 2, 6, 4));
        out.push(encodeJ(RVM_OP.JAL, 3, 1));        // R3 = pc+4 (next instr)
        out.push(encodeI(RVM_OP.ADDI, 3, 3, 8));    // R3 = pc+12 (body)
        out.push(encodeI(RVM_OP.SW, 3, 6, 8));      // frame[2] = body_pc
        break;
      }
      case OP.PARSIG: {
        out.push(encodeI(RVM_OP.LW, 1, 6, 0));      // var_idx
        out.push(encodeI(RVM_OP.LW, 2, 6, 4));      // end
        out.push(encodeI(RVM_OP.LW, 3, 6, 8));      // body_pc
        // address de var: R1 = R12 + var_idx*4
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));     // *2
        out.push(encodeR(RVM_OP.ADD, 1, 1, 1));     // *4
        out.push(encodeR(RVM_OP.ADD, 1, 12, 1));    // R1 = vars + var_idx*4
        out.push(encodeI(RVM_OP.LW, 4, 1, 0));      // R4 = var
        out.push(encodeI(RVM_OP.ADDI, 4, 4, 1));    // var++
        out.push(encodeI(RVM_OP.SW, 4, 1, 0));      // store
        // si end < new_var → exit (skip JR)
        out.push(encodeI(RVM_OP.BLT, 2, 4, 2));      // BLT end, var, +2 → skip JR
        out.push(encodeR(RVM_OP.JR, 0, 3, 0));       // JR R3 (back to body)
        out.push(encodeI(RVM_OP.ADDI, 6, 6, 16));    // pop frame
        break;
      }

      // -------------------- memoria absoluta ----------------------
      case OP.LDM:
      case OP.LDW: {
        emitPop(out, 1);                           // addr
        const ldOp = op === OP.LDM ? RVM_OP.LBU : RVM_OP.LW;
        out.push(encodeI(ldOp, 1, 1, 0));
        emitPush(out, 1);
        break;
      }
      case OP.STM:
      case OP.STW: {
        emitPop(out, 1);                           // val
        emitPop(out, 2);                           // addr
        const stOp = op === OP.STM ? RVM_OP.SB : RVM_OP.SW;
        out.push(encodeI(stOp, 1, 2, 0));
        break;
      }
      case OP.LDR: {
        // pop offset, slot, region → ARG2, ARG1, ARG0
        emitPop(out, 1);                           // offset
        emitMmioStoreArg(out, 2, 1);
        emitPop(out, 1);                           // slot
        emitMmioStoreArg(out, 1, 1);
        emitPop(out, 1);                           // region
        emitMmioStoreArg(out, 0, 1);
        emitMmioCmd(out, CMD_LDR);
        emitMmioLoadResult(out, 1);
        emitPush(out, 1);
        break;
      }
      case OP.STR: {
        emitPop(out, 1);  emitMmioStoreArg(out, 3, 1);  // val
        emitPop(out, 1);  emitMmioStoreArg(out, 2, 1);  // offset
        emitPop(out, 1);  emitMmioStoreArg(out, 1, 1);  // slot
        emitPop(out, 1);  emitMmioStoreArg(out, 0, 1);  // region
        emitMmioCmd(out, CMD_STR);
        break;
      }
      case OP.MEMCPY: {
        emitPop(out, 1);  emitMmioStoreArg(out, 2, 1);  // n
        emitPop(out, 1);  emitMmioStoreArg(out, 1, 1);  // dst
        emitPop(out, 1);  emitMmioStoreArg(out, 0, 1);  // src
        emitMmioCmd(out, CMD_MEMCPY);
        break;
      }
      case OP.MEMSET: {
        emitPop(out, 1);  emitMmioStoreArg(out, 2, 1);  // n
        emitPop(out, 1);  emitMmioStoreArg(out, 1, 1);  // val
        emitPop(out, 1);  emitMmioStoreArg(out, 0, 1);  // dst
        emitMmioCmd(out, CMD_MEMSET);
        break;
      }

      // -------------------- builtins (statements) -----------------
      case OP.BOR:    emitMmioStmt(out, 1, CMD.BOR); break;
      case OP.PIN:    emitMmioStmt(out, 3, CMD.PIN); break;
      case OP.REC:    emitMmioStmt(out, 5, CMD.REC); break;
      case OP.SPR:    emitMmioStmt(out, 4, CMD.SPR); break;
      case OP.SPRR:   emitMmioStmt(out, 5, CMD.SPRR); break;
      case OP.SPRA:   emitMmioStmt(out, 4, CMD.SPRA); break;
      case OP.MOV:    emitMmioStmt(out, 3, CMD.MOV); break;
      case OP.VEL:    emitMmioStmt(out, 3, CMD.VEL); break;
      case OP.ANI:    emitMmioStmt(out, 4, CMD.ANI); break;
      case OP.OCU:    emitMmioStmt(out, 2, CMD.OCU); break;
      case OP.INV:    emitMmioStmtImmAxis(out, opdU); break;  // INV usa operand para axis
      case OP.PAT:    emitMmioStmt(out, 2, CMD.PAT); break;
      case OP.MAP_:   emitMmioStmt(out, 3, CMD.MAP_); break;
      case OP.FON:    emitMmioStmt(out, 1, CMD.FON); break;
      case OP.SOL: {
        // Variable arity = opdU. Args: ARG0 = mapIdx, ARG1 = count, ARG2..n tiles.
        const arity = opdU;
        // Pop arity-1 tiles + 1 mapIdx total (= arity).
        // Stack order (last pushed = top): tiles[N-1], ..., tiles[0], map.
        // Pop into ARG2+(N-1), ..., ARG2, then map → ARG0.
        const tileCount = arity - 1;
        if (tileCount > 6) throw new Error('SOL: max 6 tiles soportadas en RVM-32 v1');
        for (let i = tileCount - 1; i >= 0; i--) {
          emitPop(out, 1);
          emitMmioStoreArg(out, 2 + i, 1);
        }
        emitPop(out, 1);  emitMmioStoreArg(out, 0, 1);  // map
        // Set ARG1 = tileCount
        loadImm32(out, 1, tileCount);
        emitMmioStoreArg(out, 1, 1);
        emitMmioCmd(out, CMD.SOL);
        break;
      }
      case OP.GRA:    emitMmioStmt(out, 3, CMD.GRA); break;
      case OP.SAL:    emitMmioStmt(out, 2, CMD.SAL); break;
      case OP.LIM:    emitMmioStmt(out, 5, CMD.LIM); break;
      case OP.SON:    emitMmioStmt(out, 2, CMD.SON); break;
      case OP.RUI:    emitMmioStmt(out, 1, CMD.RUI); break;
      case OP.SIL:    emitMmioStmt(out, 1, CMD.SIL); break;
      case OP.CARNIV: emitMmioStmt(out, 1, CMD.CARNIV); break;
      case OP.PAL:    emitMmioStmt(out, 1, CMD.PAL);    break;

      // -------------------- queries (push result) -----------------
      case OP.X_:    emitMmioQuery(out, 1, CMD.Q_X); break;
      case OP.Y_:    emitMmioQuery(out, 1, CMD.Q_Y); break;
      case OP.VX_:   emitMmioQuery(out, 1, CMD.Q_VX); break;
      case OP.VY_:   emitMmioQuery(out, 1, CMD.Q_VY); break;
      case OP.VIS:   emitMmioQuery(out, 1, CMD.Q_VIS); break;
      case OP.COL:   emitMmioQuery(out, 2, CMD.Q_COL); break;
      case OP.DIS:   emitMmioQuery(out, 2, CMD.Q_DIS); break;
      case OP.TIL:   emitMmioQuery(out, 3, CMD.Q_TIL); break;
      case OP.COLM:  emitMmioQuery(out, 2, CMD.Q_COLM); break;
      case OP.PIE:   emitMmioQuery(out, 1, CMD.Q_PIE); break;
      case OP.BTN:   emitMmioQuery(out, 1, CMD.Q_BTN); break;
      case OP.TEC:   emitMmioQuery(out, 1, CMD.Q_TEC); break;
      case OP.ALE:   emitMmioQuery(out, 1, CMD.Q_ALE); break;
      case OP.ABS_F: emitAbsInline(out); break;
      case OP.SGN:   emitSgnInline(out); break;
      case OP.RAI:   emitMmioQuery(out, 1, CMD.Q_RAI); break;
      case OP.SEN:   emitTrigLut(out, false); break;
      case OP.COS:   emitTrigLut(out, true); break;
      case OP.MIN:   emitMinMaxInline(out, true); break;
      case OP.MAX:   emitMinMaxInline(out, false); break;

      // -------------------- LDC, TXT — futuro -----------------------
      case OP.LDC:
        // Constants pool index — usado para strings (TXT). Para v1
        // empujamos sólo el índice como int; TXT abajo usa el ARG2.
        loadImm32(out, 1, opdU);
        emitPush(out, 1);
        break;
      case OP.TXT:
        // ARG0..3 = x, y, strIdx, color. Stack tiene 4 valores ya.
        emitMmioStmt(out, 4, CMD.TXT);
        break;

      default:
        // Opcode no soportado en v1: emitimos un NOP+marker para que el
        // binario corra sin crash; los tests evitan estos opcodes.
        out.push(encodeR(RVM_OP.NOP, 0, 0, 0));
        break;
    }
  }
  // Flush LDI deferido al fin del programa (no debería pasar pero por las dudas).
  flushPendingLdi();
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
      out[p.rvmInstrIdx] = encodeI(p.op, 1, 0, offsetWords);
    } else if (p.kind === 'jal') {
      out[p.rvmInstrIdx] = encodeJ(RVM_OP.JAL, 15, offsetWords);
    } else {
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
    // Pool de constantes (strings de TXT). El runner debe setear
    // vmRef.rvmConstants = transpiledResult.constants antes de runRVM32.
    constants: v2aProgram.constants || [],
  };
}
