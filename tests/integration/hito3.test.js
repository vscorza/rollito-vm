import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import { PIXELS } from '../../src/render/framebuffer.js';

const here = dirname(fileURLToPath(import.meta.url));
const retroPath = resolve(here, '../../games/hito3.retro');
const source = readFileSync(retroPath, 'utf8');

describe('hito3.retro corre en el VM', () => {
  it('parsea, compila y ejecuta el primer cuadro sin errores', () => {
    const vm = createVM(source);
    expect(vm.handlers.CUADRO).toBeDefined();
    expect(() => vm.runFrame()).not.toThrow();
  });

  it('después de 1 cuadro el rgba32 NO está completamente vacío', () => {
    const vm = createVM(source);
    vm.runFrame();
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.rgba32[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(PIXELS / 2);
  });

  it('CUA avanza un paso por cuadro', () => {
    const vm = createVM(source);
    expect(vm.state.vars[26]).toBe(0);  // VAR_INDEX.CUA = 26
    vm.runFrame();
    expect(vm.state.vars[26]).toBe(1);
    vm.runFrame();
    expect(vm.state.vars[26]).toBe(2);
  });

  it('el rectángulo móvil se mueve entre cuadros', () => {
    const vm = createVM(source);
    vm.runFrame();
    const snapshotA = new Uint32Array(vm.rgba32);
    for (let i = 0; i < 10; i++) vm.runFrame();
    let diffs = 0;
    for (let i = 0; i < PIXELS; i++) if (snapshotA[i] !== vm.rgba32[i]) diffs++;
    expect(diffs).toBeGreaterThan(0);
  });
});
