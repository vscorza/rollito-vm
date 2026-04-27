import { resolveVar, READONLY_VARS, LOOP_FRAME_SIZE, VAR_INDEX, ARRAY_SIZE, nextRandom } from '../core/memory.js';
import { drawText } from '../builtins/text.js';
import { DRAW_BUILTINS } from '../builtins/draw.js';
import {
  ACTOR_FIELDS,
  F_X, F_Y, F_VX, F_VY, F_FLAGS, F_ANI_A, F_ANI_B, F_ANI_STATE,
  F_PHYS_MAP, F_PHYS_GRA, F_LIM_X1, F_LIM_Y1, F_LIM_X2, F_LIM_Y2,
  FLAG_HIDDEN, FLAG_FLIP_X, FLAG_FLIP_Y, FLAG_ON_GROUND, FLAG_LIM_ACTIVE,
  drawPattern, aabbCollide, actorDistance,
} from '../core/sprites.js';
import {
  setSolid, blitMap, readTile, writeTile, setActiveBackground,
  actorCollidesMap, actorOnGround,
} from '../core/maps.js';
import { playSound, playNoise, silenceChannel, TOTAL_CHANNELS } from '../audio/synth.js';

// Compila un programa parseado (output de parseProgram) a una representación
// ejecutable del VM:
//   {
//     program: Array<Function>,         // closures (pc, state) => nextPc
//     handlers: { CUADRO?: idx, ... },  // resueltos a índice de program
//   }
//
// vmRef es el objeto compartido con vm.js que contiene:
//   { fb, spriteState }
// Las closures cierran sobre vmRef y leen vmRef.fb / vmRef.spriteState
// directamente. Esto permite que el VM core haga init de fb/sprites
// independientemente del compilador.

export function compile(parseResult, vmRef) {
  const { lines } = parseResult;

  const lineToIdx = Object.create(null);
  const handlers = {
    INICIOMOTOR: undefined,
    INICIOJUEGO: undefined,
    CARGANIVEL: undefined,
    INICIONIVEL: undefined,
    CUADRO: undefined,
    FINCUADRO: undefined,
    PAUSA: undefined,
    REANUDA: undefined,
    SILENCIO: undefined,
    CANAL: new Array(TOTAL_CHANNELS),
  };
  let idx = 0;
  for (const line of lines) {
    if (line.ast.type === 'event') continue;
    lineToIdx[line.lineNumber] = idx++;
  }
  for (const line of lines) {
    if (line.ast.type !== 'event') continue;
    const target = lineToIdx[line.ast.line];
    if (target === undefined) {
      throw new Error(`EN ${line.ast.event}: línea ${line.ast.line} no existe`);
    }
    if (line.ast.event === 'CANAL') {
      const c = line.ast.channel | 0;
      if (c < 0 || c >= TOTAL_CHANNELS) {
        throw new Error(`EN CANAL ${c}: canal fuera de rango (0..${TOTAL_CHANNELS - 1})`);
      }
      handlers.CANAL[c] = target;
    } else {
      handlers[line.ast.event] = target;
    }
  }

  const program = new Array(idx);
  let i = 0;
  for (const line of lines) {
    if (line.ast.type === 'event') continue;
    program[i] = compileStmt(line.ast, vmRef, lineToIdx, line.lineNumber);
    i++;
  }
  return { program, handlers, lineToIdx };
}

function compileStmt(ast, vmRef, lineToIdx, lineNum) {
  switch (ast.type) {
    case 'assign':       return compileAssign(ast, vmRef);
    case 'arrayAssign':  return compileArrayAssign(ast, vmRef);
    case 'if':      return compileIf(ast, vmRef, lineToIdx, lineNum);
    case 'for':     return compileFor(ast, vmRef);
    case 'next':    return compileNext();
    case 'goto':    return compileGoto(ast, lineToIdx, lineNum);
    case 'gosub':   return compileGosub(ast, lineToIdx, lineNum);
    case 'ret':     return compileRet();
    case 'fin':     return () => -1;
    case 'pausa':   return compilePausa();
    case 'call':    return compileCall(ast, vmRef);
    case 'seq':     return compileSeq(ast, vmRef, lineToIdx, lineNum);
    default:
      throw new Error(`tipo de AST desconocido: ${ast.type}`);
  }
}

