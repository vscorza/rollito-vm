// Paletas predefinidas para insertar/cargar en el editor.
// Cada una es exactamente 16 colores hex de 6 dígitos en mayúsculas.

export const PALETTE_DB = [
  {
    name: 'PICO-8',
    description: 'Default del VM, 16 colores estilo PICO-8',
    colors: [
      '000000', '1D2B53', '7E2553', '008751',
      'AB5236', '5F574F', 'C2C3C7', 'FFF1E8',
      'FF004D', 'FFA300', 'FFEC27', '00E436',
      '29ADFF', '83769C', 'FF77A8', 'FFCCAA',
    ],
  },
  {
    name: 'Game Boy',
    description: '4 verdes clásicos × 4 saturaciones',
    colors: [
      '0F380F', '306230', '8BAC0F', '9BBC0F',
      '0F1F0F', '1F4F1F', '6F8C0F', '8FAC2F',
      '00200F', '003F1F', '4F7F0F', '6F9F1F',
      '0F300F', '255022', '7CAA00', 'A8C800',
    ],
  },
  {
    name: 'CGA Mode 4 (Pal 1)',
    description: 'IBM CGA: cyan/magenta/blanco repetidos en 4 brillos',
    colors: [
      '000000', '55FFFF', 'FF55FF', 'FFFFFF',
      '000000', '00AAAA', 'AA00AA', 'AAAAAA',
      '000055', '5555FF', 'AA55FF', 'AAFFFF',
      '550000', 'AA5500', 'AA0055', 'FF5555',
    ],
  },
  {
    name: 'ZX Spectrum',
    description: '8 colores bright + 8 colores normal',
    colors: [
      '000000', '0000C0', 'C00000', 'C000C0',
      '00C000', '00C0C0', 'C0C000', 'C0C0C0',
      '000000', '0000FF', 'FF0000', 'FF00FF',
      '00FF00', '00FFFF', 'FFFF00', 'FFFFFF',
    ],
  },
  {
    name: 'Sweet 16',
    description: 'Pasteles cálidos, alta saturación',
    colors: [
      '0F0E17', '232133', 'F25F5C', 'FFE066',
      '247BA0', '70C1B3', 'B2DBBF', 'F3FFBD',
      'FF7F11', 'BEB7A4', '5BC8AF', 'C97064',
      'A45D5D', 'FF5733', '900C3F', 'FFC0CB',
    ],
  },
  {
    name: 'Mono verde fosforito',
    description: 'CRT viejo: 16 tonos de verde',
    colors: [
      '000000', '001000', '002000', '003000',
      '004500', '005500', '006A00', '008000',
      '009500', '00A500', '00BA00', '00CC00',
      '00DD00', '50DD30', '90EE60', 'D0FFA0',
    ],
  },
];

// Devuelve el bloque PALETA n listo para pegar en el editor.
export function buildPaletteBlock(slot, colors) {
  const lines = [`PALETA ${slot}`];
  // 4 filas × 4 colores cada una.
  for (let row = 0; row < 4; row++) {
    const part = colors.slice(row * 4, row * 4 + 4).join(' ');
    lines.push(part);
  }
  return lines.join('\n') + '\n';
}

// Parsea un bloque PALETA n del documento; devuelve { slot, colors }
// o null si no se encuentra.
export function findPaletteBlock(source, slot) {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*PALETA\s+(\d+)\b/i);
    if (m && parseInt(m[1], 10) === slot) {
      const startLine = i;
      const colors = [];
      i++;
      while (i < lines.length && colors.length < 16) {
        const tokens = lines[i].trim().match(/[0-9A-Fa-f]{6}/g);
        if (tokens) {
          for (const tk of tokens) {
            colors.push(tk.toUpperCase());
            if (colors.length >= 16) break;
          }
          i++;
        } else if (lines[i].trim() === '') {
          i++;
        } else {
          break;
        }
      }
      if (colors.length === 16) {
        return { slot, colors, startLine, endLine: i };
      }
      return null;
    }
    i++;
  }
  return null;
}
