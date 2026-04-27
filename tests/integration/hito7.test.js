import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import { VAR_INDEX } from '../../src/core/memory.js';
import { F_X, F_FLAGS, FLAG_HIDDEN, ACTOR_FIELDS } from '../../src/core/sprites.js';

const here = dirname(fileURLToPath(import.meta.url));
const retroPath = resolve(here, '../../games/hito7.retro');
const source = readFileSync(retroPath, 'utf8');

describe('hito7.retro: ciclo de vida + ALE', () => {
  it('INICIOJUEGO + INICIONIVEL al primer cuadro: player visible y coin spawneado', () => {
    const vm = createVM(source, { seed: 1 });
    vm.runFrame();
    const a = vm.spriteState.actors;
    // Player (slot 0) visible.
    expect(a[F_FLAGS] & FLAG_HIDDEN).toBe(0);
    // Coin (slot 3) visible (spawneado por INICIONIVEL → 800).
    expect(a[3 * ACTOR_FIELDS + F_FLAGS] & FLAG_HIDDEN).toBe(0);
  });

  it('mismo seed → misma posición de coin', () => {
    const a = createVM(source, { seed: 7 });
    const b = createVM(source, { seed: 7 });
    a.runFrame(); b.runFrame();
    const ax = a.spriteState.actors[3 * ACTOR_FIELDS + F_X];
    const bx = b.spriteState.actors[3 * ACTOR_FIELDS + F_X];
    expect(ax).toBe(bx);
  });

  it('seed distinto → coin en posición distinta (probabilísticamente)', () => {
    const a = createVM(source, { seed: 1 });
    const b = createVM(source, { seed: 2 });
    a.runFrame(); b.runFrame();
    const ax = a.spriteState.actors[3 * ACTOR_FIELDS + F_X];
    const bx = b.spriteState.actors[3 * ACTOR_FIELDS + F_X];
    expect(ax).not.toBe(bx);
  });

  it('vm.pause() congela CUA y el handler PAUSA dibuja la barra', () => {
    const vm = createVM(source, { seed: 1 });
    for (let i = 0; i < 5; i++) vm.runFrame();
    const cuaBefore = vm.state.vars[VAR_INDEX.CUA];
    vm.pause();
    vm.runFrame();
    expect(vm.state.paused).toBe(true);
    expect(vm.state.vars[VAR_INDEX.CUA]).toBe(cuaBefore);  // CUA no avanzó
    // El handler PAUSA pinta REC en (140,95,40,10,8) — chequeamos un pixel.
    const fb = vm.fb;
    expect(fb[95 * 320 + 150]).toBe(8);
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.CUA]).toBe(cuaBefore);  // sigue pausado
  });

  it('vm.resume() reanuda y dispara REANUDA si hay handler', () => {
    const vm = createVM(source, { seed: 1 });
    vm.runFrame();
    vm.pause();
    vm.runFrame();
    vm.resume();
    vm.runFrame();
    expect(vm.state.paused).toBe(false);
  });
});