function resolveLineIdx(line, lineToIdx, fromLine) {
  const idx = lineToIdx[line];
  if (idx === undefined) {
    throw new Error(`línea ${fromLine}: salto a línea ${line} no existe`);
  }
  return idx;
}

function compileGoto(ast, lineToIdx, fromLine) {
  const target = resolveLineIdx(ast.line, lineToIdx, fromLine);
  return () => target;
}

function compileGosub(ast, lineToIdx, fromLine) {
  const target = resolveLineIdx(ast.line, lineToIdx, fromLine);
  return (pc, state) => {
    const sp = state.callSp;
    state.callStack[sp] = pc + 1;
    state.callSp = sp + 1;
    return target;
  };
}

function compileRet() {
  return (_pc, state) => {
    if (state.callSp === 0) return -1;
    const sp = state.callSp - 1;
    state.callSp = sp;
    return state.callStack[sp];
  };
}

function compileAssign(ast, vmRef) {
  const targetIdx = resolveVar(ast.target);
  if (READONLY_VARS.has(ast.target)) {
    throw new Error(`variable ${ast.target} es read-only`);
  }
  const exprFn = compileExpr(ast.expr, vmRef);
  switch (ast.op) {
    case '=':  return (pc, state) => { state.vars[targetIdx] = exprFn(state); return pc + 1; };
    case '+=': return (pc, state) => { state.vars[targetIdx] += exprFn(state); return pc + 1; };
    case '-=': return (pc, state) => { state.vars[targetIdx] -= exprFn(state); return pc + 1; };
    case '*=': return (pc, state) => { state.vars[targetIdx] *= exprFn(state); return pc + 1; };
    case '/=': return (pc, state) => { state.vars[targetIdx] = (state.vars[targetIdx] / exprFn(state)) | 0; return pc + 1; };
    default: throw new Error(`op de asignación desconocido: ${ast.op}`);
  }
}

function compileArrayAssign(ast, vmRef) {
  const arrayIdx = parseInt(ast.array[1], 10);
  const idxFn = compileExpr(ast.index, vmRef);
  const exprFn = compileExpr(ast.expr, vmRef);
  const base = arrayIdx * ARRAY_SIZE;
  const op = ast.op || '=';
  switch (op) {
    case '=':
      return (pc, state) => {
        const i = idxFn(state) | 0;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] = exprFn(state);
        return pc + 1;
      };
    case '+=':
      return (pc, state) => {
        const i = idxFn(state) | 0;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] += exprFn(state);
        return pc + 1;
      };
    case '-=':
      return (pc, state) => {
        const i = idxFn(state) | 0;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] -= exprFn(state);
        return pc + 1;
      };
    case '*=':
      return (pc, state) => {
        const i = idxFn(state) | 0;
        if (i >= 0 && i < ARRAY_SIZE) state.arrays[base + i] *= exprFn(state);
        return pc + 1;
      };
    case '/=':
      return (pc, state) => {
        const i = idxFn(state) | 0;
        if (i >= 0 && i < ARRAY_SIZE) {
          state.arrays[base + i] = (state.arrays[base + i] / exprFn(state)) | 0;
        }
        return pc + 1;
      };
    default:
      throw new Error(`op de asignación de arreglo desconocido: ${op}`);
  }
}

function compileArrayRead(ast, vmRef) {
  if (ast.args.length !== 1) {
    throw new Error(`${ast.name}: requiere 1 índice`);
  }
  const arrayIdx = parseInt(ast.name[1], 10);
  const base = arrayIdx * ARRAY_SIZE;
  const idxFn = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const i = idxFn(state) | 0;
    if (i < 0 || i >= ARRAY_SIZE) return 0;
    return state.arrays[base + i];
  };
}

