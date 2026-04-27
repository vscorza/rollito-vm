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
