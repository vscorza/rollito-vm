import { tokenize, BUILTINS, SPECIAL_VARS } from './lexer.js';
import { parseNoteName } from '../audio/notes.js';

// Eventos de ciclo de vida + audio (otros que CANAL c que tiene firma extendida).
const LIFECYCLE_EVENTS = new Set([
  'INICIOMOTOR', 'INICIOJUEGO', 'CARGANIVEL', 'INICIONIVEL',
  'CUADRO', 'FINCUADRO', 'PAUSA', 'REANUDA',
  'SILENCIO',
]);

// AST de Hito 3:
//
// Top-level del archivo:
//   { header: { JUEGO, AUTOR, VERSION }, lines: [{ lineNumber, source, ast }] }
//
// AST por línea (`ast` field):
//   { type: 'event', event: 'CUADRO', line: 100 }
//   { type: 'goto', line: N }
//   { type: 'gosub', line: N }
//   { type: 'ret' }
//   { type: 'fin' }
//   { type: 'pausa' }
//   { type: 'assign', op: '=' | '+=' | '-=' | '*=' | '/=', target: 'A', expr }
//   { type: 'if', cond, then, else? }   donde then/else son AST de stmt
//   { type: 'for', var: 'I', from: expr, to: expr }
//   { type: 'next' }
//   { type: 'call', name: 'BOR' | 'PIN' | 'REC', args: [expr, ...] }
//   { type: 'seq', stmts: [...] }       ; chain con ':'
//
// Expresiones:
//   { type: 'num', value: N }
//   { type: 'var', name: 'A' | 'CUA' | ... }
//   { type: 'binop', op, l, r }
//   { type: 'unop', op, x }
//
// Reglas de Hito 3:
//   - El parser NO valida que SIG cierre un PAR, ni que IR apunte a una
//     línea existente. Eso es trabajo del compilador.
//   - SI ... ENT <stmt> [SINO <stmt>]: <stmt> es una sola sentencia
//     (no permite ':' anidado).
//   - PROGRAMA marca el inicio del código. Antes va el header.