function compileIf(ast, vmRef, lineToIdx, lineNum) {
  const condFn = compileExpr(ast.cond, vmRef);
  const thenStmt = compileStmt(ast.then, vmRef, lineToIdx, lineNum);
  const elseStmt = ast.else ? compileStmt(ast.else, vmRef, lineToIdx, lineNum) : null;
  return (pc, state) => {
    if (condFn(state)) return thenStmt(pc, state);
    if (elseStmt)      return elseStmt(pc, state);
    return pc + 1;
  };
}

function compileFor(ast, vmRef) {
  const varIdx = resolveVar(ast.var);
  const fromFn = compileExpr(ast.from, vmRef);
  const toFn   = compileExpr(ast.to, vmRef);
  return (pc, state) => {
    state.vars[varIdx] = fromFn(state);
    const sp = state.loopSp;
    state.loopStack[sp * LOOP_FRAME_SIZE + 0] = varIdx;
    state.loopStack[sp * LOOP_FRAME_SIZE + 1] = toFn(state);
    state.loopStack[sp * LOOP_FRAME_SIZE + 2] = pc + 1;
    state.loopSp = sp + 1;
    return pc + 1;
  };
}

function compileNext() {
  return (pc, state) => {
    const sp = state.loopSp - 1;
    if (sp < 0) throw new Error(`SIG sin PAR correspondiente`);
    const varIdx = state.loopStack[sp * LOOP_FRAME_SIZE + 0];
    const end    = state.loopStack[sp * LOOP_FRAME_SIZE + 1];
    const body   = state.loopStack[sp * LOOP_FRAME_SIZE + 2];
    const next = state.vars[varIdx] + 1;
    state.vars[varIdx] = next;
    if (next <= end) return body;
    state.loopSp = sp;
    return pc + 1;
  };
}

function compileSeq(ast, vmRef, lineToIdx, lineNum) {
  const stmts = ast.stmts.map((s) => compileStmt(s, vmRef, lineToIdx, lineNum));
  return (pc, state) => {
    for (let k = 0; k < stmts.length; k++) {
      const r = stmts[k](pc, state);
      if (r !== pc + 1) return r;
    }
    return pc + 1;
  };
}

function compileCall(ast, vmRef) {
  // Statement builtins. Algunos van vía DRAW_BUILTINS (BOR/PIN/REC),
  // otros operan sobre actores y se compilan inline.
  switch (ast.name) {
    case 'BOR':
    case 'PIN':
    case 'REC':
      return compileDrawBuiltin(ast, vmRef);
    case 'TXT': return compileTxt(ast, vmRef);
    case 'SPR': return compileSpr(ast, vmRef);
    case 'MOV': return compileMov(ast, vmRef);
    case 'VEL': return compileVel(ast, vmRef);
    case 'ANI': return compileAni(ast, vmRef);
    case 'OCU': return compileOcu(ast, vmRef);
    case 'INV': return compileInv(ast, vmRef);
    case 'PAT': return compilePat(ast, vmRef);
    case 'MAP': return compileMap(ast, vmRef);
    case 'FON': return compileFon(ast, vmRef);
    case 'SOL': return compileSol(ast, vmRef);
    case 'GRA': return compileGra(ast, vmRef);
    case 'SAL': return compileSal(ast, vmRef);
    case 'LIM': return compileLim(ast, vmRef);
    case 'SON': return compileSon(ast, vmRef);
    case 'RUI': return compileRui(ast, vmRef);
    case 'SIL': return compileSil(ast, vmRef);
    case 'CARNIV': return compileCarniv(ast, vmRef);
    default:
      throw new Error(`builtin desconocido: ${ast.name}`);
  }
}

function expectArity(ast, n) {
  if (ast.args.length !== n) {
    throw new Error(`${ast.name} requiere ${n} args, recibió ${ast.args.length}`);
  }
}

// TXT x,y,"texto"[,c] — render de texto con fuente 8x8 hardcoded.
// El literal de string se extrae en compile-time. Color default 1.
function compileTxt(ast, vmRef) {
  if (ast.args.length !== 3 && ast.args.length !== 4) {
    throw new Error(`TXT requiere 3 o 4 args (x,y,"...",c?)`);
  }
  const strAst = ast.args[2];
  if (strAst.type !== 'str') {
    throw new Error(`TXT: tercer arg debe ser literal de string`);
  }
  const text = strAst.value;
  const aX = compileExpr(ast.args[0], vmRef);
  const aY = compileExpr(ast.args[1], vmRef);
  const aC = ast.args.length === 4 ? compileExpr(ast.args[3], vmRef) : null;
  return (pc, state) => {
    const c = aC ? aC(state) : 1;
    drawText(vmRef.fb, aX(state) | 0, aY(state) | 0, text, c);
    return pc + 1;
  };
}

