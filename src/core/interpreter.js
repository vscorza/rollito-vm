// Interpreter de bytecode (docs/PLAN.md §18, v2-A).
//
// Ejecuta un Uint32Array (vista sobre vmRef.codeMem) con dispatch por
// opcode. El loop `runFromBytecode` corre hasta HALT, RET con stack
// vacío, o run-off-the-end.
//
// Stacks (en `state`):
//   evalStack/evalSp — operands de expresiones y args de builtins
//   loopStack/loopSp — frames de PAR/SIG (var, end, bodyBcPc, _pad)
//   callStack/callSp — return PCs de LLA/RET (PCs absolutos del bytecode)
//
// Performance: §11.1 dice "closures + JIT-friendly"; v2-A rompe ese
// budget a cambio de un modelo de hardware ficticio más fiel.

import { OP } from './bytecode.js';
import {
  ARRAY_SIZE, LOOP_FRAME_SIZE, VAR_INDEX,
  readByte, writeByte, readWord, writeWord,
  readByteIndexed, writeByteIndexed, memCopy, memSet,
  nextRandom,
} from './memory.js';
import {
  ACTOR_FIELDS,
  F_X, F_Y, F_VX, F_VY, F_FLAGS, F_ANI_A, F_ANI_B, F_ANI_STATE,
  F_PHYS_MAP, F_PHYS_GRA, F_LIM_X1, F_LIM_Y1, F_LIM_X2, F_LIM_Y2,
  FLAG_HIDDEN, FLAG_ON_GROUND, FLAG_LIM_ACTIVE,
  drawPattern, aabbCollide, actorDistance,
} from './sprites.js';
import {
  setSolid, blitMap, readTile, setActiveBackground,
  actorCollidesMap, actorOnGround,
} from './maps.js';
import { drawText } from '../builtins/text.js';
import { DRAW_BUILTINS } from '../builtins/draw.js';
import { playSound, playNoise, silenceChannel } from '../audio/synth.js';

// =====================================================================
// runFromBytecode — entrypoint para handlers (CUADRO, INICIONIVEL, etc.).
//
// startPc es un bytecode PC absoluto (typo idx en la vieja API era un
// índice de línea; ahora es un offset directo en `code`).
// =====================================================================

const BUDGET = 1_000_000;

