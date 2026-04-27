import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import {
  ACTOR_FIELDS, F_X, F_Y, F_VX, F_VY, F_FLAGS,
  F_PHYS_MAP, FLAG_ON_GROUND, FLAG_LIM_ACTIVE,
} from '../../src/core/sprites.js';

const here = dirname(fileURLToPath(import.meta.url));
const retroPath = resolve(here, '../../games/hito5.retro');
const source = readFileSync(retroPath, 'utf8');

describe('hito5.retro corre como plataformer', () => {
  it('parsea sprites + mapa y compila el handler CUADRO', () => {
    const vm = createVM(source);
    expect(vm.spriteState.patterns[1]).toBeDefined();
    expect(vm.spriteState.patterns[1].w).toBe(16);
    expect(vm.spriteState.patterns[2]).toBeDefined();
    expect(vm.spriteState.patterns[2].w).toBe(8);
    expect(vm.mapState.maps[0]).toBeDefined();
    expect(vm.mapState.maps[0].cols).toBe(20);
    expect(vm.mapState.maps[0].rows).toBe(12);
    expect(vm.handlers.CUADRO).toBeDefined();
  });

  it('frame 0 inicializa: FON, SOL, GRA, LIM y player visible', () => {
    const vm = createVM(source);
    vm.runFrame();
    const a = vm.spriteState.actors;
    expect(vm.mapState.activeBackground).toBe(0);
    expect(vm.mapState.maps[0].solid[1]).toBe(1);
    expect(a[F_PHYS_MAP]).toBe(0);
    expect(a[F_FLAGS] & FLAG_LIM_ACTIVE).toBe(FLAG_LIM_ACTIVE);
    expect(vm.spriteState.patternIdx[0]).toBe(2);
  });

  it('el player cae por gravedad y aterriza en el piso del mapa', () => {
    const vm = createVM(source);
    for (let i = 0; i < 60; i++) vm.runFrame();
    const a = vm.spriteState.actors;
    expect(a[F_FLAGS] & FLAG_ON_GROUND).toBe(FLAG_ON_GROUND);
    expect(a[F_VY]).toBe(0);
    // Floor en row 11 × tile 16 = y=176. Player 8x8 → y ≤ 168.
    expect(a[F_Y]).toBeLessThanOrEqual(168);
  });

  it('manteniendo BTN(1) presionado el player se mueve a la derecha', () => {
    const vm = createVM(source);
    for (let i = 0; i < 30; i++) vm.runFrame();  // caer al piso
    const x0 = vm.spriteState.actors[F_X];
    vm.inputState.buttons[1] = 1;
    for (let i = 0; i < 10; i++) vm.runFrame();
    vm.inputState.buttons[1] = 0;
    expect(vm.spriteState.actors[F_X]).toBeGreaterThan(x0);
  });

  it('SAL: con BTN(4) presionado en suelo, vy se vuelve negativa y deja el suelo', () => {
    const vm = createVM(source);
    for (let i = 0; i < 30; i++) vm.runFrame();
    const a = vm.spriteState.actors;
    expect(a[F_FLAGS] & FLAG_ON_GROUND).toBe(FLAG_ON_GROUND);
    vm.inputState.buttons[4] = 1;
    vm.runFrame();
    vm.inputState.buttons[4] = 0;
    expect(a[F_VY]).toBeLessThan(0);
    expect(a[F_FLAGS] & FLAG_ON_GROUND).toBe(0);
  });

  it('LIM impide que el player salga por la izquierda', () => {
    const vm = createVM(source);
    for (let i = 0; i < 30; i++) vm.runFrame();
    vm.inputState.buttons[0] = 1;
    for (let i = 0; i < 100; i++) vm.runFrame();
    vm.inputState.buttons[0] = 0;
    expect(vm.spriteState.actors[F_X]).toBeGreaterThanOrEqual(0);
  });
});
