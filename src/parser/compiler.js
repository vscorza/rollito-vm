// Compilador de RollitoVM (v2-A: emite bytecode interpretado).
//
// Antes de v2-A el compilador devolvía closures de JS. Ahora emite
// instrucciones de 32 bits a `vmRef.codeMem`, que el interpreter de
// `src/core/interpreter.js` ejecuta vía fetch/decode/execute.
//
// Encoding y opcodes en `src/core/bytecode.js`. Todas las direcciones
// de salto son bytecode PCs absolutos (24 bits).

import { resolveVar, READONLY_VARS, MEM } from '../core/memory.js';
import { OP, encode } from '../core/bytecode.js';
import { TOTAL_CHANNELS } from '../audio/synth.js';

// =====================================================================
// Compile entrypoint.
//
// Retorna:
//   {
//     code:        Uint32Array de bytecode (subarray sobre vmRef.codeMem),
//     codeLength:  número de words emitidos,
//     constants:   Array (strings y números >24 bits, indexados por LDC),
//     handlers:    { CUADRO: bcPc, INICIONIVEL: bcPc, ..., CANAL: [bcPc..] },
//     lineToIdx:   { lineNumber: bcPc },
//   }
// =====================================================================

export function compile(parseResult, vmRef) {
  const { lines } = parseResult;

  const ctx = {
    code: [],                 // Array<number>; se copia a vmRef.codeMem al final
    constants: [],
    lineToIdx: Object.create(null),
    patches: [],              // jumps a líneas que quizás no se vieron aún
    nestedLevel: 0,           // depth de IF/SI nestado para anti-recursión
  };

  // Pass 1: emitir cada línea no-event, registrando lineToIdx[N] = bcPc actual.
  for (const line of lines) {
    if (line.ast.type === 'event') continue;
    ctx.lineToIdx[line.lineNumber] = ctx.code.length;
    emitStmt(ctx, line.ast, line.lineNumber);
  }
  // HALT al final, por si un handler corre off-the-end.
  emit(ctx, OP.HALT);

  // Pass 2: patchear forward refs a líneas.
  for (const p of ctx.patches) {
    const target = ctx.lineToIdx[p.line];
    if (target === undefined) {
      throw new Error(`línea ${p.fromLine}: salto a línea ${p.line} no existe`);
    }
    const word = ctx.code[p.pos];
    const opcode = word & 0xff;
    ctx.code[p.pos] = encode(opcode, target);
  }

  // Resolver handlers de eventos a bcPc (vía lineToIdx).
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
  for (const line of lines) {
    if (line.ast.type !== 'event') continue;
    const target = ctx.lineToIdx[line.ast.line];
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

  // Copiar el bytecode a una Uint32Array. Si vmRef expone `codeMem` (un
  // Uint8Array de 32 KB respaldando la región CODE), creamos la vista
  // sobre ese buffer así LDM/STM(CODE) leen/escriben las mismas palabras
  // (camino para v2-B self-modifying code). Si no, alocamos un buffer
  // independiente — útil para tests que arman vmRef parciales.
  const codeWords = ctx.code.length;
  const maxWords = (MEM.CODE.size / 4) | 0;
  if (codeWords > maxWords) {
    throw new Error(`programa supera ${maxWords} words (${codeWords} emitidos)`);
  }
  const codeView = vmRef && vmRef.codeMem
    ? new Uint32Array(vmRef.codeMem.buffer, vmRef.codeMem.byteOffset, maxWords)
    : new Uint32Array(maxWords);
  for (let i = 0; i < codeWords; i++) codeView[i] = ctx.code[i] | 0;
  for (let i = codeWords; i < maxWords; i++) codeView[i] = 0;

  return {
    code: codeView,
    codeLength: codeWords,
    constants: ctx.constants,
    handlers,
    lineToIdx: ctx.lineToIdx,
  };
}

// =====================================================================
// Emit helpers.
// =====================================================================

function emit(ctx, opcode, operand = 0) {
  ctx.code.push(encode(opcode, operand));
}

// Marca un slot del código para patchear con la bcPc de una línea
// concreta una vez que conozcamos todas las líneas.
function emitLineRef(ctx, opcode, line, fromLine) {
  ctx.patches.push({ pos: ctx.code.length, line, fromLine });
  emit(ctx, opcode, 0);
}

// Constante literal numérica. Si entra en signed 24-bit, va inline via
// LDI; si no, se va al pool de constantes.
function emitNumLiteral(ctx, value) {
  const v = value | 0;
  if (v >= -(1 << 23) && v < (1 << 23)) {
    emit(ctx, OP.LDI, v);
  } else {
    const idx = ctx.constants.push(v) - 1;
    emit(ctx, OP.LDC, idx);
  }
}

// =====================================================================
// emitStmt — un statement AST → secuencia de bytecode.
// =====================================================================

function emitStmt(ctx, ast, lineNum) {
  switch (ast.type) {
    case 'assign':       return emitAssign(ctx, ast);
    case 'arrayAssign':  return emitArrayAssign(ctx, ast);
    case 'if':           return emitIf(ctx, ast, lineNum);
    case 'for':          return emitFor(ctx, ast);
    case 'next':         return emit(ctx, OP.PARSIG);
    case 'goto':         return emitLineRef(ctx, OP.JMP, ast.line, lineNum);
    case 'gosub':        return emitLineRef(ctx, OP.CALL, ast.line, lineNum);
    case 'ret':          return emit(ctx, OP.RET);
    case 'fin':          return emit(ctx, OP.HALT);
    case 'pausa':        return emit(ctx, OP.PAUSE);
    case 'call':         return emitCall(ctx, ast);
    case 'seq':
      for (const s of ast.stmts) emitStmt(ctx, s, lineNum);
      return;
    default:
      throw new Error(`tipo de AST desconocido: ${ast.type}`);
  }
}

function emitAssign(ctx, ast) {
  if (READONLY_VARS.has(ast.target)) {
    throw new Error(`variable ${ast.target} es read-only`);
  }
  const idx = resolveVar(ast.target);
  emitExpr(ctx, ast.expr);
  switch (ast.op) {
    case '=':  return emit(ctx, OP.STV, idx);
    case '+=': return emit(ctx, OP.ADDV, idx);
    case '-=': return emit(ctx, OP.SUBV, idx);
    case '*=': return emit(ctx, OP.MULV, idx);
    case '/=': return emit(ctx, OP.DIVV, idx);
    default: throw new Error(`op de asignación desconocido: ${ast.op}`);
  }
}

function emitArrayAssign(ctx, ast) {
  const arrayIdx = parseInt(ast.array[1], 10);
  emitExpr(ctx, ast.index);   // push idx
  emitExpr(ctx, ast.expr);    // push val
  switch (ast.op || '=') {
    case '=':  return emit(ctx, OP.STA,  arrayIdx);
    case '+=': return emit(ctx, OP.ADDA, arrayIdx);
    case '-=': return emit(ctx, OP.SUBA, arrayIdx);
    case '*=': return emit(ctx, OP.MULA, arrayIdx);
    case '/=': return emit(ctx, OP.DIVA, arrayIdx);
    default: throw new Error(`op de asignación de arreglo desconocido: ${ast.op}`);
  }
}

function emitIf(ctx, ast, lineNum) {
  emitExpr(ctx, ast.cond);
  // JZ → salta a "else" (o al fin si no hay else).
  const jzPos = ctx.code.length;
  emit(ctx, OP.JZ, 0);  // se patchea más abajo
  emitStmt(ctx, ast.then, lineNum);
  if (ast.else) {
    const jmpEndPos = ctx.code.length;
    emit(ctx, OP.JMP, 0);
    // else target = aquí.
    ctx.code[jzPos] = encode(OP.JZ, ctx.code.length);
    emitStmt(ctx, ast.else, lineNum);
    ctx.code[jmpEndPos] = encode(OP.JMP, ctx.code.length);
  } else {
    ctx.code[jzPos] = encode(OP.JZ, ctx.code.length);
  }
}

function emitFor(ctx, ast) {
  const varIdx = resolveVar(ast.var);
  emitExpr(ctx, ast.from);
  emit(ctx, OP.STV, varIdx);
  emitExpr(ctx, ast.to);
  emit(ctx, OP.PARINIT, varIdx);
}

// =====================================================================
// emitCall — statement builtins.
// =====================================================================

function emitCall(ctx, ast) {
  switch (ast.name) {
    case 'BOR': return emitFixed(ctx, ast, 1, OP.BOR);
    case 'PIN': return emitFixed(ctx, ast, 3, OP.PIN);
    case 'REC': return emitFixed(ctx, ast, 5, OP.REC);
    case 'TXT': return emitTxt(ctx, ast);

    case 'SPR':  return emitSpr(ctx, ast);
    case 'SPRR': return emitFixed(ctx, ast, 5, OP.SPRR);
    case 'SPRA': return emitFixed(ctx, ast, 4, OP.SPRA);
    case 'MOV': return emitFixed(ctx, ast, 3, OP.MOV);
    case 'VEL': return emitFixed(ctx, ast, 3, OP.VEL);
    case 'ANI': return emitFixed(ctx, ast, 4, OP.ANI);
    case 'OCU': return emitFixed(ctx, ast, 2, OP.OCU);
    case 'INV': return emitInv(ctx, ast);
    case 'PAT': return emitFixed(ctx, ast, 2, OP.PAT);

    case 'MAP': return emitMap(ctx, ast);
    case 'FON': return emitFixed(ctx, ast, 1, OP.FON);
    case 'SOL': return emitSol(ctx, ast);
    case 'GRA': return emitFixed(ctx, ast, 3, OP.GRA);
    case 'SAL': return emitFixed(ctx, ast, 2, OP.SAL);
    case 'LIM': return emitFixed(ctx, ast, 5, OP.LIM);

    case 'SON': return emitFixed(ctx, ast, 2, OP.SON);
    case 'RUI': return emitFixed(ctx, ast, 1, OP.RUI);
    case 'SIL': return emitFixed(ctx, ast, 1, OP.SIL);

    case 'CARNIV': return emitFixed(ctx, ast, 1, OP.CARNIV);
    case 'PAL':    return emitFixed(ctx, ast, 1, OP.PAL);

    case 'STM':    return emitFixed(ctx, ast, 2, OP.STM);
    case 'STW':    return emitFixed(ctx, ast, 2, OP.STW);
    case 'STR':    return emitFixed(ctx, ast, 4, OP.STR);
    case 'MEMCPY': return emitFixed(ctx, ast, 3, OP.MEMCPY);
    case 'MEMSET': return emitFixed(ctx, ast, 3, OP.MEMSET);

    default:
      throw new Error(`builtin desconocido: ${ast.name}`);
  }
}

function emitFixed(ctx, ast, arity, opcode) {
  if (ast.args.length !== arity) {
    throw new Error(`${ast.name} requiere ${arity} args, recibió ${ast.args.length}`);
  }
  for (const arg of ast.args) emitExpr(ctx, arg);
  emit(ctx, opcode);
}

// TXT acepta 3 o 4 args (el 4to es color). Encodeamos siempre 4 con
// color default 1 si falta. El string va al pool de constantes.
function emitTxt(ctx, ast) {
  if (ast.args.length !== 3 && ast.args.length !== 4) {
    throw new Error(`TXT requiere 3 o 4 args (x,y,"...",c?)`);
  }
  const strAst = ast.args[2];
  if (strAst.type !== 'str') {
    throw new Error(`TXT: tercer arg debe ser literal de string`);
  }
  emitExpr(ctx, ast.args[0]);
  emitExpr(ctx, ast.args[1]);
  const strIdx = ctx.constants.push(strAst.value) - 1;
  emit(ctx, OP.LDI, strIdx);
  if (ast.args.length === 4) emitExpr(ctx, ast.args[3]);
  else emit(ctx, OP.LDI, 1);  // color default
  emit(ctx, OP.TXT);
}

// SPR acepta 3 (sin flags) o 4 (con flags). Encodeamos siempre 4 con
// flags default 0.
function emitSpr(ctx, ast) {
  if (ast.args.length !== 3 && ast.args.length !== 4) {
    throw new Error(`SPR requiere 3 o 4 args, recibió ${ast.args.length}`);
  }
  emitExpr(ctx, ast.args[0]);
  emitExpr(ctx, ast.args[1]);
  emitExpr(ctx, ast.args[2]);
  if (ast.args.length === 4) emitExpr(ctx, ast.args[3]);
  else emit(ctx, OP.LDI, 0);
  emit(ctx, OP.SPR);
}

// MAP n,x,y[,a]. 3 args = sin blend; 4to arg opcional = alpha 0..15.
function emitMap(ctx, ast) {
  if (ast.args.length !== 3 && ast.args.length !== 4) {
    throw new Error(`MAP requiere 3 o 4 args, recibió ${ast.args.length}`);
  }
  emitExpr(ctx, ast.args[0]);
  emitExpr(ctx, ast.args[1]);
  emitExpr(ctx, ast.args[2]);
  if (ast.args.length === 4) emitExpr(ctx, ast.args[3]);
  else emit(ctx, OP.LDI, 0);
  emit(ctx, OP.MAP_);
}

// INV n,X | INV n,Y. Eje codificado en el operand (0=X, 1=Y).
function emitInv(ctx, ast) {
  if (ast.args.length !== 2) {
    throw new Error(`INV requiere 2 args (n, X|Y)`);
  }
  const axisAst = ast.args[1];
  if (axisAst.type !== 'var' || (axisAst.name !== 'X' && axisAst.name !== 'Y')) {
    throw new Error(`INV: segundo arg debe ser X o Y (eje), no expresión`);
  }
  emitExpr(ctx, ast.args[0]);
  emit(ctx, OP.INV, axisAst.name === 'X' ? 0 : 1);
}

// SOL m,t1,t2,...,tN. Operand = arity total (mapa + tiles), >= 2.
function emitSol(ctx, ast) {
  if (ast.args.length < 2) {
    throw new Error(`SOL requiere al menos 2 args (mapa y un tile)`);
  }
  for (const arg of ast.args) emitExpr(ctx, arg);
  emit(ctx, OP.SOL, ast.args.length);
}

// =====================================================================
// emitExpr — expresión AST → secuencia que deja 1 valor en el stack.
// =====================================================================

function emitExpr(ctx, ast) {
  switch (ast.type) {
    case 'num': return emitNumLiteral(ctx, ast.value);
    case 'var': return emit(ctx, OP.LDV, resolveVar(ast.name));
    case 'binop': return emitBinop(ctx, ast);
    case 'unop':  return emitUnop(ctx, ast);
    case 'fn':    return emitFnCall(ctx, ast);
    case 'str':
      throw new Error(`literal de string sólo permitido como arg de TXT`);
    default:
      throw new Error(`expr desconocida: ${ast.type}`);
  }
}

const BINOP_OPCODES = {
  '+':  OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD,
  '<':  OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE,
  '=':  OP.EQ, '<>': OP.NE,
  'Y':  OP.AND, 'O': OP.OR,
};

function emitBinop(ctx, ast) {
  const op = BINOP_OPCODES[ast.op];
  if (op === undefined) throw new Error(`op binario desconocido: ${ast.op}`);
  emitExpr(ctx, ast.l);
  emitExpr(ctx, ast.r);
  emit(ctx, op);
}

function emitUnop(ctx, ast) {
  emitExpr(ctx, ast.x);
  switch (ast.op) {
    case '-':  return emit(ctx, OP.NEG);
    case 'NO': return emit(ctx, OP.NOT);
    default: throw new Error(`op unario desconocido: ${ast.op}`);
  }
}

function emitFnCall(ctx, ast) {
  // Mn(i): array read.
  if (/^M[0-7]$/.test(ast.name)) {
    if (ast.args.length !== 1) {
      throw new Error(`${ast.name}: requiere 1 índice`);
    }
    const arrayIdx = parseInt(ast.name[1], 10);
    emitExpr(ctx, ast.args[0]);
    emit(ctx, OP.LDA, arrayIdx);
    return;
  }
  switch (ast.name) {
    case 'X':    return emitFn(ctx, ast, 1, OP.X_);
    case 'Y':    return emitFn(ctx, ast, 1, OP.Y_);
    case 'VX':   return emitFn(ctx, ast, 1, OP.VX_);
    case 'VY':   return emitFn(ctx, ast, 1, OP.VY_);
    case 'VIS':  return emitFn(ctx, ast, 1, OP.VIS);
    case 'COL':  return emitFn(ctx, ast, 2, OP.COL);
    case 'DIS':  return emitFn(ctx, ast, 2, OP.DIS);
    case 'TIL':  return emitFn(ctx, ast, 3, OP.TIL);
    case 'COLM': return emitFn(ctx, ast, 2, OP.COLM);
    case 'PIE':  return emitFn(ctx, ast, 1, OP.PIE);
    case 'BTN':  return emitFn(ctx, ast, 1, OP.BTN);
    case 'TEC':  return emitFn(ctx, ast, 1, OP.TEC);
    case 'ALE':  return emitFn(ctx, ast, 1, OP.ALE);
    case 'ABS':  return emitFn(ctx, ast, 1, OP.ABS_F);
    case 'SGN':  return emitFn(ctx, ast, 1, OP.SGN);
    case 'RAI':  return emitFn(ctx, ast, 1, OP.RAI);
    case 'SEN':  return emitFn(ctx, ast, 1, OP.SEN);
    case 'COS':  return emitFn(ctx, ast, 1, OP.COS);
    case 'MIN':  return emitFn(ctx, ast, 2, OP.MIN);
    case 'MAX':  return emitFn(ctx, ast, 2, OP.MAX);
    case 'LDM':  return emitFn(ctx, ast, 1, OP.LDM);
    case 'LDW':  return emitFn(ctx, ast, 1, OP.LDW);
    case 'LDR':  return emitFn(ctx, ast, 3, OP.LDR);
    default:
      throw new Error(`función desconocida: ${ast.name}`);
  }
}

function emitFn(ctx, ast, arity, opcode) {
  if (ast.args.length !== arity) {
    throw new Error(`${ast.name}: requiere ${arity} arg${arity === 1 ? '' : 's'}`);
  }
  for (const arg of ast.args) emitExpr(ctx, arg);
  emit(ctx, opcode);
}