function compileDrawBuiltin(ast, vmRef) {
  const def = DRAW_BUILTINS[ast.name];
  expectArity(ast, def.arity);
  const fn = def.fn;
  const argFns = ast.args.map((a) => compileExpr(a, vmRef));
  switch (def.arity) {
    case 1: {
      const a0 = argFns[0];
      return (pc, state) => { fn(vmRef.fb, a0(state)); return pc + 1; };
    }
    case 3: {
      const a0 = argFns[0], a1 = argFns[1], a2 = argFns[2];
      return (pc, state) => { fn(vmRef.fb, a0(state), a1(state), a2(state)); return pc + 1; };
    }
    case 5: {
      const a0 = argFns[0], a1 = argFns[1], a2 = argFns[2], a3 = argFns[3], a4 = argFns[4];
      return (pc, state) => { fn(vmRef.fb, a0(state), a1(state), a2(state), a3(state), a4(state)); return pc + 1; };
    }
    default:
      throw new Error(`aridad ${def.arity} no manejada inline`);
  }
}

// SPR n,x,y[,f] — render inmediato del patrón (sin tocar estado).
function compileSpr(ast, vmRef) {
  if (ast.args.length !== 3 && ast.args.length !== 4) {
    throw new Error(`SPR requiere 3 o 4 args, recibió ${ast.args.length}`);
  }
  const argFns = ast.args.map((a) => compileExpr(a, vmRef));
  if (ast.args.length === 3) {
    const aN = argFns[0], aX = argFns[1], aY = argFns[2];
    return (pc, state) => {
      const n = aN(state);
      const pat = vmRef.spriteState.patterns[n];
      if (pat) drawPattern(vmRef.fb, pat, aX(state), aY(state), false, false);
      return pc + 1;
    };
  }
  const aN = argFns[0], aX = argFns[1], aY = argFns[2], aF = argFns[3];
  return (pc, state) => {
    const n = aN(state);
    const pat = vmRef.spriteState.patterns[n];
    if (pat) {
      const f = aF(state);
      drawPattern(vmRef.fb, pat, aX(state), aY(state), (f & 1) !== 0, (f & 2) !== 0);
    }
    return pc + 1;
  };
}

// MOV n,x,y — posición + visible.
function compileMov(ast, vmRef) {
  expectArity(ast, 3);
  const aN = compileExpr(ast.args[0], vmRef);
  const aX = compileExpr(ast.args[1], vmRef);
  const aY = compileExpr(ast.args[2], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const a = vmRef.spriteState.actors;
    const off = n * ACTOR_FIELDS;
    a[off + F_X] = aX(state);
    a[off + F_Y] = aY(state);
    a[off + F_FLAGS] &= ~FLAG_HIDDEN;
    return pc + 1;
  };
}

function compileVel(ast, vmRef) {
  expectArity(ast, 3);
  const aN = compileExpr(ast.args[0], vmRef);
  const aVx = compileExpr(ast.args[1], vmRef);
  const aVy = compileExpr(ast.args[2], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const a = vmRef.spriteState.actors;
    const off = n * ACTOR_FIELDS;
    a[off + F_VX] = aVx(state);
    a[off + F_VY] = aVy(state);
    return pc + 1;
  };
}

function compileAni(ast, vmRef) {
  expectArity(ast, 4);
  const aN = compileExpr(ast.args[0], vmRef);
  const aA = compileExpr(ast.args[1], vmRef);
  const aB = compileExpr(ast.args[2], vmRef);
  const aT = compileExpr(ast.args[3], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const a = vmRef.spriteState.actors;
    const off = n * ACTOR_FIELDS;
    const aniA = aA(state) | 0;
    const aniB = aB(state) | 0;
    const t = (aT(state) | 0) & 0xff;
    a[off + F_ANI_A] = aniA;
    a[off + F_ANI_B] = aniB;
    a[off + F_ANI_STATE] = (t << 8);
    vmRef.spriteState.patternIdx[n] = aniA;
    return pc + 1;
  };
}