export function parseProgram(source) {
  const lines = source.split(/\r?\n/);
  const result = {
    header: { JUEGO: '', AUTOR: '', VERSION: '' },
    sprites: [],
    lines: [],
  };

  let i = 0;
  result.maps = [];
  result.sounds = [];
  result.palettes = [];
  while (i < lines.length) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (line === '') { i++; continue; }

    if (line === 'PROGRAMA') { i++; break; }

    const headerMatch = line.match(/^(JUEGO|AUTOR|VERSION)\s+(.+)$/i);
    if (headerMatch) {
      result.header[headerMatch[1].toUpperCase()] = headerMatch[2].trim();
      i++;
      continue;
    }

    const mapMatch = line.match(/^MAPA\s+(\d+)\s+(\d+)x(\d+)$/i);
    if (mapMatch) {
      const idx = parseInt(mapMatch[1], 10);
      const cols = parseInt(mapMatch[2], 10);
      const rows = parseInt(mapMatch[3], 10);
      if (cols <= 0 || rows <= 0) {
        throw new Error(`Línea ${i + 1}: MAPA ${idx} dimensiones inválidas ${cols}x${rows}`);
      }
      const cells = new Uint8Array(cols * rows);
      i++;
      let row = 0;
      while (row < rows && i < lines.length) {
        const rRaw = lines[i];
        const r = stripComment(rRaw).trim();
        if (r === '') { i++; continue; }
        if (r.length !== cols) {
          throw new Error(`Línea ${i + 1}: MAPA ${idx} esperaba ${cols} dígitos, vino ${r.length}`);
        }
        for (let c = 0; c < cols; c++) {
          const ch = r[c];
          const v = parseInt(ch, 16);
          if (Number.isNaN(v)) {
            throw new Error(`Línea ${i + 1}: dígito hex inválido '${ch}' en MAPA ${idx}`);
          }
          cells[row * cols + c] = v;
        }
        i++;
        row++;
      }
      if (row !== rows) {
        throw new Error(`MAPA ${idx}: faltaron filas (esperaba ${rows}, recibió ${row})`);
      }
      result.maps.push({ index: idx, cols, rows, cells });
      continue;
    }

    const sndMatch = line.match(/^SONIDO\s+(\d+)$/i);
    if (sndMatch) {
      const idx = parseInt(sndMatch[1], 10);
      i++;
      const def = parseSoundBody(lines, () => i, (v) => { i = v; }, idx);
      result.sounds.push({ index: idx, ...def });
      continue;
    }

    const palMatch = line.match(/^PALETA\s+(\d+)$/i);
    if (palMatch) {
      const idx = parseInt(palMatch[1], 10);
      if (idx < 0 || idx >= 4) {
        throw new Error(`Línea ${i + 1}: PALETA ${idx} fuera de rango (0..3)`);
      }
      i++;
      const colors = [];
      while (i < lines.length && colors.length < 16) {
        const r = stripComment(lines[i]).trim();
        if (r === '') { i++; continue; }
        const tokens = r.match(/[0-9A-Fa-f]{6}/g);
        if (!tokens) break;
        for (const tk of tokens) {
          colors.push(tk.toUpperCase());
          if (colors.length >= 16) break;
        }
        i++;
      }
      if (colors.length !== 16) {
        throw new Error(`PALETA ${idx}: esperaba 16 colores hex, vino ${colors.length}`);
      }
      result.palettes.push({ index: idx, colors });
      continue;
    }

    const sprMatch = line.match(/^SPRITE\s+(\d+)\s+(\d+)x(\d+)$/i);
    if (sprMatch) {
      const idx = parseInt(sprMatch[1], 10);
      const w = parseInt(sprMatch[2], 10);
      const h = parseInt(sprMatch[3], 10);
      validateSpriteDims(w, h, i + 1);
      const pixels = new Uint8Array(w * h);
      i++;
      let row = 0;
      while (row < h && i < lines.length) {
        const rRaw = lines[i];
        const r = stripComment(rRaw).trim();
        if (r === '') { i++; continue; }
        if (r.length !== w) {
          throw new Error(`Línea ${i + 1}: SPRITE ${idx} esperaba ${w} dígitos hex, vino ${r.length}`);
        }
        for (let c = 0; c < w; c++) {
          const ch = r[c];
          const v = parseInt(ch, 16);
          if (Number.isNaN(v)) {
            throw new Error(`Línea ${i + 1}: dígito hex inválido '${ch}' en SPRITE ${idx}`);
          }
          pixels[row * w + c] = v;
        }
        i++;
        row++;
      }
      if (row !== h) {
        throw new Error(`SPRITE ${idx}: faltaron filas (esperaba ${h}, recibió ${row})`);
      }
      result.sprites.push({ index: idx, width: w, height: h, pixels });
      continue;
    }

    // Header desconocido (PALETA, MAPA, SONIDO en hitos siguientes): saltar.
    i++;
  }

  // Pasada de PROGRAMA.
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripComment(raw).trim();
    if (stripped === '') continue;
    const m = raw.match(/^\s*(\d+)\s*(.*)$/);
    if (!m) {
      throw new Error(`Línea ${i + 1}: se esperaba número de línea, vino "${raw.trim()}"`);
    }
    const lineNumber = parseInt(m[1], 10);
    const rest = stripComment(m[2]).trim();
    if (rest === '') continue;
    const tokens = tokenize(rest);
    const ast = parseLine(tokens, i + 1);
    result.lines.push({ lineNumber, source: raw, ast });
  }
  return result;
}

function validateSpriteDims(w, h, lineNum) {
  const ok = (w === 8 || w === 16) && (h === 8 || h === 16);
  if (!ok) {
    throw new Error(`Línea ${lineNum}: tamaño de sprite ${w}x${h} inválido (válidos: 8x8, 8x16, 16x8, 16x16)`);
  }
}

