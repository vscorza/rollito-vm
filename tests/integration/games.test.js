import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import { PIXELS } from '../../src/render/framebuffer.js';

const here = dirname(fileURLToPath(import.meta.url));
function loadGame(name) {
  return readFileSync(resolve(here, '../../games', `${name}.retro`), 'utf8');
}

function smoke(name, frames = 30) {
  const vm = createVM(loadGame(name), { seed: 42 });
  for (let i = 0; i < frames; i++) vm.runFrame();
  return vm;
}

describe('Smoke tests de los 5 ejemplos canónicos', () => {
  it('pelota.retro corre 60 cuadros y rebota visualmente', () => {
    const vm = smoke('pelota', 60);
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(PIXELS / 2);
  });

  it('pong.retro corre 60 cuadros con paletas y bola visibles', () => {
    const vm = smoke('pong', 60);
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(50);
  });

  it('saltarin.retro corre 60 cuadros y aterriza en suelo', () => {
    const vm = smoke('saltarin', 60);
    expect(vm.spriteState.actors[1]).toBeGreaterThan(0);  // F_Y > 0
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] !== 0) nonZero++;
    // Floor + 2 plataformas + player + coin + texto ≈ 7000+ pixels.
    expect(nonZero).toBeGreaterThan(5000);
  });

  it('memoria.retro corre 30 cuadros con grilla dibujada', () => {
    const vm = smoke('memoria', 30);
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(500);
    // 16 cartas × 40×24 inicializadas — hay mucho gris (índice 5).
  });

  it('serpiente.retro corre 30 cuadros con cuerpo + comida', () => {
    const vm = smoke('serpiente', 30);
    let nonZero = 0;
    for (let i = 0; i < PIXELS; i++) if (vm.fb[i] !== 0) nonZero++;
    // Cuerpo (3×64=192 px verde) + comida (64 px) + texto = ~300+ pixels.
    expect(nonZero).toBeGreaterThan(200);
    expect(vm.state.vars[25]).toBe(0);  // Z (game over flag) = 0
  });

  it('los 5 juegos cargan sin errores y compilan handlers CUADRO', () => {
    for (const name of ['pelota', 'pong', 'saltarin', 'memoria', 'serpiente']) {
      const vm = createVM(loadGame(name), { seed: 1 });
      expect(vm.handlers.CUADRO).toBeDefined();
    }
  });

  it('mario-mini.retro: 60 cuadros, mapa 0 activo, paleta custom aplicada', () => {
    const vm = smoke('mario-mini', 60);
    // Nivel 1 cargado.
    expect(vm.mapState.activeBackground).toBe(0);
    expect(vm.mapState.maps[0]).toBeDefined();
    expect(vm.mapState.maps[1]).toBeDefined();
    // PALETA 0 declarada en el .retro: color 0 = sky blue (5DCDFF), no el default negro.
    const v = vm.bank.luts[0] >>> 0;
    const r = v & 0xff, g = (v >>> 8) & 0xff, b = (v >>> 16) & 0xff;
    expect(r).toBe(0x5D);
    expect(g).toBe(0xCD);
    expect(b).toBe(0xFF);
    // VID=3 inicial; Z=0 jugando.
    expect(vm.state.vars[28]).toBe(3);
    expect(vm.state.vars[25]).toBe(0);
  });

  it('espacial.retro: starfield + spawn de enemigos en 60 cuadros', () => {
    const vm = smoke('espacial', 60);
    // Player visible en (156, 176).
    expect(vm.spriteState.actors[0]).toBe(156);
    expect(vm.spriteState.actors[1]).toBe(176);
    // 24 estrellas en pantalla (Y in [0,199]).
    let starsInRange = 0;
    for (let i = 0; i < 24; i++) {
      const y = vm.state.arrays[256 + i];  // M1
      if (y >= 0 && y < 200) starsInRange++;
    }
    expect(starsInRange).toBe(24);
    // Z=0 (jugando), VID=3 inicial.
    expect(vm.state.vars[25]).toBe(0);
    expect(vm.state.vars[28]).toBe(3);
  });

  it('espacial.retro: BTN(4) dispara una bala en slot 12', () => {
    const vm = createVM(loadGame('espacial'), { seed: 42 });
    for (let i = 0; i < 5; i++) vm.runFrame();
    // Disparar.
    vm.inputState.buttons[4] = 1;
    vm.runFrame();
    // Bala visible en slot 12 (flags bit 0 = HIDDEN).
    const bulletFlags = vm.spriteState.actors[12 * 16 + 4];
    expect(bulletFlags & 1).toBe(0);
    // VEL Y de la bala = -6.
    expect(vm.spriteState.actors[12 * 16 + 3]).toBe(-6);
  });

  it('camaleon.retro: recolora el sprite y agrega plataformas según NIV', () => {
    const vm = smoke('camaleon', 30);
    // SPRITE 1 row 4 (08899880) tiene 9 en columnas 3 y 4 → pixels[35] y [36].
    // En NIV=0 quedan en 9 (9+0=9).
    expect(vm.spriteState.patterns[1].pixels[35]).toBe(9);
    // El piso (cells 220..239 en MAPA 0) está poblado con tile 2.
    expect(vm.mapState.maps[0].cells[220]).toBe(2);
    expect(vm.mapState.maps[0].cells[239]).toBe(2);
    // En NIV=0 NO hay plataformas adicionales (cells 165..168 quedan en 0).
    expect(vm.mapState.maps[0].cells[165]).toBe(0);
    // Bumpeamos NIV manualmente para verificar el handler de INICIONIVEL.
    vm.state.vars[30] = 1;
    vm.state.pendingLevelLoad = true;
    vm.runFrame();  // dispara CARGANIVEL + INICIONIVEL
    // Ahora plataforma row 8 cols 5..8 está, color del player es 10.
    expect(vm.mapState.maps[0].cells[165]).toBe(2);
    expect(vm.mapState.maps[0].cells[168]).toBe(2);
    expect(vm.spriteState.patterns[1].pixels[35]).toBe(10);
  });

  it('mario-mini.retro: chocando con la bandera (slot 5) salta de NIV 0 a NIV 1', () => {
    const vm = smoke('mario-mini', 1);
    // Forzar la posición del player a la bandera (288,144) para gatillar COL(0,5).
    // Slot 0 = player, F_X=0, F_Y=1.
    vm.spriteState.actors[0] = 288;
    vm.spriteState.actors[1] = 144;
    vm.runFrame();
    // CARNIV NIV+1 setea pendingLevelLoad; el siguiente cuadro lo aplica.
    vm.runFrame();
    expect(vm.state.vars[30]).toBe(1);  // NIV
    expect(vm.mapState.activeBackground).toBe(1);
  });
});