function compileOcu(ast, vmRef) {
  expectArity(ast, 2);
  const aN = compileExpr(ast.args[0], vmRef);
  const aV = compileExpr(ast.args[1], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const v = aV(state);
    const a = vmRef.spriteState.actors;
    const off = n * ACTOR_FIELDS + F_FLAGS;
    if (v) a[off] |= FLAG_HIDDEN;
    else   a[off] &= ~FLAG_HIDDEN;
    return pc + 1;
  };
}

// INV n,X | INV n,Y. El segundo arg es literal de eje, NO una variable.
function compileInv(ast, vmRef) {
  expectArity(ast, 2);
  const axisAst = ast.args[1];
  if (axisAst.type !== 'var' || (axisAst.name !== 'X' && axisAst.name !== 'Y')) {
    throw new Error(`INV: segundo arg debe ser X o Y (eje), no expresión`);
  }
  const field = axisAst.name === 'X' ? F_VX : F_VY;
  const aN = compileExpr(ast.args[0], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const a = vmRef.spriteState.actors;
    const off = n * ACTOR_FIELDS + field;
    a[off] = -a[off];
    return pc + 1;
  };
}

function compilePat(ast, vmRef) {
  expectArity(ast, 2);
  const aN = compileExpr(ast.args[0], vmRef);
  const aP = compileExpr(ast.args[1], vmRef);
  return (pc, state) => {
    vmRef.spriteState.patternIdx[aN(state) | 0] = aP(state) | 0;
    return pc + 1;
  };
}

// MAP n,x,y — pinta el mapa una vez en (x,y).
function compileMap(ast, vmRef) {
  expectArity(ast, 3);
  const aN = compileExpr(ast.args[0], vmRef);
  const aX = compileExpr(ast.args[1], vmRef);
  const aY = compileExpr(ast.args[2], vmRef);
  return (pc, state) => {
    blitMap(vmRef.mapState, aN(state) | 0, vmRef.fb, aX(state), aY(state), vmRef.spriteState.patterns);
    return pc + 1;
  };
}

// FON n — fija el mapa n como fondo auto-renderizado al inicio de cada cuadro.
function compileFon(ast, vmRef) {
  expectArity(ast, 1);
  const aN = compileExpr(ast.args[0], vmRef);
  return (pc, state) => {
    setActiveBackground(vmRef.mapState, aN(state) | 0);
    return pc + 1;
  };
}

// SOL m,t1,t2,... — declara tiles sólidos del mapa m.
function compileSol(ast, vmRef) {
  if (ast.args.length < 2) {
    throw new Error(`SOL requiere al menos 2 args (mapa y un tile)`);
  }
  const aM = compileExpr(ast.args[0], vmRef);
  const tFns = ast.args.slice(1).map((a) => compileExpr(a, vmRef));
  const buf = new Array(tFns.length);
  return (pc, state) => {
    for (let k = 0; k < tFns.length; k++) buf[k] = tFns[k](state);
    setSolid(vmRef.mapState, aM(state) | 0, buf);
    return pc + 1;
  };
}

// GRA n,m,a — enlaza actor n al mapa m con gravedad a.
function compileGra(ast, vmRef) {
  expectArity(ast, 3);
  const aN = compileExpr(ast.args[0], vmRef);
  const aM = compileExpr(ast.args[1], vmRef);
  const aG = compileExpr(ast.args[2], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const off = n * ACTOR_FIELDS;
    const a = vmRef.spriteState.actors;
    a[off + F_PHYS_MAP] = aM(state) | 0;
    a[off + F_PHYS_GRA] = aG(state) | 0;
    return pc + 1;
  };
}

