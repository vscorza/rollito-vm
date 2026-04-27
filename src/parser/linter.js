// Linter de Hito 3: emite warnings cuando una línea del bloque PROGRAMA
// supera 32 caracteres "útiles" (sin contar el comentario `;` y posterior).
// docs/PLAN.md §10: el parser no rechaza líneas más largas; el linter sí
// avisa. Las líneas que arrancan con ';' (comentario completo) no cuentan.

export const MAX_LINE_LENGTH = 32;

export function lint(source) {
  const warnings = [];
  const lines = source.split(/\r?\n/);
  let inProgram = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === 'PROGRAMA') { inProgram = true; continue; }
    if (!inProgram) continue;
    if (trimmed === '' || trimmed.startsWith(';')) continue;

    const useful = stripTrailingComment(raw).replace(/\s+$/, '');
    if (useful.length > MAX_LINE_LENGTH) {
      warnings.push({
        line: i + 1,
        length: useful.length,
        message: `línea de ${useful.length} chars supera el límite de ${MAX_LINE_LENGTH}`,
        source: raw,
      });
    }
  }
  return warnings;
}

function stripTrailingComment(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    else if (c === ';' && !inStr) return s.slice(0, i);
  }
  return s;
}
