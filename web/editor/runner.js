import { createVM, attachAudioContext, WIDTH, HEIGHT } from '../../src/index.js';
import { VAR_INDEX } from '../../src/core/memory.js';

// Controla el ciclo de vida del VM: carga código, corre rAF, pausa, reset.
// Audio se conecta lazy en el primer gesto del usuario para satisfacer la
// política del browser.

const BUTTON_MAP = {
  ArrowLeft: 0, KeyA: 0,
  ArrowRight: 1, KeyD: 1,
  ArrowUp: 2, KeyW: 2,
  ArrowDown: 3, KeyS: 3,
  KeyZ: 4,
  KeyX: 5,
  Enter: 6,
  ShiftRight: 7, ShiftLeft: 7,
};

export function createRunner({ canvas, onError, onTick }) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(WIDTH, HEIGHT);
  const rgba32View = new Uint32Array(imageData.data.buffer);

  let vm = null;
  let rafId = null;
  let audioCtx = null;
  let attached = false;
  let frameCount = 0;
  let running = false;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (vm && audioCtx && !attached) {
      attachAudioContext(vm.synth, audioCtx);
      attached = true;
    }
  }

  function blackOutCanvas() {
    rgba32View.fill(0xff000000);
    ctx.putImageData(imageData, 0, 0);
  }

  function copyVmFrameToCanvas() {
    rgba32View.set(vm.rgba32);
    ctx.putImageData(imageData, 0, 0);
  }

  function loop() {
    try {
      vm.runFrame();
    } catch (e) {
      onError && onError(e);
      stop();
      return;
    }
    copyVmFrameToCanvas();
    frameCount++;
    if (onTick && (frameCount & 7) === 0) onTick(getStatus());
    rafId = requestAnimationFrame(loop);
  }

  function getStatus() {
    if (!vm) return null;
    return {
      cua: vm.state.vars[VAR_INDEX.CUA],
      pun: vm.state.vars[VAR_INDEX.PUN],
      niv: vm.state.vars[VAR_INDEX.NIV],
      vid: vm.state.vars[VAR_INDEX.VID],
      paused: vm.state.paused,
      header: vm.header,
    };
  }

  function start(source, { seed } = {}) {
    stop();
    try {
      vm = createVM(source, { seed: seed | 0 || 0x12345678 });
    } catch (e) {
      onError && onError(e);
      vm = null;
      return false;
    }
    attached = false;
    if (audioCtx) {
      attachAudioContext(vm.synth, audioCtx);
      attached = true;
    }
    frameCount = 0;
    running = true;
    rafId = requestAnimationFrame(loop);
    return true;
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    running = false;
  }

  function pause() { if (vm) vm.pause(); }
  function resume() { if (vm) vm.resume(); }

  // Avanza un solo cuadro aunque el VM esté pausado. Útil para debugging
  // paso a paso. Detiene el rAF para que no compita con pasos manuales.
  function step() {
    if (!vm) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; running = false; }
    const wasPaused = vm.state.paused;
    vm.state.paused = false;
    try {
      vm.runFrame();
    } catch (e) {
      onError && onError(e);
    }
    vm.state.paused = wasPaused || true;
    copyVmFrameToCanvas();
    if (onTick) onTick(getStatus());
  }

  function isRunning() { return running; }
  function getVm() { return vm; }

  function handleKeyDown(e) {
    ensureAudio();
    if (!vm) return;
    if (e.code === 'Escape') {
      if (vm.state.paused) vm.resume();
      else vm.pause();
      e.preventDefault();
      return;
    }
    const b = BUTTON_MAP[e.code];
    if (b !== undefined) {
      vm.inputState.buttons[b] = 1;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    }
    if (e.key.length === 1) {
      const k = e.key.toUpperCase().charCodeAt(0);
      if (k > 0 && k < 256) vm.inputState.keys[k] = 1;
    }
  }

  function handleKeyUp(e) {
    if (!vm) return;
    const b = BUTTON_MAP[e.code];
    if (b !== undefined) vm.inputState.buttons[b] = 0;
    if (e.key.length === 1) {
      const k = e.key.toUpperCase().charCodeAt(0);
      if (k > 0 && k < 256) vm.inputState.keys[k] = 0;
    }
  }

  blackOutCanvas();

  return {
    start, stop, pause, resume, step,
    ensureAudio,
    isRunning,
    getStatus,
    getVm,
    handleKeyDown,
    handleKeyUp,
  };
}