// SAL n,f — fuerza vertical de salto si PIE(n)=1.
function compileSal(ast, vmRef) {
  expectArity(ast, 2);
  const aN = compileExpr(ast.args[0], vmRef);
  const aF = compileExpr(ast.args[1], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const off = n * ACTOR_FIELDS;
    const a = vmRef.spriteState.actors;
    if (a[off + F_FLAGS] & FLAG_ON_GROUND) {
      a[off + F_VY] = -(aF(state) | 0);
      a[off + F_FLAGS] &= ~FLAG_ON_GROUND;
    }
    return pc + 1;
  };
}

// PAUSA — entra al estado pausado y halta el handler actual.
// El handler EN PAUSA dispara al inicio del próximo cuadro (vm.js detecta
// `state.justPaused` y lo drena).
function compilePausa() {
  return (_pc, state) => {
    if (!state.paused) {
      state.paused = true;
      state.justPaused = true;
    }
    return -1;
  };
}

// CARNIV n — carga el nivel n: setea NIV y marca pendingLevelLoad.
// El próximo cuadro dispara CARGANIVEL → INICIONIVEL.
function compileCarniv(ast, vmRef) {
  expectArity(ast, 1);
  const aN = compileExpr(ast.args[0], vmRef);
  return (pc, state) => {
    state.vars[VAR_INDEX.NIV] = aN(state) | 0;
    state.pendingLevelLoad = true;
    return pc + 1;
  };
}

// SON n,c — reproduce sonido n en canal tonal c (0..3).
function compileSon(ast, vmRef) {
  expectArity(ast, 2);
  const aN = compileExpr(ast.args[0], vmRef);
  const aC = compileExpr(ast.args[1], vmRef);
  return (pc, state) => {
    playSound(vmRef.synth, aN(state) | 0, aC(state) | 0);
    return pc + 1;
  };
}

// RUI n — reproduce sonido n en canal de ruido.
function compileRui(ast, vmRef) {
  expectArity(ast, 1);
  const aN = compileExpr(ast.args[0], vmRef);
  return (pc, state) => {
    playNoise(vmRef.synth, aN(state) | 0);
    return pc + 1;
  };
}

// SIL c — silencia canal c (0..3 tonal, 4 ruido).
function compileSil(ast, vmRef) {
  expectArity(ast, 1);
  const aC = compileExpr(ast.args[0], vmRef);
  return (pc, state) => {
    silenceChannel(vmRef.synth, aC(state) | 0);
    return pc + 1;
  };
}

// LIM n,x1,y1,x2,y2 — confina al actor (clamp top-left).
function compileLim(ast, vmRef) {
  expectArity(ast, 5);
  const aN = compileExpr(ast.args[0], vmRef);
  const aX1 = compileExpr(ast.args[1], vmRef);
  const aY1 = compileExpr(ast.args[2], vmRef);
  const aX2 = compileExpr(ast.args[3], vmRef);
  const aY2 = compileExpr(ast.args[4], vmRef);
  return (pc, state) => {
    const n = aN(state) | 0;
    const off = n * ACTOR_FIELDS;
    const a = vmRef.spriteState.actors;
    a[off + F_LIM_X1] = aX1(state);
    a[off + F_LIM_Y1] = aY1(state);
    a[off + F_LIM_X2] = aX2(state);
    a[off + F_LIM_Y2] = aY2(state);
    a[off + F_FLAGS] |= FLAG_LIM_ACTIVE;
    return pc + 1;
  };
}

function compileExpr(ast, vmRef) {
  switch (ast.type) {
    case 'num': {
      const v = ast.value;
      return () => v;
    }
    case 'var': {
      const idx = resolveVar(ast.name);
      return (state) => state.vars[idx];
    }
    case 'binop': return compileBinop(ast, vmRef);
    case 'unop':  return compileUnop(ast, vmRef);
    case 'fn':    return compileFnCall(ast, vmRef);
    case 'str':
      throw new Error(`literal de string sólo permitido como arg de TXT`);
    default: throw new Error(`expr desconocida: ${ast.type}`);
  }
}

