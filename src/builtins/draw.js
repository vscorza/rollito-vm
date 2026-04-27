import { WIDTH, HEIGHT } from '../render/framebuffer.js';

// Cada builtin recibe (fb, ...args) y modifica fb in-place. Los args vienen
// como enteros JS (siempre se pasan por valor). El compilador conoce la
// firma (cantidad de args) y emite la closure que pasa cada arg ya evaluado.

export const DRAW_BUILTINS = {
  // BOR c — borra la pantalla con el color c.
  BOR: { arity: 1, fn: (fb, c) => fb.fill(c & 0x0f) },

  // PIN x,y,c — pinta un pixel. Coordenadas fuera de pantalla se descartan
  // silenciosamente (clipping en escritor, docs/PLAN.md §4.3).
  PIN: {
    arity: 3,
    fn: (fb, x, y, c) => {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      fb[y * WIDTH + x] = c & 0x0f;
    },
  },

  // REC x,y,w,h,c — rectángulo relleno. Clipping al rectángulo de pantalla.
  REC: {
    arity: 5,
    fn: (fb, x, y, w, h, c) => {
      const ci = c & 0x0f;
      let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > WIDTH) x1 = WIDTH;
      if (y1 > HEIGHT) y1 = HEIGHT;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * WIDTH;
        for (let xx = x0; xx < x1; xx++) {
          fb[row + xx] = ci;
        }
      }
    },
  },
};