export function runFromBytecode(state, vmRef, code, constants, startPc) {
  state.callSp = 0;
  state.loopSp = 0;
  state.evalSp = 0;
  let pc = startPc | 0;
  const len = code.length;
  let budget = BUDGET;
  const stack = state.evalStack;

  while (pc >= 0 && pc < len) {
    if (--budget <= 0) {
      throw new Error('handler excedió presupuesto de instrucciones por cuadro');
    }
    const word = code[pc];
    const opcode = word & 0xff;
    const opd = word >> 8;          // signed 24-bit
    const opdU = (word >>> 8) & 0xFFFFFF;  // unsigned

    switch (opcode) {
      case OP.NOP: pc++; break;
      case OP.HALT: return;
      case OP.PAUSE: {
        if (!state.paused) {
          state.paused = true;
          state.justPaused = true;
        }
        return;
      }

      // -------------------- constantes / vars --------------------
      case OP.LDI:
        stack[state.evalSp++] = opd;
        pc++;
        break;
      case OP.LDC:
        stack[state.evalSp++] = constants[opdU] | 0;
        pc++;
        break;
      case OP.LDV:
        stack[state.evalSp++] = state.vars[opdU];
        pc++;
        break;
      case OP.STV:
        state.vars[opdU] = stack[--state.evalSp];
        pc++;
        break;
      case OP.ADDV:
        state.vars[opdU] += stack[--state.evalSp];
        pc++;
        break;
      case OP.SUBV:
        state.vars[opdU] -= stack[--state.evalSp];
        pc++;
        break;
      case OP.MULV:
        state.vars[opdU] *= stack[--state.evalSp];
        pc++;
        break;
      case OP.DIVV: {
        const v = stack[--state.evalSp];
        state.vars[opdU] = (state.vars[opdU] / v) | 0;
        pc++;
        break;
      }
      case OP.LDA: {
        const i = stack[state.evalSp - 1] | 0;
        const base = opdU * ARRAY_SIZE;
        stack[state.evalSp - 1] = (i >= 0 && i < ARRAY_SIZE) ? state.arrays[base + i] : 0;
        pc++;
        break;
      }
      case OP.STA: {
        const v = stack[--state.evalSp];
        const i = stack[--state.evalSp] | 0;
        const base = opdU * ARRAY_SIZE;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] = v;
        pc++;
        break;
      }
      case OP.ADDA: {
        const v = stack[--state.evalSp];
        const i = stack[--state.evalSp] | 0;
        const base = opdU * ARRAY_SIZE;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] += v;
        pc++;
        break;
      }
      case OP.SUBA: {
        const v = stack[--state.evalSp];
        const i = stack[--state.evalSp] | 0;
        const base = opdU * ARRAY_SIZE;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] -= v;
        pc++;
        break;
      }
      case OP.MULA: {
        const v = stack[--state.evalSp];
        const i = stack[--state.evalSp] | 0;
        const base = opdU * ARRAY_SIZE;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] *= v;
        pc++;
        break;
      }
      case OP.DIVA: {
        const v = stack[--state.evalSp];
        const i = stack[--state.evalSp] | 0;
        const base = opdU * ARRAY_SIZE;
        if (i >= 0 && i < ARRAY_SIZE) {
          state.arrays[base + i] = (state.arrays[base + i] / v) | 0;
        }
        pc++;
        break;
      }

      // -------------------- aritmética --------------------
      case OP.ADD: {
        const b = stack[--state.evalSp]; stack[state.evalSp - 1] += b; pc++; break;
      }
      case OP.SUB: {
        const b = stack[--state.evalSp]; stack[state.evalSp - 1] -= b; pc++; break;
      }
      case OP.MUL: {
        const b = stack[--state.evalSp]; stack[state.evalSp - 1] *= b; pc++; break;
      }
      case OP.DIV: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = (stack[state.evalSp - 1] / b) | 0;
        pc++; break;
      }
      case OP.MOD: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] % b;
        pc++; break;
      }
      case OP.NEG:
        stack[state.evalSp - 1] = -stack[state.evalSp - 1];
        pc++; break;
      case OP.LT: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] < b ? 1 : 0;
        pc++; break;
      }
      case OP.LE: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] <= b ? 1 : 0;
        pc++; break;
      }
      case OP.GT: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] > b ? 1 : 0;
        pc++; break;
      }
      case OP.GE: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] >= b ? 1 : 0;
        pc++; break;
      }
      case OP.EQ: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] === b ? 1 : 0;
        pc++; break;
      }
      case OP.NE: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = stack[state.evalSp - 1] !== b ? 1 : 0;
        pc++; break;
      }
      case OP.AND: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = (stack[state.evalSp - 1] && b) ? 1 : 0;
        pc++; break;
      }
      case OP.OR: {
        const b = stack[--state.evalSp];
        stack[state.evalSp - 1] = (stack[state.evalSp - 1] || b) ? 1 : 0;
        pc++; break;
      }
      case OP.NOT:
        stack[state.evalSp - 1] = stack[state.evalSp - 1] ? 0 : 1;
        pc++; break;

      // -------------------- control de flujo --------------------
      case OP.JMP: pc = opdU; break;
      case OP.JZ: {
        const v = stack[--state.evalSp];
        pc = v ? pc + 1 : opdU;
        break;
      }
      case OP.JNZ: {
        const v = stack[--state.evalSp];
        pc = v ? opdU : pc + 1;
        break;
      }
      case OP.CALL:
        state.callStack[state.callSp++] = pc + 1;
        pc = opdU;
        break;
      case OP.RET:
        if (state.callSp === 0) return;
        pc = state.callStack[--state.callSp];
        break;
      case OP.PARINIT: {
        const sp = state.loopSp++;
        const off = sp * LOOP_FRAME_SIZE;
        const end = stack[--state.evalSp];
        state.loopStack[off + 0] = opdU;
        state.loopStack[off + 1] = end;
        state.loopStack[off + 2] = pc + 1;  // bodyBcPc
        pc++;
        break;
      }
      case OP.PARSIG: {
        const sp = state.loopSp - 1;
        if (sp < 0) throw new Error('SIG sin PAR correspondiente');
        const off = sp * LOOP_FRAME_SIZE;
        const varIdx = state.loopStack[off + 0];
        const end    = state.loopStack[off + 1];
        const body   = state.loopStack[off + 2];
        const next = state.vars[varIdx] + 1;
        state.vars[varIdx] = next;
        if (next <= end) {
          pc = body;
        } else {
          state.loopSp = sp;
          pc++;
        }
        break;
      }

      // -------------------- memoria --------------------
      case OP.LDM: {
        const a = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = readByte(state, vmRef, a);
        pc++; break;
      }
      case OP.STM: {
        const v = stack[--state.evalSp];
        const a = stack[--state.evalSp] | 0;
        writeByte(state, vmRef, a, v);
        pc++; break;
      }
      case OP.LDW: {
        const a = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = readWord(state, vmRef, a);
        pc++; break;
      }
      case OP.STW: {
        const v = stack[--state.evalSp];
        const a = stack[--state.evalSp] | 0;
        writeWord(state, vmRef, a, v);
        pc++; break;
      }
      case OP.LDR: {
        const o = stack[--state.evalSp];
        const s = stack[--state.evalSp];
        const r = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = readByteIndexed(vmRef, r, s, o);
        pc++; break;
      }
      case OP.STR: {
        const v = stack[--state.evalSp];
        const o = stack[--state.evalSp];
        const s = stack[--state.evalSp];
        const r = stack[--state.evalSp];
        writeByteIndexed(vmRef, r, s, o, v);
        pc++; break;
      }
      case OP.MEMCPY: {
        const n = stack[--state.evalSp] | 0;
        const dst = stack[--state.evalSp] | 0;
        const src = stack[--state.evalSp] | 0;
        memCopy(state, vmRef, src, dst, n);
        pc++; break;
      }
      case OP.MEMSET: {
        const n = stack[--state.evalSp] | 0;
        const v = stack[--state.evalSp];
        const dst = stack[--state.evalSp] | 0;
        memSet(state, vmRef, dst, v, n);
        pc++; break;
      }

      // -------------------- dibujo --------------------
      case OP.BOR: {
        const c = stack[--state.evalSp];
        DRAW_BUILTINS.BOR.fn(vmRef.fb, c);
        pc++; break;
      }
      case OP.PIN: {
        const c = stack[--state.evalSp];
        const y = stack[--state.evalSp];
        const x = stack[--state.evalSp];
        DRAW_BUILTINS.PIN.fn(vmRef.fb, x, y, c);
        pc++; break;
      }
      case OP.REC: {
        const c = stack[--state.evalSp];
        const h = stack[--state.evalSp];
        const w = stack[--state.evalSp];
        const y = stack[--state.evalSp];
        const x = stack[--state.evalSp];
        DRAW_BUILTINS.REC.fn(vmRef.fb, x, y, w, h, c);
        pc++; break;
      }
      case OP.TXT: {
        const c = stack[--state.evalSp];
        const sIdx = stack[--state.evalSp];
        const y = stack[--state.evalSp];
        const x = stack[--state.evalSp];
        drawText(vmRef.fb, x | 0, y | 0, constants[sIdx] || '', c);
        pc++; break;
      }

      // -------------------- sprites --------------------
      case OP.SPR: {
        const f = stack[--state.evalSp];
        const y = stack[--state.evalSp];
        const x = stack[--state.evalSp];
        const n = stack[--state.evalSp];
        const pat = vmRef.spriteState.patterns[n];
        if (pat) drawPattern(vmRef.fb, pat, x, y, (f & 1) !== 0, (f & 2) !== 0);
        pc++; break;
      }
      case OP.MOV: {
        const yy = stack[--state.evalSp];
        const xx = stack[--state.evalSp];
        const n = stack[--state.evalSp] | 0;
        const a = vmRef.spriteState.actors;
        const off = n * ACTOR_FIELDS;
        a[off + F_X] = xx;
        a[off + F_Y] = yy;
        a[off + F_FLAGS] &= ~FLAG_HIDDEN;
        pc++; break;
      }
      case OP.VEL: {
        const vy = stack[--state.evalSp];
        const vx = stack[--state.evalSp];
        const n = stack[--state.evalSp] | 0;
        const a = vmRef.spriteState.actors;
        const off = n * ACTOR_FIELDS;
        a[off + F_VX] = vx;
        a[off + F_VY] = vy;
        pc++; break;
      }
      case OP.ANI: {
        const t = stack[--state.evalSp];
        const aniB = stack[--state.evalSp] | 0;
        const aniA = stack[--state.evalSp] | 0;
        const n = stack[--state.evalSp] | 0;
        const a = vmRef.spriteState.actors;
        const off = n * ACTOR_FIELDS;
        a[off + F_ANI_A] = aniA;
        a[off + F_ANI_B] = aniB;
        a[off + F_ANI_STATE] = ((t | 0) & 0xff) << 8;
        vmRef.spriteState.patternIdx[n] = aniA;
        pc++; break;
      }
      case OP.OCU: {
        const v = stack[--state.evalSp];
        const n = stack[--state.evalSp] | 0;
        const off = n * ACTOR_FIELDS + F_FLAGS;
        const a = vmRef.spriteState.actors;
        if (v) a[off] |= FLAG_HIDDEN;
        else   a[off] &= ~FLAG_HIDDEN;
        pc++; break;
      }
      case OP.INV: {
        const n = stack[--state.evalSp] | 0;
        const field = opdU === 0 ? F_VX : F_VY;
        const off = n * ACTOR_FIELDS + field;
        const a = vmRef.spriteState.actors;
        a[off] = -a[off];
        pc++; break;
      }
      case OP.PAT: {
        const p = stack[--state.evalSp] | 0;
        const n = stack[--state.evalSp] | 0;
        vmRef.spriteState.patternIdx[n] = p;
        pc++; break;
      }

      // -------------------- mapas y físicas --------------------
      case OP.MAP_: {
        const yy = stack[--state.evalSp];
        const xx = stack[--state.evalSp];
        const n = stack[--state.evalSp] | 0;
        blitMap(vmRef.mapState, n, vmRef.fb, xx, yy, vmRef.spriteState.patterns);
        pc++; break;
      }
      case OP.FON: {
        const n = stack[--state.evalSp] | 0;
        setActiveBackground(vmRef.mapState, n);
        pc++; break;
      }
      case OP.SOL: {
        // operand = arity (>= 2). Pop arity-1 tiles, luego map.
        const arity = opdU;
        const tileCount = arity - 1;
        const tiles = new Array(tileCount);
        for (let i = tileCount - 1; i >= 0; i--) tiles[i] = stack[--state.evalSp];
        const m = stack[--state.evalSp] | 0;
        setSolid(vmRef.mapState, m, tiles);
        pc++; break;
      }
      case OP.GRA: {
        const g = stack[--state.evalSp] | 0;
        const m = stack[--state.evalSp] | 0;
        const n = stack[--state.evalSp] | 0;
        const off = n * ACTOR_FIELDS;
        const a = vmRef.spriteState.actors;
        a[off + F_PHYS_MAP] = m;
        a[off + F_PHYS_GRA] = g;
        pc++; break;
      }
      case OP.SAL: {
        const f = stack[--state.evalSp] | 0;
        const n = stack[--state.evalSp] | 0;
        const off = n * ACTOR_FIELDS;
        const a = vmRef.spriteState.actors;
        if (a[off + F_FLAGS] & FLAG_ON_GROUND) {
          a[off + F_VY] = -f;
          a[off + F_FLAGS] &= ~FLAG_ON_GROUND;
        }
        pc++; break;
      }
      case OP.LIM: {
        const y2 = stack[--state.evalSp];
        const x2 = stack[--state.evalSp];
        const y1 = stack[--state.evalSp];
        const x1 = stack[--state.evalSp];
        const n = stack[--state.evalSp] | 0;
        const off = n * ACTOR_FIELDS;
        const a = vmRef.spriteState.actors;
        a[off + F_LIM_X1] = x1;
        a[off + F_LIM_Y1] = y1;
        a[off + F_LIM_X2] = x2;
        a[off + F_LIM_Y2] = y2;
        a[off + F_FLAGS] |= FLAG_LIM_ACTIVE;
        pc++; break;
      }

      // -------------------- audio --------------------
      case OP.SON: {
        const c = stack[--state.evalSp] | 0;
        const n = stack[--state.evalSp] | 0;
        playSound(vmRef.synth, n, c);
        pc++; break;
      }
      case OP.RUI: {
        const n = stack[--state.evalSp] | 0;
        playNoise(vmRef.synth, n);
        pc++; break;
      }
      case OP.SIL: {
        const c = stack[--state.evalSp] | 0;
        silenceChannel(vmRef.synth, c);
        pc++; break;
      }

      // -------------------- lifecycle --------------------
      case OP.CARNIV: {
        const n = stack[--state.evalSp] | 0;
        state.vars[VAR_INDEX.NIV] = n;
        state.pendingLevelLoad = true;
        pc++; break;
      }

      // -------------------- queries (push resultado) --------------------
      case OP.X_: {
        const n = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_X];
        pc++; break;
      }
      case OP.Y_: {
        const n = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_Y];
        pc++; break;
      }
      case OP.VX_: {
        const n = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_VX];
        pc++; break;
      }
      case OP.VY_: {
        const n = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_VY];
        pc++; break;
      }
      case OP.VIS: {
        const n = stack[state.evalSp - 1] | 0;
        const flags = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_FLAGS];
        stack[state.evalSp - 1] = (flags & FLAG_HIDDEN) ? 0 : 1;
        pc++; break;
      }
      case OP.COL: {
        const b = stack[--state.evalSp] | 0;
        const a = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = aabbCollide(vmRef.spriteState, a, b);
        pc++; break;
      }
      case OP.DIS: {
        const b = stack[--state.evalSp] | 0;
        const a = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = actorDistance(vmRef.spriteState, a, b);
        pc++; break;
      }
      case OP.TIL: {
        const r = stack[--state.evalSp] | 0;
        const c = stack[--state.evalSp] | 0;
        const m = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = readTile(vmRef.mapState, m, c, r);
        pc++; break;
      }
      case OP.COLM: {
        const m = stack[--state.evalSp] | 0;
        const s = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = actorCollidesMap(
          vmRef.spriteState, vmRef.mapState, s, m,
          F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
        pc++; break;
      }
      case OP.PIE: {
        const n = stack[state.evalSp - 1] | 0;
        const off = n * ACTOR_FIELDS;
        const a = vmRef.spriteState.actors;
        let r;
        if (a[off + F_FLAGS] & FLAG_ON_GROUND) {
          r = 1;
        } else {
          const mapIdx = a[off + F_PHYS_MAP];
          r = mapIdx < 0 ? 0 : actorOnGround(
            vmRef.spriteState, vmRef.mapState, n, mapIdx,
            F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
        }
        stack[state.evalSp - 1] = r;
        pc++; break;
      }
      case OP.BTN: {
        const b = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = (b < 0 || b >= 8) ? 0 : (vmRef.inputState.buttons[b] ? 1 : 0);
        pc++; break;
      }
      case OP.TEC: {
        const k = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = (k < 0 || k >= 256) ? 0 : (vmRef.inputState.keys[k] ? 1 : 0);
        pc++; break;
      }
      case OP.ALE: {
        const n = stack[state.evalSp - 1] | 0;
        stack[state.evalSp - 1] = n <= 0 ? 0 : (nextRandom(state) % n);
        pc++; break;
      }
      case OP.ABS_F: {
        const x = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = x < 0 ? -x : x;
        pc++; break;
      }
      case OP.SGN: {
        const x = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = x > 0 ? 1 : x < 0 ? -1 : 0;
        pc++; break;
      }
      case OP.RAI: {
        const x = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = x < 0 ? 0 : Math.sqrt(x) | 0;
        pc++; break;
      }
      case OP.SEN: {
        const g = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = Math.round(Math.sin(g * Math.PI / 180) * 1000) | 0;
        pc++; break;
      }
      case OP.COS: {
        const g = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = Math.round(Math.cos(g * Math.PI / 180) * 1000) | 0;
        pc++; break;
      }
      case OP.MIN: {
        const b = stack[--state.evalSp];
        const a = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = a < b ? a : b;
        pc++; break;
      }
      case OP.MAX: {
        const b = stack[--state.evalSp];
        const a = stack[state.evalSp - 1];
        stack[state.evalSp - 1] = a > b ? a : b;
        pc++; break;
      }

      default:
        throw new Error(`opcode desconocido 0x${opcode.toString(16)} @ pc=${pc}`);
    }
  }
}