function compileBinop(ast, vmRef) {
  const l = compileExpr(ast.l, vmRef);
  const r = compileExpr(ast.r, vmRef);
  switch (ast.op) {
    case '+':  return (s) => l(s) + r(s);
    case '-':  return (s) => l(s) - r(s);
    case '*':  return (s) => l(s) * r(s);
    case '/':  return (s) => (l(s) / r(s)) | 0;
    case '%':  return (s) => l(s) % r(s);
    case '<':  return (s) => l(s) <  r(s) ? 1 : 0;
    case '<=': return (s) => l(s) <= r(s) ? 1 : 0;
    case '>':  return (s) => l(s) >  r(s) ? 1 : 0;
    case '>=': return (s) => l(s) >= r(s) ? 1 : 0;
    case '=':  return (s) => l(s) === r(s) ? 1 : 0;
    case '<>': return (s) => l(s) !== r(s) ? 1 : 0;
    case 'Y':  return (s) => (l(s) && r(s)) ? 1 : 0;
    case 'O':  return (s) => (l(s) || r(s)) ? 1 : 0;
    default: throw new Error(`op binario desconocido: ${ast.op}`);
  }
}

function compileUnop(ast, vmRef) {
  const x = compileExpr(ast.x, vmRef);
  switch (ast.op) {
    case '-':  return (s) => -x(s);
    case 'NO': return (s) => x(s) ? 0 : 1;
    default: throw new Error(`op unario desconocido: ${ast.op}`);
  }
}

function compileFnCall(ast, vmRef) {
  // Lectura de arreglo: M0(i) .. M7(i).
  if (/^M[0-7]$/.test(ast.name)) {
    return compileArrayRead(ast, vmRef);
  }
  switch (ast.name) {
    case 'X':    return compileActorRead(ast, vmRef, F_X);
    case 'Y':    return compileActorRead(ast, vmRef, F_Y);
    case 'VX':   return compileActorRead(ast, vmRef, F_VX);
    case 'VY':   return compileActorRead(ast, vmRef, F_VY);
    case 'VIS':  return compileVis(ast, vmRef);
    case 'COL':  return compileCol(ast, vmRef);
    case 'DIS':  return compileDis(ast, vmRef);
    case 'TIL':  return compileTil(ast, vmRef);
    case 'COLM': return compileColm(ast, vmRef);
    case 'PIE':  return compilePie(ast, vmRef);
    case 'BTN':  return compileBtn(ast, vmRef);
    case 'TEC':  return compileTec(ast, vmRef);
    case 'ALE':  return compileAle(ast, vmRef);
    case 'ABS':  return compileUnaryFn(ast, vmRef, (x) => x < 0 ? -x : x);
    case 'SGN':  return compileUnaryFn(ast, vmRef, (x) => x > 0 ? 1 : x < 0 ? -1 : 0);
    case 'RAI':  return compileUnaryFn(ast, vmRef, (x) => x < 0 ? 0 : Math.sqrt(x) | 0);
    case 'SEN':  return compileUnaryFn(ast, vmRef, (g) => Math.round(Math.sin(g * Math.PI / 180) * 1000) | 0);
    case 'COS':  return compileUnaryFn(ast, vmRef, (g) => Math.round(Math.cos(g * Math.PI / 180) * 1000) | 0);
    case 'MIN':  return compileBinaryFn(ast, vmRef, (a, b) => a < b ? a : b);
    case 'MAX':  return compileBinaryFn(ast, vmRef, (a, b) => a > b ? a : b);
    default:
      throw new Error(`función desconocida: ${ast.name}`);
  }
}

function compileAle(ast, vmRef) {
  if (ast.args.length !== 1) throw new Error(`ALE: requiere 1 arg`);
  const aN = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const n = aN(state) | 0;
    if (n <= 0) return 0;
    return nextRandom(state) % n;
  };
}

function compileUnaryFn(ast, vmRef, fn) {
  if (ast.args.length !== 1) throw new Error(`${ast.name}: requiere 1 arg`);
  const a = compileExpr(ast.args[0], vmRef);
  return (state) => fn(a(state)) | 0;
}

function compileBinaryFn(ast, vmRef, fn) {
  if (ast.args.length !== 2) throw new Error(`${ast.name}: requiere 2 args`);
  const a = compileExpr(ast.args[0], vmRef);
  const b = compileExpr(ast.args[1], vmRef);
  return (state) => fn(a(state), b(state)) | 0;
}

