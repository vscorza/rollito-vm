import { StreamLanguage } from '@codemirror/language';
import { KEYWORDS, BUILTINS, FUNCTIONS } from '../../src/parser/lexer.js';

// Top-level block keywords (header del archivo, fuera de PROGRAMA).
const BLOCK_KEYWORDS = new Set([
  'JUEGO', 'AUTOR', 'VERSION',
  'PALETA', 'SPRITE', 'MAPA', 'SONIDO',
  'PROGRAMA',
  'ONDA', 'ENV', 'NOTA', 'PUL', 'SIL', 'FIN',
  'TRI', 'SIE', 'SEN',
]);

const SPECIAL_VARS = new Set(['CUA', 'PUN', 'NIV', 'VID', 'LIN']);

// Tokenizer simple para .retro. Devuelve nombres de tags estándar de CodeMirror;
// el HighlightStyle del tema los mapea a colores.
export const retroLanguage = StreamLanguage.define({
  name: 'retro',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;

    // Comentarios hasta fin de línea.
    if (stream.match(/;.*$/)) return 'comment';

    // String literal (sólo argumento de TXT).
    if (stream.match(/"[^"]*"/)) return 'string';

    // Línea numerada al inicio de la línea — la marcamos como meta para
    // distinguirla del resto.
    if (stream.sol() && stream.match(/\d+\b/)) return 'meta';

    // Operadores compuestos primero.
    if (stream.match(/(<=|>=|<>|\+=|-=|\*=|\/=)/)) return 'operator';
    if (stream.match(/[+\-*/%<>=]/)) return 'operator';

    // Puntuación.
    if (stream.match(/[(),:]/)) return 'punctuation';

    // Números.
    if (stream.match(/\d+/)) return 'number';

    // Identificador. Lookup case-insensitive contra los sets del lexer.
    if (stream.match(/[A-Za-z][A-Za-z0-9]*/)) {
      const word = stream.current().toUpperCase();
      if (BLOCK_KEYWORDS.has(word)) return 'keyword';
      if (KEYWORDS.has(word))       return 'keyword';
      if (BUILTINS.has(word))       return 'typeName';
      if (FUNCTIONS.has(word))      return 'function';
      if (/^M[0-7]$/.test(word))    return 'variableName';
      if (/^[A-Z]$/.test(word))     return 'variableName';
      if (SPECIAL_VARS.has(word))   return 'variableName';
      return 'atom';
    }

    stream.next();
    return null;
  },
});
