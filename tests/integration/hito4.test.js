import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import { F_X, F_Y, F_VX, F_VY, F_FLAGS, FLAG_HIDDEN, ACTOR_FIELDS } from '../../src/core/sprites.js';
import { PIXELS } from '../../src/render/framebuffer.js';

const here = dirname(fileURLToPath(import.meta.url));
const retroPath = resolve(here, '../../games/hito4.retro');
const source = readFileSync(retroPath, 'utf8');

describe('hito4.retro corre en el VM', () => {
  it('parsea, compila y carga ambos sprites', () => {
    const vm = createVM(source);
    expect(vm.spriteState.patterns[0]).toBeDefined();
    expect(vm.spriteState.patterns[1]).toBeDefined();
    expect(vm.spriteState.patterns[0].w).toBe(8);
    expect(vm.spriteState.patterns[0].h).toBe(8);
  });

  it('frame 0: ambos actores quedan visibles con la velocidad inicial', () => {
    const vm = createVM(source);
    vm.runFrame();
    const a = vm.spriteState.actors;
    expect(a[0 * ACTOR_FIELDS + F_FLAGS] & FLAG_HIDDEN).toBe(0);
    expect(a[1 * ACTOR_FIELDS + F_FLAGS] & FLAG_HIDDEN).toBe(0);
    expect(a[0 * ACTOR_FIELDS + F_X]).toBe(80);
    expect(a[0 * ACTOR_FIELDS + F_Y]).toBe(90);
    expect(a[1 * ACTOR_FIELDS + F_X]).toBe(200);
    expect(a[0 * ACTOR_FIELDS + F_VX]).toBe(2);
    expect(a[1 * ACTOR_FIELDS + F_VX]).toBe(-2);
  });

  it('los actores avanzan con su velocidad cada cuadro', () => {
    const vm = createVM(source);
    vm.runFrame();  // setup + render frame 0
    const a = vm.spriteState.actors;
    const x0 = a[0 * ACTOR_FIELDS + F_X];
    const x1 = a[1 * ACTOR_FIELDS + F_X];
    vm.runFrame();
    expect(a[0 * ACTOR_FIELDS + F_X]).toBe(x0 + 2);
    expect(a[1 * ACTOR_FIELDS + F_X]).toBe(x1 - 2);
  });

  it('rebote contra borde derecho para el actor 0', () => {
    const vm = createVM(source);
    vm.runFrame();
    // Forzar X(0) cerca del borde para gatillar INV en el siguiente cuadro.
    vm.spriteState.actors[0 * ACTOR_FIELDS + F_X] = 313;
    vm.runFrame();
    expect(vm.spriteState.actors[0 * ACTOR_FIELDS + F_VX]).toBe(-2);
  });

  it('después de N cuadros el rgba32 muestra contenido', () => {
    const vm = createVM(source);
    for (let i = 0; i < 5; i++) vm.runFrame();
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.rgba32[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(PIXELS / 2);
  });
});