function compileActorRead(ast, vmRef, field) {
  if (ast.args.length !== 1) {
    throw new Error(`${ast.name}: requiere 1 arg`);
  }
  const aN = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const n = aN(state) | 0;
    return vmRef.spriteState.actors[n * ACTOR_FIELDS + field];
  };
}

function compileVis(ast, vmRef) {
  if (ast.args.length !== 1) throw new Error(`VIS: requiere 1 arg`);
  const aN = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const n = aN(state) | 0;
    const flags = vmRef.spriteState.actors[n * ACTOR_FIELDS + F_FLAGS];
    return (flags & FLAG_HIDDEN) ? 0 : 1;
  };
}

function compileCol(ast, vmRef) {
  if (ast.args.length !== 2) throw new Error(`COL: requiere 2 args`);
  const a1 = compileExpr(ast.args[0], vmRef);
  const a2 = compileExpr(ast.args[1], vmRef);
  return (state) => aabbCollide(vmRef.spriteState, a1(state) | 0, a2(state) | 0);
}

function compileDis(ast, vmRef) {
  if (ast.args.length !== 2) throw new Error(`DIS: requiere 2 args`);
  const a1 = compileExpr(ast.args[0], vmRef);
  const a2 = compileExpr(ast.args[1], vmRef);
  return (state) => actorDistance(vmRef.spriteState, a1(state) | 0, a2(state) | 0);
}

function compileTil(ast, vmRef) {
  if (ast.args.length !== 3) throw new Error(`TIL: requiere 3 args (m,c,f)`);
  const aM = compileExpr(ast.args[0], vmRef);
  const aC = compileExpr(ast.args[1], vmRef);
  const aR = compileExpr(ast.args[2], vmRef);
  return (state) => readTile(vmRef.mapState, aM(state) | 0, aC(state) | 0, aR(state) | 0);
}

function compileColm(ast, vmRef) {
  if (ast.args.length !== 2) throw new Error(`COLM: requiere 2 args (s,m)`);
  const aS = compileExpr(ast.args[0], vmRef);
  const aM = compileExpr(ast.args[1], vmRef);
  return (state) =>
    actorCollidesMap(vmRef.spriteState, vmRef.mapState, aS(state) | 0, aM(state) | 0,
                     F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
}

function compilePie(ast, vmRef) {
  if (ast.args.length !== 1) throw new Error(`PIE: requiere 1 arg`);
  const aN = compileExpr(ast.args[0], vmRef);
  // Spec: "1 si el actor pisa un tile sólido del mapa enlazado".
  // Usamos el flag actualizado por la fase de física + sample defensivo
  // (por si el usuario consulta antes del primer advance).
  return (state) => {
    const n = aN(state) | 0;
    const off = n * ACTOR_FIELDS;
    const a = vmRef.spriteState.actors;
    if (a[off + F_FLAGS] & FLAG_ON_GROUND) return 1;
    const mapIdx = a[off + F_PHYS_MAP];
    if (mapIdx < 0) return 0;
    return actorOnGround(vmRef.spriteState, vmRef.mapState, n, mapIdx,
                         F_X, F_Y, F_FLAGS, ACTOR_FIELDS, FLAG_HIDDEN);
  };
}

function compileBtn(ast, vmRef) {
  if (ast.args.length !== 1) throw new Error(`BTN: requiere 1 arg`);
  const aB = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const b = aB(state) | 0;
    if (b < 0 || b >= 8) return 0;
    return vmRef.inputState.buttons[b] ? 1 : 0;
  };
}

function compileTec(ast, vmRef) {
  if (ast.args.length !== 1) throw new Error(`TEC: requiere 1 arg`);
  const aK = compileExpr(ast.args[0], vmRef);
  return (state) => {
    const k = aK(state) | 0;
    if (k < 0 || k >= 256) return 0;
    return vmRef.inputState.keys[k] ? 1 : 0;
  };
}

// Re-exports usados por tests.
export { FLAG_HIDDEN, FLAG_FLIP_X, FLAG_FLIP_Y };
