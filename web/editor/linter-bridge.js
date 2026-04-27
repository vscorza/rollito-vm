import { linter } from '@codemirror/lint';
import { lint, parseProgram } from '../../src/index.js';

// Conecta el linter del VM con el sistema de diagnostics de CodeMirror.
// - `lint(source)` devuelve warnings de líneas >32 chars.
// - `parseProgram(source)` puede tirar errores con formato "Línea N: ...".
//
// Convertimos ambos a Diagnostic[] de CM con anclaje a la línea correcta.

function lineRangeOfDoc(doc, lineNumber1Based) {
  if (lineNumber1Based < 1 || lineNumber1Based > doc.lines) return null;
  const line = doc.line(lineNumber1Based);
  return { from: line.from, to: line.to };
}

const ERROR_LINE_RE = /^Línea\s+(\d+):/;

export const retroLinter = linter((view) => {
  const diagnostics = [];
  const source = view.state.doc.toString();

  // Warnings del linter (líneas largas).
  try {
    const warnings = lint(source);
    for (const w of warnings) {
      const range = lineRangeOfDoc(view.state.doc, w.line);
      if (!range) continue;
      diagnostics.push({
        from: range.from,
        to: range.to,
        severity: 'warning',
        message: w.message,
      });
    }
  } catch (_) { /* no-op */ }

  // Error de parseo (parser tira en el primer fallo).
  try {
    parseProgram(source);
  } catch (e) {
    const msg = String(e && e.message || e);
    const m = msg.match(ERROR_LINE_RE);
    let range = null;
    if (m) range = lineRangeOfDoc(view.state.doc, parseInt(m[1], 10));
    if (!range) {
      // Sin línea identificada: ancla al inicio del documento.
      range = { from: 0, to: Math.min(view.state.doc.length, 1) };
    }
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: 'error',
      message: msg,
    });
  }

  return diagnostics;
}, {
  delay: 350,  // debounce
});