// Parsea el cuerpo de un bloque SONIDO n hasta encontrar 'FIN'.
// Comandos válidos:
//   ONDA TRI|SIE|PUL|SEN
//   PUL <0..15>
//   ENV <a>,<d>,<s>,<r>
//   NOTA <nota> <ticks>
//   SIL  <ticks>
//   FIN
function parseSoundBody(lines, getI, setI, idx) {
  const def = {
    wave: 'PUL',
    pulseWidth: 0,
    env: { a: 0, d: 0, s: 15, r: 0 },
    steps: [],
  };
  while (getI() < lines.length) {
    const ln = getI() + 1;
    const raw = lines[getI()];
    setI(getI() + 1);
    const line = stripComment(raw).trim();
    if (line === '') continue;
    if (/^FIN$/i.test(line)) return def;

    const ondaMatch = line.match(/^ONDA\s+(TRI|SIE|PUL|SEN)$/i);
    if (ondaMatch) { def.wave = ondaMatch[1].toUpperCase(); continue; }

    const pulMatch = line.match(/^PUL\s+(\d+)$/i);
    if (pulMatch) {
      def.pulseWidth = parseInt(pulMatch[1], 10) & 0x0f;
      continue;
    }

    const envMatch = line.match(/^ENV\s+(\d+),\s*(\d+),\s*(\d+),\s*(\d+)$/i);
    if (envMatch) {
      def.env = {
        a: parseInt(envMatch[1], 10) & 0x0f,
        d: parseInt(envMatch[2], 10) & 0x0f,
        s: parseInt(envMatch[3], 10) & 0x0f,
        r: parseInt(envMatch[4], 10) & 0x0f,
      };
      continue;
    }

    const notaMatch = line.match(/^NOTA\s+([A-Z]+#?b?[0-9])\s+(\d+)$/i);
    if (notaMatch) {
      const parsed = parseNoteName(notaMatch[1]);
      if (!parsed) {
        throw new Error(`Línea ${ln}: nota inválida "${notaMatch[1]}" en SONIDO ${idx}`);
      }
      const ticks = parseInt(notaMatch[2], 10);
      def.steps.push({ type: 'note', semitone: parsed.semitone, octave: parsed.octave, ticks });
      continue;
    }

    const silMatch = line.match(/^SIL\s+(\d+)$/i);
    if (silMatch) {
      def.steps.push({ type: 'silence', ticks: parseInt(silMatch[1], 10) });
      continue;
    }

    throw new Error(`Línea ${ln}: comando "${line}" inválido en SONIDO ${idx}`);
  }
  throw new Error(`SONIDO ${idx}: falta FIN`);
}

function stripComment(s) {
  // Saca todo desde el primer ';' que no esté dentro de un string literal.
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    else if (c === ';' && !inStr) return s.slice(0, i);
  }
  return s;
}

function parseLine(tokens, sourceLine) {
  const p = new Parser(tokens, sourceLine);
  const stmt = p.parseStmtChain();
  if (!p.atEnd()) p.error(`tokens sobrantes`);
  return stmt;
}

class Parser {
  constructor(tokens, sourceLine) { this.t = tokens; this.i = 0; this.sourceLine = sourceLine; }
  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  atEnd() { return this.i >= this.t.length; }
  error(msg) {
    const tok = this.peek() ?? this.t[this.t.length - 1];
    throw new Error(`Línea ${this.sourceLine}: ${msg} en columna ${(tok?.col ?? 0) + 1}`);
  }
  expect(type, value) {
    const tok = this.peek();
    if (!tok || tok.type !== type || (value !== undefined && tok.value !== value)) {
      this.error(`se esperaba ${type}${value !== undefined ? ` "${value}"` : ''}`);
    }
    return this.next();
  }

  parseStmtChain() {
    const first = this.parseStmt();
    if (!this.match('punct', ':')) return first;
    const stmts = [first];
    do {
      stmts.push(this.parseStmt());
    } while (this.match('punct', ':'));
    return { type: 'seq', stmts };
  }

  match(type, value) {
    const tok = this.peek();
    if (!tok || tok.type !== type || (value !== undefined && tok.value !== value)) return false;
    this.next();
    return true;
  }

  parseStmt() {
    const tok = this.peek();
    if (!tok) this.error('línea vacía');
    if (tok.type === 'kw') {
      switch (tok.value) {
        case 'EN':    return this.parseEvent();
        case 'SI':    return this.parseIf();
        case 'PAR':   return this.parseFor();
        case 'SIG':   this.next(); return { type: 'next' };
        case 'IR':    this.next(); return { type: 'goto', line: this.parseLineNumber() };
        case 'LLA':   this.next(); return { type: 'gosub', line: this.parseLineNumber() };
        case 'RET':   this.next(); return { type: 'ret' };
        case 'FIN':   this.next(); return { type: 'fin' };
        case 'PAUSA': this.next(); return { type: 'pausa' };
      }
      this.error(`keyword "${tok.value}" no es inicio de sentencia válido en Hito 3`);
    }
    if (tok.type === 'ident') {
      const next = this.peek(1);
      // Mn(i) = expr — asignación indexada a arreglo.
      if (next && next.type === 'punct' && next.value === '(' &&
          /^M[0-7]$/.test(tok.value)) {
        return this.parseArrayAssign();
      }
      // var = expr / += / -= / *= / /=
      if (next && next.type === 'op' &&
          (next.value === '=' || next.value === '+=' || next.value === '-=' ||
           next.value === '*=' || next.value === '/=')) {
        return this.parseAssign();
      }
      if (BUILTINS.has(tok.value)) return this.parseCall();
      this.error(`identificador "${tok.value}" sin asignación ni builtin conocido`);
    }
    this.error(`token inesperado ${tok.type}`);
  }

  parseLineNumber() {
    const tok = this.expect('number');
    return tok.value;
  }

  parseEvent() {
    this.expect('kw', 'EN');
    const evt = this.expect('kw');
    if (evt.value === 'CANAL') {
      const c = this.expect('number').value;
      this.expect('kw', 'IR');
      return { type: 'event', event: 'CANAL', channel: c, line: this.parseLineNumber() };
    }
    if (LIFECYCLE_EVENTS.has(evt.value)) {
      this.expect('kw', 'IR');
      return { type: 'event', event: evt.value, line: this.parseLineNumber() };
    }
    this.errorAt(evt, `evento "${evt.value}" no soportado`);
  }

  errorAt(tok, msg) {
    throw new Error(`Línea ${this.sourceLine}: ${msg} en columna ${tok.col + 1}`);
  }

  parseAssign() {
    const target = this.expect('ident').value;
    const op = this.expect('op').value;
    const expr = this.parseExpr();
    return { type: 'assign', op, target, expr };
  }

  parseArrayAssign() {
    const name = this.expect('ident').value;
    this.expect('punct', '(');
    const index = this.parseExpr();
    this.expect('punct', ')');
    const opTok = this.expect('op');
    if (!['=', '+=', '-=', '*=', '/='].includes(opTok.value)) {
      this.errorAt(opTok, `se esperaba operador de asignación (=, +=, -=, *=, /=)`);
    }
    const expr = this.parseExpr();
    return { type: 'arrayAssign', array: name, index, op: opTok.value, expr };
  }

  parseCall() {
    const name = this.expect('ident').value;
    const args = [];
    if (!this.atEnd() && !this.peekIs('punct', ':')) {
      args.push(this.parseExpr());
      while (this.match('punct', ',')) args.push(this.parseExpr());
    }
    return { type: 'call', name, args };
  }

  peekIs(type, value) {
    const tok = this.peek();
    return !!(tok && tok.type === type && (value === undefined || tok.value === value));
  }

  parseIf() {
    this.expect('kw', 'SI');
    const cond = this.parseExpr();
    this.expect('kw', 'ENT');
    const thenStmt = this.parseIfAction();
    let elseStmt;
    if (this.match('kw', 'SINO')) {
      elseStmt = this.parseIfAction();
    }
    return { type: 'if', cond, then: thenStmt, else: elseStmt };
  }

  // Acción de un SI: instrucción simple, número de línea (atajo IR), u otro SI.
  parseIfAction() {
    const tok = this.peek();
    if (tok && tok.type === 'number') {
      this.next();
      return { type: 'goto', line: tok.value };
    }
    return this.parseStmt();
  }

  parseFor() {
    this.expect('kw', 'PAR');
    const v = this.expect('ident').value;
    this.expect('op', '=');
    const from = this.parseExpr();
    // Separador 'A': lex como ident.
    const sep = this.peek();
    if (!sep || sep.type !== 'ident' || sep.value !== 'A') {
      this.error(`se esperaba "A" como separador de PAR`);
    }
    this.next();
    const to = this.parseExpr();
    return { type: 'for', var: v, from, to };
  }

  // Precedencia (de menor a mayor): O, Y, NO, comparación, +-, * / %, unario -.
  // O / Y / NO se reconocen como ident por valor (no son keywords del lexer).
  parseExpr()        { return this.parseOr(); }
  parseOr()          { return this.parseLeftAssocIdent(this.parseAnd, ['O']); }
  parseAnd()         { return this.parseLeftAssocIdent(this.parseNot, ['Y']); }
  parseNot() {
    const tok = this.peek();
    if (tok && tok.type === 'ident' && tok.value === 'NO') {
      this.next();
      return { type: 'unop', op: 'NO', x: this.parseNot() };
    }
    return this.parseCmp();
  }
  parseLeftAssocIdent(child, names) {
    let left = child.call(this);
    while (true) {
      const tok = this.peek();
      if (!tok || tok.type !== 'ident' || !names.includes(tok.value)) break;
      this.next();
      const right = child.call(this);
      left = { type: 'binop', op: tok.value, l: left, r: right };
    }
    return left;
  }
  parseCmp() {
    let left = this.parseAdd();
    while (true) {
      const tok = this.peek();
      if (!tok || tok.type !== 'op') break;
      if (!['<', '<=', '>', '>=', '=', '<>'].includes(tok.value)) break;
      this.next();
      const right = this.parseAdd();
      left = { type: 'binop', op: tok.value, l: left, r: right };
    }
    return left;
  }
  parseAdd()  { return this.parseLeftAssocOp(this.parseMul, ['+', '-']); }
  parseMul()  { return this.parseLeftAssocOp(this.parseUnary, ['*', '/', '%']); }

  parseLeftAssocOp(child, ops) {
    let left = child.call(this);
    while (true) {
      const tok = this.peek();
      if (!tok || tok.type !== 'op' || !ops.includes(tok.value)) break;
      this.next();
      const right = child.call(this);
      left = { type: 'binop', op: tok.value, l: left, r: right };
    }
    return left;
  }

  parseUnary() {
    const tok = this.peek();
    if (tok && tok.type === 'op' && tok.value === '-') {
      this.next();
      return { type: 'unop', op: '-', x: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.peek();
    if (!tok) this.error('expresión vacía');
    if (tok.type === 'number') { this.next(); return { type: 'num', value: tok.value }; }
    // String literal (sólo válido como argumento de TXT; el compilador valida).
    if (tok.type === 'string') { this.next(); return { type: 'str', value: tok.value }; }
    if (tok.type === 'ident') {
      this.next();
      // Llamada a función: ident(...)
      if (this.peekIs('punct', '(')) {
        this.next();
        const args = [];
        if (!this.peekIs('punct', ')')) {
          args.push(this.parseExpr());
          while (this.match('punct', ',')) args.push(this.parseExpr());
        }
        this.expect('punct', ')');
        return { type: 'fn', name: tok.value, args };
      }
      return { type: 'var', name: tok.value };
    }
    if (tok.type === 'punct' && tok.value === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect('punct', ')');
      return e;
    }
    this.error(`token inesperado en expresión: ${tok.type} "${tok.value}"`);
  }
}

// Para tests: parsea una sola línea de PROGRAMA (sin número).
export function parseStatement(source) {
  return parseLine(tokenize(source), 1);
}

export { SPECIAL_VARS };
