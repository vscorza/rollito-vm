// Sprites prefabricados. Cada entrada incluye el bloque .retro listo para
// pegar (con un slot placeholder que el usuario puede ajustar antes de
// insertar; lo dejamos como `n` y lo reemplazamos al insertar).

export const SPRITE_DB = [
  {
    name: 'Pelota 8x8',
    description: 'Esfera amarilla rellena',
    width: 8, height: 8,
    rows: [
      '00888800',
      '08888880',
      '88888888',
      '88888888',
      '88888888',
      '88888888',
      '08888880',
      '00888800',
    ],
  },
  {
    name: 'Player ojos abiertos 8x8',
    description: 'Cabezón cyan con ojitos',
    width: 8, height: 8,
    rows: [
      '0CCCCCC0',
      'CCCCCCCC',
      'C0CC0CCC',
      'C0CC0CCC',
      'CCCCCCCC',
      'CCC00CCC',
      'CCCCCCCC',
      '0CCCCCC0',
    ],
  },
  {
    name: 'Player ojos cerrados 8x8',
    description: 'Cabezón con ojos cerrados (frame de animación)',
    width: 8, height: 8,
    rows: [
      '0CCCCCC0',
      'CCCCCCCC',
      'CCCCCCCC',
      'C0CC0CCC',
      'CCCCCCCC',
      'CCC00CCC',
      'CCCCCCCC',
      '0CCCCCC0',
    ],
  },
  {
    name: 'Moneda 8x8',
    description: 'Coin amarillo con borde',
    width: 8, height: 8,
    rows: [
      '00AAAA00',
      '0AAAAAA0',
      'AAAAAAAA',
      'AAAAAAAA',
      'AAAAAAAA',
      'AAAAAAAA',
      '0AAAAAA0',
      '00AAAA00',
    ],
  },
  {
    name: 'Bloque/ladrillo 16x16',
    description: 'Tile gris para floor o paredes (Saltarín)',
    width: 16, height: 16,
    rows: [
      '6666666666666666',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6555555555555556',
      '6666666666666666',
    ],
  },
  {
    name: 'Paleta de Pong 8x16',
    description: 'Barra blanca vertical',
    width: 8, height: 16,
    rows: [
      '07777770',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '77777777',
      '07777770',
    ],
  },
  {
    name: 'Corazón 8x8',
    description: 'Heart rojo (vida)',
    width: 8, height: 8,
    rows: [
      '08008008',
      '88888880',
      '88888888',
      '88888888',
      '88888888',
      '08888880',
      '00888800',
      '00088000',
    ],
  },
  {
    name: 'Enemigo 8x8',
    description: 'Bicho rojo de 4 puntas',
    width: 8, height: 8,
    rows: [
      '00080000',
      '08888000',
      '88808800',
      '80800080',
      '88008888',
      '00880080',
      '00008800',
      '00080000',
    ],
  },
];

export function buildSpriteBlock(slot, sprite) {
  return `SPRITE ${slot} ${sprite.width}x${sprite.height}\n${sprite.rows.join('\n')}\n`;
}

const HEX_DIGITS = '0123456789ABCDEF';

export function listSpriteBlocks(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = stripComment(lines[i]).match(/^\s*SPRITE\s+(\d+)\s+(\d+)x(\d+)\s*$/i);
    if (!m) continue;
    const slot = parseInt(m[1], 10);
    const w = parseInt(m[2], 10);
    const h = parseInt(m[3], 10);
    if (!isValidSpriteSize(w, h)) continue;
    out.push({ slot, w, h, startLine: i });
  }
  return out;
}

export function findSpriteBlock(source, slot) {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = stripComment(lines[i]).match(/^\s*SPRITE\s+(\d+)\s+(\d+)x(\d+)\s*$/i);
    if (!m || parseInt(m[1], 10) !== slot) continue;
    const w = parseInt(m[2], 10);
    const h = parseInt(m[3], 10);
    if (!isValidSpriteSize(w, h)) return null;
    const pixels = new Uint8Array(w * h);
    let row = 0;
    let j = i + 1;
    while (j < lines.length && row < h) {
      const r = stripComment(lines[j]).trim();
      if (r === '') { j++; continue; }
      if (r.length !== w || !/^[0-9A-Fa-f]+$/.test(r)) return null;
      for (let c = 0; c < w; c++) {
        pixels[row * w + c] = parseInt(r[c], 16) & 0x0f;
      }
      row++;
      j++;
    }
    if (row !== h) return null;
    return { slot, w, h, pixels, startLine: i, endLine: j };
  }
  return null;
}

export function formatSpriteBlock(slot, w, h, pixels) {
  const lines = [`SPRITE ${slot} ${w}x${h}`];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      row += HEX_DIGITS[pixels[y * w + x] & 0x0f];
    }
    lines.push(row);
  }
  return lines.join('\n') + '\n';
}

function isValidSpriteSize(w, h) {
  return (w === 8 || w === 16) && (h === 8 || h === 16);
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
