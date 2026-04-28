// Cosim de juegos: misma source corre v2-A y RVM-32 transpilado;
// state.vars y vm.fb deben coincidir frame a frame.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { transpile } from '../../src/asm/v2a-to-rvm32.js';
import { runRVM32, createRvmState } from '../../src/asm/interpreter.js';
import { runFromBytecode } from '../../src/core/interpreter.js';
import { createState } from '../../src/core/memory.js';
import { createSpriteState, makeDefaultBlendTable } from '../../src/core/sprites.js';
import { createMapState, setMap } from '../../src/core/maps.js';
import { createSynth, loadSound } from '../../src/audio/synth.js';
import { PIXELS } from '../../src/render/framebuffer.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadGame(name) {
  return readFileSync(resolve(here, '../../games', `${name}.retro`), 'utf8');
}

function makeVm(parsed) {
  const v = {
    fb: new Uint8Array(PIXELS),
    codeMem: new Uint8Array(0x8000),
    sonMem: new Uint8Array(0x3000),
    freeMem: new Uint8Array(0x50000),
    bank: { luts: new Uint32Array(64), views: [], scanlineOverride: new Int8Array(200) },
    spriteState: createSpriteState(),
    mapState: createMapState(),
    inputState: { buttons: new Uint8Array(8), keys: new Uint8Array(256) },
    synth: createSynth(null),
    blendTable: makeDefaultBlendTable(),
  };
  for (const sp of parsed.sprites || []) {
    v.spriteState.patterns[sp.index] = { w: sp.width, h: sp.height, pixels: sp.pixels };
  }
  for (const m of parsed.maps || []) {
    setMap(v.mapState, m.index, m.cols, m.rows, m.cells);
  }
  for (const s of parsed.sounds || []) loadSound(v.synth, s.index, s);
  return v;
}

function cosimGame(name, frames = 1) {
  const src = loadGame(name);
  const parsed = parseProgram(src);

  const vm1 = makeVm(parsed);
  const vm2 = makeVm(parsed);
  const c1 = compile(parsed, vm1);
  const c2 = compile(parsed, vm2);
  const tr = transpile(c2);
  vm2.rvmConstants = tr.constants;

  const state1 = createState();
  const state2 = createState();
  const rvm = createRvmState();
  rvm.regs[15] = (tr.bin.length - 1) * 4;

  // Lifecycle inicial (1 frame).
  for (const h of ['INICIOMOTOR', 'INICIOJUEGO', 'CARGANIVEL', 'INICIONIVEL']) {
    if (c1.handlers[h] !== undefined) runFromBytecode(state1, vm1, c1.code, c1.constants, c1.handlers[h]);
    if (tr.handlers[h] !== undefined) runRVM32(rvm, state2, vm2, tr.bin, tr.handlers[h]);
  }
  // N frames de CUADRO.
  for (let f = 0; f < frames; f++) {
    if (c1.handlers.CUADRO !== undefined) runFromBytecode(state1, vm1, c1.code, c1.constants, c1.handlers.CUADRO);
    if (tr.handlers.CUADRO !== undefined) runRVM32(rvm, state2, vm2, tr.bin, tr.handlers.CUADRO);
  }

  let varsDiff = 0;
  for (let i = 0; i < 32; i++) if (state1.vars[i] !== state2.vars[i]) varsDiff++;
  let fbDiff = 0;
  for (let i = 0; i < vm1.fb.length; i++) if (vm1.fb[i] !== vm2.fb[i]) fbDiff++;
  return { varsDiff, fbDiff, codeLength: c1.codeLength, binLength: tr.bin.length };
}

describe('Cosim de juegos: v2-A ↔ RVM-32', () => {
  // Vars deben coincidir 100%. fb tolera unos pocos bytes (ALE/queries que
  // varían en orden). Espacial usa starfield procedural, los rest = 0.
  const games = [
    { name: 'pelota',     fbMax: 0 },
    { name: 'pong',       fbMax: 0 },
    { name: 'saltarin',   fbMax: 0 },
    { name: 'memoria',    fbMax: 0 },
    { name: 'serpiente',  fbMax: 0 },
    { name: 'camaleon',   fbMax: 0 },
    { name: 'mario-mini', fbMax: 0 },
    { name: 'tetris',     fbMax: 0 },
    { name: 'espacial',   fbMax: 256 },
    { name: 'rollox',     fbMax: 0 },
  ];
  for (const g of games) {
    it(`${g.name}: vars match + fb diff ≤ ${g.fbMax}`, () => {
      const r = cosimGame(g.name, 1);
      expect(r.varsDiff).toBe(0);
      expect(r.fbDiff).toBeLessThanOrEqual(g.fbMax);
    });
  }
});
