import { PIXELS, blit } from '../render/framebuffer.js';
import { DEFAULT_PALETTE, createPaletteBank, setPalette } from '../render/palette.js';
import { parseProgram } from '../parser/parser.js';
import { compile } from '../parser/compiler.js';
import { createState, VAR_INDEX, DEFAULT_SEED, MEM } from './memory.js';
import { createSpriteState, advanceActors, renderActors } from './sprites.js';
import {
  createMapState, setMap, prerenderMap,
  actorCollidesMap as mapsActorCollidesMap,
} from './maps.js';
import { createInputState } from './input.js';
import {
  createSynth, loadSound, tickSynthHeadless, updateSilenceFlag,
  serializeSoundToBytes, TOTAL_CHANNELS,
} from '../audio/synth.js';
import { runFromBytecode } from './interpreter.js';

// VM headless con ciclo de vida completo (Hito 7).
//
// Orden de un cuadro:
//   1. Si es el primer cuadro, disparar INICIOMOTOR → INICIOJUEGO →
//      CARGANIVEL → INICIONIVEL.
//   2. Si justResumed, disparar REANUDA.
//   3. Si justPaused, disparar PAUSA.
//   4. Si paused, blit + return (no advance, no CUADRO, no CUA++).
//   5. Si pendingLevelLoad, disparar CARGANIVEL → INICIONIVEL.
//   6. tick synth + drenar pendingChannelEvents → handlers EN CANAL c.
//   7. updateSilenceFlag → handler EN SILENCIO si hubo transición.
//   8. advance actors (gravedad + colisión + LIM + animación).
//   9. fb.set(prerenderedBackground) si hay FON activo.
//  10. handler CUADRO.
//  11. render actores.
//  12. CUA++ y blit.
//  13. handler FINCUADRO.

const PHYSICS_HELPERS = { actorCollidesMap: mapsActorCollidesMap };
const FRAME_DT = 1 / 60;

export function createVM(source, { audioCtx = null, seed = DEFAULT_SEED } = {}) {
  const vmRef = {
    fb: new Uint8Array(PIXELS),
    spriteState: createSpriteState(),
    mapState: createMapState(),
    inputState: createInputState(),
    synth: createSynth(audioCtx),
    // Buffers de las regiones del memory map (docs/PLAN.md §17).
    // CODE: backing en bytes, queda en ceros — habilita LDM/STM consistente
    //   y deja la puerta abierta para v2 (bytecode real).
    // SON: layout flat para LDR(SON, ...) — se escribe al cargar cada SONIDO.
    // FREE: 320 KB de propósito general para el usuario.
    codeMem: new Uint8Array(MEM.CODE.size),
    sonMem: new Uint8Array(MEM.SON.size),
    freeMem: new Uint8Array(MEM.FREE.size),
  };
  // Permite que el synth sepa qué buffer de bytes re-deserializar
  // cuando STR(SON,...) marca un slot como dirty (v2-C).
  vmRef.synth.sonMemRef = vmRef.sonMem;
  const bank = createPaletteBank();
  setPalette(bank, 0, DEFAULT_PALETTE);
  vmRef.bank = bank;  // expuesto para readByte/writeByte (region PAL)
  const rgba32 = new Uint32Array(PIXELS);

  const state = createState(seed);
  const parsed = parseProgram(source);

  for (const sprite of parsed.sprites) {
    vmRef.spriteState.patterns[sprite.index] = {
      w: sprite.width, h: sprite.height, pixels: sprite.pixels,
    };
  }
  for (const map of parsed.maps || []) {
    setMap(vmRef.mapState, map.index, map.cols, map.rows, map.cells);
  }
  for (const sound of parsed.sounds || []) {
    loadSound(vmRef.synth, sound.index, sound);
    // También serializamos al layout flat para acceso por LDR/LDM.
    const slotOff = sound.index * MEM.SON.slotStride;
    const slotSlice = vmRef.sonMem.subarray(slotOff, slotOff + MEM.SON.slotStride);
    serializeSoundToBytes(sound, slotSlice);
  }
  // Si el .retro declara PALETA n, sobreescribe la default. PALETA 0
  // queda activa al iniciar el juego (el bank arranca con active=0).
  for (const pal of parsed.palettes || []) {
    setPalette(bank, pal.index, pal.colors);
  }

  const compiled = compile(parsed, vmRef);
  const cuaIdx = VAR_INDEX.CUA;

  function fire(handlerPc) {
    if (handlerPc === undefined) return;
    runFromBytecode(state, vmRef, compiled.code, compiled.constants, handlerPc);
  }

  function dispatchAudioEvents() {
    const synth = vmRef.synth;
    for (let c = 0; c < TOTAL_CHANNELS; c++) {
      if (synth.pendingChannelEvents[c]) {
        synth.pendingChannelEvents[c] = 0;
        fire(compiled.handlers.CANAL[c]);
      }
    }
    updateSilenceFlag(synth);
    if (synth.pendingSilenceEvent) {
      synth.pendingSilenceEvent = false;
      fire(compiled.handlers.SILENCIO);
    }
  }

  function runFrame() {
    if (state.halted) return;

    if (!state.started) {
      state.started = true;
      fire(compiled.handlers.INICIOMOTOR);
      fire(compiled.handlers.INICIOJUEGO);
      fire(compiled.handlers.CARGANIVEL);
      fire(compiled.handlers.INICIONIVEL);
    }

    if (state.justResumed) {
      state.justResumed = false;
      fire(compiled.handlers.REANUDA);
    }
    if (state.justPaused) {
      state.justPaused = false;
      fire(compiled.handlers.PAUSA);
    }

    if (state.paused) {
      blit(vmRef.fb, bank, rgba32);
      return;
    }

    if (state.pendingLevelLoad) {
      state.pendingLevelLoad = false;
      fire(compiled.handlers.CARGANIVEL);
      fire(compiled.handlers.INICIONIVEL);
    }

    tickSynthHeadless(vmRef.synth, FRAME_DT);
    dispatchAudioEvents();

    advanceActors(vmRef.spriteState, vmRef.mapState, PHYSICS_HELPERS);

    if (vmRef.mapState.activeBackground >= 0) {
      const bg = prerenderMap(vmRef.mapState, vmRef.mapState.activeBackground, vmRef.spriteState.patterns);
      if (bg) vmRef.fb.set(bg);
    }

    fire(compiled.handlers.CUADRO);
    renderActors(vmRef.spriteState, vmRef.fb);
    state.vars[cuaIdx] = (state.vars[cuaIdx] + 1) | 0;
    blit(vmRef.fb, bank, rgba32);
    fire(compiled.handlers.FINCUADRO);
  }

  function pause() {
    if (state.paused) return;
    state.paused = true;
    state.justPaused = true;
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    state.justResumed = true;
  }

  return {
    get fb() { return vmRef.fb; },
    rgba32,
    bank,
    state,
    spriteState: vmRef.spriteState,
    mapState: vmRef.mapState,
    inputState: vmRef.inputState,
    synth: vmRef.synth,
    sonMem: vmRef.sonMem,
    freeMem: vmRef.freeMem,
    codeMem: vmRef.codeMem,
    code: compiled.code,
    codeLength: compiled.codeLength,
    constants: compiled.constants,
    handlers: compiled.handlers,
    lineToIdx: compiled.lineToIdx,
    header: parsed.header,
    runFrame,
    pause,
    resume,
  };
}

// La closure runFromIdx vive ahora como `runFromBytecode` en
// src/core/interpreter.js (v2-A).
