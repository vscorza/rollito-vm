import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';

// Reference game: snake clásico.
//
// Cubre: arreglos M0/M1 (ringbuffer del cuerpo), ALE con seed determinista
// para spawn de comida, ciclo de juego sin físicas, sonido procedural por
// mordida y por fin de partida.
//
// Correr con seed fijo + secuencia de inputs deterministas hace cada
// partida reproducible — base de los golden tests más adelante.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../games/serpiente.retro'), 'utf8');

describe('reference game: serpiente', () => {
  it('arranca con cuerpo de largo 3, dirección derecha y comida spawneada', () => {
    const vm = createVM(source, { seed: 42 });
    vm.runFrame();
    expect(vm.state.vars[11]).toBe(3);   // L (largo) = 3
    expect(vm.state.vars[3]).toBe(1);    // D (dirección) = 1 (derecha)
    expect(vm.state.vars[25]).toBe(0);   // Z (game over) = 0
    // F y G (comida) deben estar dentro del rango válido tras el spawn.
    const F = vm.state.vars[5], G = vm.state.vars[6];
    expect(F).toBeGreaterThanOrEqual(0);
    expect(F).toBeLessThan(32);
    expect(G).toBeGreaterThanOrEqual(0);
    expect(G).toBeLessThan(20);
  });

  it('mismo seed → misma posición de comida', () => {
    const a = createVM(source, { seed: 7 });
    const b = createVM(source, { seed: 7 });
    a.runFrame(); b.runFrame();
    expect(a.state.vars[5]).toBe(b.state.vars[5]);
    expect(a.state.vars[6]).toBe(b.state.vars[6]);
  });

  it('chocar contra borde derecho marca Z=1 y dispara sonido fin', () => {
    const vm = createVM(source, { seed: 1 });
    // 32 columnas, cabeza en col 17, dir derecha. Necesita ~15 avances
    // para llegar al borde. Velocidad V=8 → cuadros = 15*8 ≈ 120.
    for (let i = 0; i < 200; i++) vm.runFrame();
    expect(vm.state.vars[25]).toBe(1);  // Z = 1
  });

  it('mover a la izquierda primero (anti-reversa) deja D inalterado', () => {
    const vm = createVM(source, { seed: 1 });
    vm.runFrame();
    // Empieza con D=1 (derecha). BTN(0) = izquierda → D=3, prohibido.
    vm.inputState.buttons[0] = 1;
    vm.runFrame();
    vm.inputState.buttons[0] = 0;
    expect(vm.state.vars[3]).toBe(1);  // sigue derecha
  });

  it('girar arriba con BTN(2) cambia D=0', () => {
    const vm = createVM(source, { seed: 1 });
    vm.runFrame();
    vm.inputState.buttons[2] = 1;
    vm.runFrame();
    vm.inputState.buttons[2] = 0;
    expect(vm.state.vars[3]).toBe(0);
  });
});
