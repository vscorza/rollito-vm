// RVM-32 ISA — RISC interno de RollitoVM (docs/RVM32-ISA.md, PLAN §19).
//
// 32 bits fijos por instrucción. Opcode = byte bajo (mismo convenio que
// el bytecode v2-A actual; facilita debug y reusa lectores existentes).
// 16 registros R0..R15: R0=zero, R15=link (JAL), R14=SP por convención.
//
// 3 formatos:
//
//  R-type (3 registros, ALU):
//   31              28 27   24 23   20 19           8 7      0
//   |   func (12)    | rs2 (4)| rs1 (4)| rd (4)      |  op (8)
//
//  I-type (registro + inmediato 16-bit):
//   31              16 15            8 7      0      ... err — re-encode:
//
// Layout final (todos):
//   bits  0..7  : opcode (8 bits)
//   bits  8..11 : rd     (4 bits)
//   bits 12..15 : rs1    (4 bits)  (R-type: rs1; I-type: rs1; J-type: -)
//   bits 16..19 : rs2    (4 bits)  (sólo R-type)
//   bits 16..31 : imm16  (16-bit signed) en I-type — solapa con rs2+func
//   bits 12..31 : imm20  (20-bit signed PC-rel) en J-type — solapa
//                  con rd; en J el rd ocupa bits 8..11 (no 12..15).
//   bits 20..31 : func12 (12 bits) en R-type
//
// Hay 3 codificaciones distintas por la posición de los campos:
//   encodeR(op, rd, rs1, rs2, func)  → R-type
//   encodeI(op, rd, rs1, imm16)      → I-type
//   encodeJ(op, rd, imm20)           → J-type (rd usado por JAL; otros 0)
//
// Decoder devuelve { op, rd, rs1, rs2, func, imm16, imm20 } — quien
// llama elige el campo según el opcode.

export const RVM_OP = Object.freeze({
  // -------------------- memoria ---------------------------------
  LB:   0x10,  // I: rd ← sext(mem8[rs1+imm16])
  LBU:  0x11,  // I: rd ← zext(mem8[rs1+imm16])
  LW:   0x12,  // I: rd ← mem32[rs1+imm16]
  SB:   0x13,  // I: mem8[rs1+imm16] ← rd[7:0]
  SW:   0x14,  // I: mem32[rs1+imm16] ← rd

  // -------------------- ALU R-type (rd ← rs1 op rs2) -------------
  ADD:  0x20,
  SUB:  0x21,
  AND:  0x22,
  OR:   0x23,
  XOR:  0x24,
  SHL:  0x25,
  SHR:  0x26,  // logical right shift
  SAR:  0x27,  // arithmetic right shift
  MUL:  0x28,  // 32x32 → low 32 bits
  // -------------------- ALU I-type (rd ← rs1 op imm16) -----------
  ADDI: 0x30,
  ANDI: 0x31,
  ORI:  0x32,
  XORI: 0x33,
  LUI:  0x34,  // rd ← imm16 << 16 (rs1 ignorado)

  // -------------------- branches I-type (off = imm16) ------------
  BEQ:  0x40,
  BNE:  0x41,
  BLT:  0x42,
  BGE:  0x43,

  // -------------------- jumps J-type (off = imm20) ---------------
  JMP:  0x50,
  JAL:  0x51,  // rd ← PC+4; PC += imm20*4
  JR:   0x52,  // R-type: PC ← rs1

  // -------------------- misc -------------------------------------
  NOP:  0x00,
  HLT:  0x01,
});

export const RVM_OP_NAME = (() => {
  const out = Object.create(null);
  for (const [name, code] of Object.entries(RVM_OP)) out[code] = name;
  return out;
})();

// =====================================================================
// Encoding helpers.
// =====================================================================

function clip(value, bits) {
  const mask = ((1 << bits) - 1) >>> 0;
  return value & mask;
}

export function encodeR(op, rd, rs1, rs2, func = 0) {
  return (
    (op & 0xff) |
    ((rd  & 0x0f) << 8) |
    ((rs1 & 0x0f) << 12) |
    ((rs2 & 0x0f) << 16) |
    ((func & 0xfff) << 20)
  ) | 0;
}

export function encodeI(op, rd, rs1, imm16) {
  const imm = clip(imm16, 16);
  return (
    (op & 0xff) |
    ((rd  & 0x0f) << 8) |
    ((rs1 & 0x0f) << 12) |
    (imm << 16)
  ) | 0;
}

export function encodeJ(op, rd, imm20) {
  // rd en bits 8..11; imm20 (signed) en bits 12..31.
  const imm = clip(imm20, 20);
  return (
    (op & 0xff) |
    ((rd & 0x0f) << 8) |
    (imm << 12)
  ) | 0;
}

// =====================================================================
// Decoding: devuelve todos los campos posibles. Quien llama elige.
// =====================================================================

export function decode(word) {
  const w = word >>> 0;
  const op = w & 0xff;
  const rd = (w >>> 8) & 0x0f;
  const rs1 = (w >>> 12) & 0x0f;
  const rs2 = (w >>> 16) & 0x0f;
  const func = (w >>> 20) & 0xfff;
  // imm16: bits 16..31, signed.
  const imm16Raw = (w >>> 16) & 0xffff;
  const imm16 = (imm16Raw << 16) >> 16;
  // imm20: bits 12..31, signed.
  const imm20Raw = (w >>> 12) & 0xfffff;
  const imm20 = (imm20Raw << 12) >> 12;
  return { op, rd, rs1, rs2, func, imm16, imm20 };
}

// =====================================================================
// Disassembly (debug).
// =====================================================================

const FORMAT = (() => {
  const f = Object.create(null);
  // R-type
  for (const k of ['ADD','SUB','AND','OR','XOR','SHL','SHR','SAR','MUL','JR']) {
    f[RVM_OP[k]] = 'R';
  }
  // I-type (memoria + ALU-I + branches)
  for (const k of ['LB','LBU','LW','SB','SW',
                   'ADDI','ANDI','ORI','XORI','LUI',
                   'BEQ','BNE','BLT','BGE']) {
    f[RVM_OP[k]] = 'I';
  }
  // J-type
  for (const k of ['JMP','JAL']) f[RVM_OP[k]] = 'J';
  // Misc
  f[RVM_OP.NOP] = 'N';
  f[RVM_OP.HLT] = 'N';
  return f;
})();

export function disasm(word, pc = 0) {
  const d = decode(word);
  const name = (RVM_OP_NAME[d.op] || `??0x${d.op.toString(16)}`).padEnd(4, ' ');
  const fmt = FORMAT[d.op] || 'N';
  const pcStr = pc.toString(16).padStart(4, '0');
  switch (fmt) {
    case 'R':
      if (d.op === RVM_OP.JR) return `${pcStr}: ${name} R${d.rs1}`;
      return `${pcStr}: ${name} R${d.rd},R${d.rs1},R${d.rs2}`;
    case 'I':
      if (d.op === RVM_OP.LUI) return `${pcStr}: ${name} R${d.rd},${d.imm16}`;
      return `${pcStr}: ${name} R${d.rd},R${d.rs1},${d.imm16}`;
    case 'J':
      if (d.op === RVM_OP.JAL) return `${pcStr}: ${name} R${d.rd},${d.imm20}`;
      return `${pcStr}: ${name} ${d.imm20}`;
    default:
      return `${pcStr}: ${name}`;
  }
}

export function getFormat(op) {
  return FORMAT[op] || 'N';
}
