import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVM } from '../../src/core/vm.js';
import { tickSynthHeadless } from '../../src/audio/synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const retroPath = resolve(here, '../../games/hito6.retro');
const source = readFileSync(retroPath, 'utf8');

describe('hito6.retro corre como plataformer con audio', () => {
  it('parsea sprites + mapa + 2 sonidos', () => {
    const vm = createVM(source);
    expect(vm.spriteState.patterns[1]).toBeDefined();
    expect(vm.spriteState.patterns[2]).toBeDefined();
    expect(vm.mapState.maps[0]).toBeDefined();
    expect(vm.synth.sounds[0]).toBeDefined();
    expect(vm.synth.sounds[1]).toBeDefined();
    expect(vm.synth.sounds[0].wave).toBe('PUL');
    expect(vm.synth.sounds[1].wave).toBe('SIE');
  });

  it('saltar dispara SON 0,0 (canal 0 queda playing)', () => {
    const vm = createVM(source);
    for (let i = 0; i < 30; i++) vm.runFrame();  // caer al piso
    expect(vm.synth.channels[0].isPlaying).toBe(false);
    vm.inputState.buttons[4] = 1;
    vm.runFrame();  // ejecuta CUADRO con BTN(4)=1 → LLA 200 → SAL + SON
    vm.inputState.buttons[4] = 0;
    expect(vm.synth.channels[0].isPlaying).toBe(true);
  });

  it('al aterrizar dispara SON 1,1 (transición airborne→ground)', () => {
    const vm = createVM(source);
    // Caer al piso primero (queda en suelo).
    for (let i = 0; i < 30; i++) vm.runFrame();
    // Limpiar canal 1 (no haya sido tocado en el primer aterrizaje).
    vm.synth.channels[1].isPlaying = false;
    // Saltar.
    vm.inputState.buttons[4] = 1;
    vm.runFrame();
    vm.inputState.buttons[4] = 0;
    // Esperar a que el actor caiga de nuevo.
    let landed = false;
    for (let i = 0; i < 60 && !landed; i++) {
      vm.runFrame();
      if (vm.synth.channels[1].isPlaying) landed = true;
    }
    expect(landed).toBe(true);
  });

  it('CANAL handler se dispara cuando termina el sonido', () => {
    // Pequeño .retro inline con un handler EN CANAL que cuenta cuadros.
    const inline = `
SONIDO 0
ONDA PUL
NOTA DO5 4
FIN

PROGRAMA
10 EN CUADRO IR 100
20 EN CANAL 0 IR 200

100 SI CUA=0 ENT SON 0,0
110 RET

200 K+=1
210 RET
`;
    const vm = createVM(inline);
    for (let i = 0; i < 10; i++) vm.runFrame();
    // K debe haber subido al menos 1 vez.
    expect(vm.state.vars[10]).toBeGreaterThanOrEqual(1);  // K = slot 10 (A=0..K=10)
  });

  it('SILENCIO handler se dispara tras drenar canales', () => {
    const inline = `
SONIDO 0
ONDA PUL
NOTA DO5 3
FIN

PROGRAMA
10 EN CUADRO IR 100
20 EN SILENCIO IR 300

100 SI CUA=0 ENT SON 0,0
110 RET

300 S+=1
310 RET
`;
    const vm = createVM(inline);
    for (let i = 0; i < 10; i++) vm.runFrame();
    // Variable S = slot 18 (A=0,B=1,...,S=18).
    expect(vm.state.vars[18]).toBeGreaterThanOrEqual(1);
  });
});
