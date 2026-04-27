import { PIXELS, blit } from '../render/framebuffer.js';
import { DEFAULT_PALETTE, createPaletteBank, setPalette } from '../render/palette.js';
import { parseProgram } from '../parser/parser.js';
import { compile } from '../parser/compiler.js';
import { createState, VAR_INDEX, DEFAULT_SEED } from './memory.js';
import { createSpriteState, advanceActors, renderActors } from './sprites.js';
import {
  createMapState, setMap, prerenderMap,
  actorCollidesMap as mapsActorCollidesMap,
} from './maps.js';
import { createInputState } from './input.js';
import {
  createSynth, loadSound, tickSynthHeadless, updateSilenceFlag,
  TOTAL_CHANNELS,
} from '../audio/synth.js';

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
  };
  const rgba32 = new Uint32Array(PIXELS);
  const bank = createPaletteBank();
  setPalette(bank, 0, DEFAULT_PALETTE);

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
  }
  // Si el .retro declara PALETA n, sobreescribe la default. PALETA 0
  // queda activa al iniciar el juego (el bank arranca con active=0).
  for (const pal of parsed.palettes || []) {
    setPalette(bank, pal.index, pal.colors);
  }

  const compiled = compile(parsed, vmRef);
  const cuaIdx = VAR_INDEX.CUA;

  function fire(handlerIdx) {
    if (handlerIdx === undefined) return;
    runFromIdx(handlerIdx, compiled.program, state);
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
    program: compiled.program,
    handlers: compiled.handlers,
    lineToIdx: compiled.lineToIdx,
    header: parsed.header,
    runFrame,
    pause,
    resume,
  };
}

function runFromIdx(startIdx, program, state) {
  state.callSp = 0;
  state.loopSp = 0;
  let pc = startIdx;
  const len = program.length;
  let budget = 1_000_000;
  while (pc >= 0 && pc < len) {
    pc = program[pc](pc, state);
    if (--budget <= 0) {
      throw new Error('handler excedió presupuesto de instrucciones por cuadro');
    }
  }
}
