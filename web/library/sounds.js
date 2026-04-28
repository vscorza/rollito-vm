// Sonidos prefabricados. Cada entrada lleva un bloque SONIDO listo para
// pegar al cursor. El slot se inyecta al insertar.

export const SOUND_DB = [
  {
    name: 'Salto (arpegio ascendente)',
    description: 'PUL corto, 3 notas que suben — Saltarín',
    block: `SONIDO {n}
ONDA PUL
PUL 8
ENV 0,2,8,2
NOTA DO5 3
NOTA SOL5 3
NOTA DO6 3
FIN
`,
  },
  {
    name: 'Aterrizaje (thud grave)',
    description: 'Sierra con release lento, sonido de impacto',
    block: `SONIDO {n}
ONDA SIE
ENV 0,4,0,2
NOTA DO3 6
FIN
`,
  },
  {
    name: 'Pickup moneda',
    description: 'Senoidal corta y aguda, perfecta para pickup',
    block: `SONIDO {n}
ONDA SEN
ENV 0,1,12,2
NOTA SOL5 2
NOTA DO6 4
FIN
`,
  },
  {
    name: 'Click UI',
    description: 'Cuadrada muy corta',
    block: `SONIDO {n}
ONDA PUL
PUL 4
ENV 0,1,12,2
NOTA DO5 2
FIN
`,
  },
  {
    name: 'Game Over',
    description: 'Caída cromática descendente',
    block: `SONIDO {n}
ONDA SIE
ENV 0,4,0,4
NOTA DO3 8
NOTA FA2 12
FIN
`,
  },
  {
    name: 'Disparo láser',
    description: 'Caída rápida de tonos altos',
    block: `SONIDO {n}
ONDA PUL
PUL 2
ENV 0,1,8,1
NOTA DO7 1
NOTA LA6 1
NOTA FA6 1
NOTA DO6 2
FIN
`,
  },
  {
    name: 'Power up (3 notas)',
    description: 'Triangular ascendente alegre',
    block: `SONIDO {n}
ONDA TRI
ENV 0,2,12,3
NOTA DO5 3
NOTA MI5 3
NOTA SOL5 3
NOTA DO6 6
FIN
`,
  },
];

export function buildSoundBlock(slot, sound) {
  return sound.block.replace('{n}', slot);
}

const NOTE_NAMES_VALID = new Set(['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI']);

export function listSoundBlocks(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = stripComment(lines[i]).match(/^\s*SONIDO\s+(\d+)\s*$/i);
    if (!m) continue;
    out.push({ slot: parseInt(m[1], 10), startLine: i });
  }
  return out;
}

export function findSoundBlock(source, slot) {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = stripComment(lines[i]).match(/^\s*SONIDO\s+(\d+)\s*$/i);
    if (!m || parseInt(m[1], 10) !== slot) continue;
    const def = {
      wave: 'PUL',
      pulseWidth: 8,
      env: { a: 0, d: 2, s: 8, r: 2 },
      steps: [],
    };
    let j = i + 1;
    while (j < lines.length) {
      const r = stripComment(lines[j]).trim();
      j++;
      if (r === '') continue;
      if (/^FIN$/i.test(r)) {
        return { slot, def, startLine: i, endLine: j };
      }
      const mw = r.match(/^ONDA\s+(TRI|SIE|PUL|SEN)$/i);
      if (mw) { def.wave = mw[1].toUpperCase(); continue; }
      const mp = r.match(/^PUL\s+(\d+)$/i);
      if (mp) { def.pulseWidth = parseInt(mp[1], 10) & 0x0f; continue; }
      const me = r.match(/^ENV\s+(\d+),\s*(\d+),\s*(\d+),\s*(\d+)$/i);
      if (me) {
        def.env = {
          a: parseInt(me[1], 10) & 0x0f,
          d: parseInt(me[2], 10) & 0x0f,
          s: parseInt(me[3], 10) & 0x0f,
          r: parseInt(me[4], 10) & 0x0f,
        };
        continue;
      }
      const mn = r.match(/^NOTA\s+([A-Za-z]+)(#|b)?(\d)\s+(\d+)$/i);
      if (mn) {
        const name = mn[1].toUpperCase();
        if (!NOTE_NAMES_VALID.has(name)) return null;
        def.steps.push({
          type: 'note',
          name,
          acc: mn[2] || '',
          octave: parseInt(mn[3], 10),
          ticks: parseInt(mn[4], 10),
        });
        continue;
      }
      const ms = r.match(/^SIL\s+(\d+)$/i);
      if (ms) {
        def.steps.push({ type: 'silence', ticks: parseInt(ms[1], 10) });
        continue;
      }
      return null;
    }
    return null;
  }
  return null;
}

export function formatSoundBlock(slot, def) {
  const lines = [`SONIDO ${slot}`, `ONDA ${def.wave}`];
  if (def.wave === 'PUL') lines.push(`PUL ${def.pulseWidth}`);
  lines.push(`ENV ${def.env.a},${def.env.d},${def.env.s},${def.env.r}`);
  for (const s of def.steps) {
    if (s.type === 'silence') {
      lines.push(`SIL ${s.ticks}`);
    } else {
      lines.push(`NOTA ${s.name}${s.acc}${s.octave} ${s.ticks}`);
    }
  }
  lines.push('FIN');
  return lines.join('\n') + '\n';
}

function stripComment(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    else if (c === ';' && !inStr) return s.slice(0, i);
  }
  return s;
}
