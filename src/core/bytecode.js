// Bytecode de RollitoVM (docs/PLAN.md §18.1).
//
// Encoding: 32 bits por instrucción. Opcode en el byte bajo, 24 bits de
// operando. La VM ejecuta vía interpreter (runFromBytecode); el compilador
// emite directamente sobre `vmRef.codeMem`.
//
//   31                                          8 7         0
//  +--------------------------------------------+-----------+
//  |                  operand (24 bits)         |  opcode   |
//  +--------------------------------------------+-----------+
//
// Stack de evaluación: state.evalStack (Int32Array). Push/pop por
// expresión y por args de builtins. Los stacks de loop (PAR/SIG) y
// call (LLA/RET) son los que ya existían en `state`.

import { ARRAY_SIZE, LOOP_FRAME_SIZE } from './memory.js';

// =====================================================================
// Opcodes — el byte bajo de cada word.
// =====================================================================

export const OP = Object.freeze({
  NOP:     0x00,
  HALT:    0x01,
  PAUSE:   0x02,

  // Constantes y variables.
  LDI:     0x10,  // operand = signed 24-bit literal
  LDC:     0x11,  // operand = índice en pool de constantes (string/big int)
  LDV:     0x12,  // operand = índice de variable (0..31)
  STV:     0x13,  // pop → vars[operand]
  ADDV:    0x14,  // pop → vars[operand] += val   (compound assign)
  SUBV:    0x15,
  MULV:    0x16,
  DIVV:    0x17,
  LDA:     0x18,  // operand = índice de Mn (0..7); pop idx; push Mn[idx]
  STA:     0x19,  // pop val; pop idx; Mn[idx] = val
  ADDA:    0x1A,
  SUBA:    0x1B,
  MULA:    0x1C,
  DIVA:    0x1D,

  // Aritmética y lógica (sin operand; pop 1 o 2, push resultado).
  ADD:     0x20,
  SUB:     0x21,
  MUL:     0x22,
  DIV:     0x23,
  MOD:     0x24,
  NEG:     0x25,
  LT:      0x26,
  LE:      0x27,
  GT:      0x28,
  GE:      0x29,
  EQ:      0x2A,
  NE:      0x2B,
  AND:     0x2C,
  OR:      0x2D,
  NOT:     0x2E,

  // Control de flujo (operand = bytecode pc absoluto, salvo RET/HALT).
  JMP:     0x30,
  JZ:      0x31,
  JNZ:     0x32,
  CALL:    0x33,
  RET:     0x34,
  PARINIT: 0x35,  // operand = var idx; pop end; push frame (var, end, bodyPc=pc+1)
  PARSIG:  0x36,  // operand = body pc (absoluto)

  // Memoria.
  LDM:     0x40,  // pop addr; push readByte(addr)
  STM:     0x41,  // pop val, addr; writeByte(addr, val)
  LDW:     0x42,
  STW:     0x43,
  LDR:     0x44,  // pop offset, slot, region; push readByteIndexed(...)
  STR:     0x45,  // pop val, offset, slot, region
  MEMCPY:  0x46,  // pop n, dst, src
  MEMSET:  0x47,  // pop n, val, dst

  // Dibujo (operand = arity en algunos).
  BOR:     0x50,
  PIN:     0x51,
  REC:     0x52,
  TXT:     0x53,  // operand = arity (3 o 4); el string llega como índice de pool en el stack

  // Sprites.
  SPR:     0x60,  // operand = arity (3 o 4)
  SPRR:    0x67,  // SPRR n,x,y,ang,esc — rotación + escala (5 args, nearest neighbor)
  SPRA:    0x68,  // SPRA n,x,y,a — alpha blend via tabla de mezcla (4 args)
  MOV:     0x61,
  VEL:     0x62,
  ANI:     0x63,
  OCU:     0x64,
  INV:     0x65,  // operand = 0 (X) o 1 (Y) — eje literal
  PAT:     0x66,

  // Mapas y físicas.
  MAP_:    0x70,  // MAP es keyword en el lenguaje; el opcode interno se llama MAP_
  FON:     0x71,
  SOL:     0x72,  // operand = arity (>= 2)
  GRA:     0x73,
  SAL:     0x74,
  LIM:     0x75,

  // Audio.
  SON:     0x80,
  RUI:     0x81,
  SIL:     0x82,

  // Lifecycle / display.
  CARNIV:  0x90,
  PAL:     0x91,  // PAL n — set active palette bank (REFERENCIA §8)

  // Funciones de consulta (push resultado).
  COL:     0xA0,
  X_:      0xA1,
  Y_:      0xA2,
  VX_:     0xA3,
  VY_:     0xA4,
  VIS:     0xA5,
  DIS:     0xA6,
  TIL:     0xA7,
  COLM:    0xA8,
  PIE:     0xA9,
  BTN:     0xAA,
  TEC:     0xAB,
  ALE:     0xAC,
  ABS_F:   0xAD,
  SGN:     0xAE,
  MIN:     0xAF,
  MAX:     0xB0,
  RAI:     0xB1,
  SEN:     0xB2,
  COS:     0xB3,
});

// =====================================================================
// Helpers de encoding/decoding.
// =====================================================================

// Empaqueta opcode + operand en un word de 32 bits. operand puede ser
// negativo (signed 24-bit); la decodificación con SAR maneja el signo.
export function encode(opcode, operand = 0) {
  return ((operand & 0xFFFFFF) << 8 | (opcode & 0xFF)) | 0;
}

export function decodeOpcode(word) {
  return word & 0xFF;
}

// Operand signed 24-bit: shift left 8 (mete bits 24..31 al MSB) y
// shift right aritmético 8 para extender el signo.
export function decodeOperand(word) {
  return (word >> 8);
}

// Operand unsigned 24-bit (para PCs absolutos, índices, etc.).
export function decodeOperandU(word) {
  return (word >>> 8) & 0xFFFFFF;
}

// =====================================================================
// Stack de evaluación. Inicializado por createState() en memory.js;
// ver evalStack/evalSp ahí.
// =====================================================================

export const EVAL_STACK_DEPTH = 256;

// =====================================================================
// Tabla inversa de nombres (debug / disassembly).
// =====================================================================

export const OP_NAME = (() => {
  const out = Object.create(null);
  for (const [name, code] of Object.entries(OP)) out[code] = name;
  return out;
})();

// Disassemble una instrucción para inspección humana.
export function disasm(word, pc = 0) {
  const op = decodeOpcode(word);
  const opd = decodeOperand(word);
  const name = OP_NAME[op] || `??0x${op.toString(16)}`;
  return `${pc.toString().padStart(4, ' ')}: ${name.padEnd(8, ' ')} ${opd}`;
}

// Re-export para que el interpreter lea constantes sin import circular.
export { ARRAY_SIZE, LOOP_FRAME_SIZE };
