import { describe, it } from 'vitest';

// Reference game: billar (bolas que rebotan e interactúan).
//
// Cubre: múltiples actores con física continua, colisiones entre
// actores con reflexión vectorial, INV n,EJE para rebotes, tabla
// SEN/COS en escala 1000, sonido por colisión bola-bola y
// bola-banda.
//
// Habilitado cuando: existan parser (Hito 3) y sprites+colisiones
// (Hito 4). No requiere mapas ni audio para una versión mínima
// (audio sólo para la versión "completa"). El .retro vive en
// games/billar.retro y aún no está creado.
//
// Cuando se active:
//   1. Cargar games/billar.retro.
//   2. createHeadlessVM con seed fijo y un "tiro inicial" que
//      dispare la bola blanca contra el triángulo.
//   3. Correr 600 cuadros (10 s virtuales) y comparar framebuffer
//      dorado en cuadros 60, 180, 300, 600.
//   4. Validar que el número de colisiones bola-bola registradas
//      coincide con un valor esperado (estresa la robustez del
//      detector AABB de docs/PLAN.md §8.4).

describe.skip('reference game: billar (waiting on Hito 8)', () => {
  it('resuelve un break con framebuffer dorado a 60/180/300/600', () => {
    // TODO Hito 8.
  });
});
