import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';

// Mide el costo de runFrame() bajo el intérprete bytecode (v2-A).
// Reemplaza al cálculo de "≤4ms/cuadro" de §11.9 — el bytecode quemó
// ese budget a cambio de fidelidad al modelo de hardware ficticio.
//
// Reportado para comparar entre versiones; la suite NO corre en CI
// (sólo `npm run test:perf`).
//
// Baseline 2026-04-27, Apple M-series, Node 23/24:
//   pelota:    ~10800 fps  ( 92 µs/frame,  49 words)
//   pong:       ~7400 fps  (136 µs/frame, 230 words)
//   saltarin:   ~9600 fps  (105 µs/frame, 141 words)
//   memoria:    ~4000 fps  (250 µs/frame, 346 words)
//   serpiente:  ~8500 fps  (118 µs/frame, 330 words)
//   mario-mini: ~7700 fps  (130 µs/frame, 315 words)
//   espacial:   ~4100 fps  (245 µs/frame, 414 words)
//   camaleon:   ~9000 fps  (111 µs/frame, 246 words)
//
// El frame budget real (60 fps) es 16.7 ms. El más lento (memoria) está
// a 250 µs/frame = 67x más rápido que el budget. El threshold mínimo
// queda en 2500 fps (400 µs/frame, ~40x sobre el budget) para tener
// margen en máquinas más lentas y futuras regresiones.

const here = dirname(fileURLToPath(import.meta.url));
function loadGame(name) {
  return readFileSync(resolve(here, '../../games', `${name}.retro`), 'utf8');
}

const FRAMES = 1000;
const MIN_FPS = 2500;

const GAMES = ['pelota', 'pong', 'saltarin', 'memoria', 'serpiente',
               'mario-mini', 'espacial', 'camaleon'];

describe('runFrame throughput por juego (v2-A bytecode)', () => {
  for (const name of GAMES) {
    it(`${name}: ≥ ${MIN_FPS} cuadros/s`, () => {
      const src = loadGame(name);
      const vm = createVM(src, { seed: 42 });
      // warmup
      for (let i = 0; i < 60; i++) vm.runFrame();

      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) vm.runFrame();
      const t1 = performance.now();

      const ms = t1 - t0;
      const fps = (FRAMES * 1000) / ms;
      const usPerFrame = (ms * 1000) / FRAMES;
      console.log(
        `[bench ${name.padEnd(11, ' ')}] ${FRAMES} cuadros en ${ms.toFixed(2)} ms ` +
        `→ ${fps.toFixed(0)} fps (${usPerFrame.toFixed(1)} µs/frame, ` +
        `${vm.codeLength} words)`
      );
      expect(fps).toBeGreaterThan(MIN_FPS);
    });
  }
});
