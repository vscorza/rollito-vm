import { describe, it } from 'vitest';

// Reference game: plataformero estilo Pitfall!
//
// Cubre: mapas grandes, gravedad, salto, hazards, animación de actor,
// scroll horizontal o cambio de pantalla, paleta por nivel, melodía
// de fondo, PAT para clones de enemigo.
//
// Habilitado cuando: existan parser (Hito 3), sprites (Hito 4),
// mapas+físicas (Hito 5) y audio (Hito 6). El .retro vive en
// games/pitfall.retro y aún no está creado.
//
// Cuando se active:
//   1. Cargar games/pitfall.retro como string.
//   2. createHeadlessVM con seed fijo y secuencia de inputs scripted
//      que recorra al menos 1 nivel completo.
//   3. Capturar framebuffer cada N cuadros y comparar contra
//      games/pitfall.golden (hashes).
//   4. Validar que exitCode = 0 y que sonó la melodía esperada.

describe.skip('reference game: pitfall (waiting on Hito 8)', () => {
  it('corre 1 nivel completo con framebuffer dorado', () => {
    // TODO Hito 8.
  });
});
