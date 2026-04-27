// Tokeniza una línea sin número (ya viene strippado por el parser top-level).
// Devuelve un Array<Token> donde cada Token = { type, value, col }.
//
// types:
//   'number' — entero positivo
//   'ident'  — A-Z (variable de 1 letra) o nombre tipo M0 .. M7
//   'string' — literal "..."
//   'op'     — + - * / % < <= > >= = <> += -= *= /=
//   'punct'  — , : ( )
//   'kw'     — palabra reservada (SI, ENT, PAR, A, SIG, IR, EN, CUADRO, …)
//
// El comentario ';' se descarta hasta fin de línea; el lexer no devuelve
// tokens para él.

// Las siguientes palabras NO están acá porque son ambiguas con idents:
//   'A'        — separador de PAR vs variable de 1 letra.
//   'Y', 'O'   — operadores lógicos vs función Y(n)/variable Y/literal eje.
//   'NO'       — operador unario; podría ser ident en otros contextos.
// El lexer las emite como ident; el parser las reconoce posicionalmente
// en las capas O/Y/NO y en PAR.
export const KEYWORDS = new Set([
  'SI', 'ENT', 'SINO',
  'PAR', 'SIG',
  'IR', 'LLA', 'RET', 'FIN', 'PAUSA',
  'EN', 'CUADRO', 'LINEA', 'CANAL', 'SILENCIO',
  'INICIOMOTOR', 'INICIOJUEGO', 'CARGANIVEL', 'INICIONIVEL',
  'FINCUADRO', 'REANUDA',
  'NIVEL',
]);

// Builtins disponibles. La firma se valida en el parser/compilador.
// Hito 3: dibujo plano. Hito 4: sprites. Hito 5: mapas+físicas.
// Hito 6: audio. Hito 7: ciclo de vida.
export const BUILTINS = new Set([
  'BOR', 'PIN', 'REC', 'TXT',
  'SPR', 'MOV', 'VEL', 'ANI', 'OCU', 'INV', 'PAT',
  'MAP', 'FON', 'SOL', 'GRA', 'SAL', 'LIM',
  'SON', 'RUI', 'SIL',
  'CARNIV',
  // Memory access (docs/PLAN.md §18).
  'STM', 'STW', 'STR', 'MEMCPY', 'MEMSET',
]);

// Funciones que devuelven un entero, llamables en una expresión.
// El parser detecta el patrón "ident(...)" en parsePrimary; el compilador
// las resuelve por nombre.
export const FUNCTIONS = new Set([
  'COL', 'X', 'Y', 'VX', 'VY', 'VIS', 'DIS',
  'TIL', 'COLM', 'PIE', 'BTN', 'TEC',
  'ALE', 'ABS', 'SGN', 'MIN', 'MAX', 'RAI', 'SEN', 'COS',
  // Memory loads (docs/PLAN.md §17).
  'LDM', 'LDW', 'LDR',
]);

// Variables especiales (read/write o read-only). El parser las trata como
// variables comunes, sólo distinguen en el compilador (slot fijo).
export const SPECIAL_VARS = new Set([
  'VID', 'PUN', 'NIV', 'CUA', 'LIN',
]);

function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlpha(c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
function isAlphaNum(c) { return isAlpha(c) || isDigit(c); }

export function tokenize(line) {
  const tokens = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === ';') break;

    if (isDigit(c)) {
      // Literal hex: 0x... o 0X...
      if (c === '0' && i + 1 < n && (line[i + 1] === 'x' || line[i + 1] === 'X')) {
        let j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(line[j])) j++;
        if (j === i + 2) throw new Error(`Literal hex sin dígitos en columna ${i + 1}`);
        tokens.push({ type: 'number', value: parseInt(line.slice(i + 2, j), 16), col: i });
        i = j;
        continue;
      }
      let j = i;
      while (j < n && isDigit(line[j])) j++;
      tokens.push({ type: 'number', value: parseInt(line.slice(i, j), 10), col: i });
      i = j;
      continue;
    }

    if (isAlpha(c)) {
      let j = i;
      while (j < n && isAlphaNum(line[j])) j++;
      const word = line.slice(i, j).toUpperCase();
      let type;
      if (KEYWORDS.has(word)) type = 'kw';
      else type = 'ident';
      tokens.push({ type, value: word, col: i });
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') j++;
      if (j >= n) throw new Error(`String sin cerrar en columna ${i + 1}`);
      tokens.push({ type: 'string', value: line.slice(i + 1, j), col: i });
      i = j + 1;
      continue;
    }

    // Operadores compuestos primero.
    if (i + 1 < n) {
      const two = line.slice(i, i + 2);
      if (two === '+=' || two === '-=' || two === '*=' || two === '/=' ||
          two === '<=' || two === '>=' || two === '<>') {
        tokens.push({ type: 'op', value: two, col: i });
        i += 2;
        continue;
      }
    }
    if ('+-*/%<>='.includes(c)) {
      tokens.push({ type: 'op', value: c, col: i });
      i++;
      continue;
    }
    if (',:()'.includes(c)) {
      tokens.push({ type: 'punct', value: c, col: i });
      i++;
      continue;
    }
    throw new Error(`Carácter inesperado '${c}' en columna ${i + 1}`);
  }
  return tokens;
}
