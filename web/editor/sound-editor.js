import { createSynth, attachAudioContext, loadSound, playSound, silenceChannel } from '../../src/audio/synth.js';
import { insertAtCursor } from './codemirror.js';

// Editor visual de sonidos. Form para ONDA / PUL / ENV ADSR + lista
// editable de NOTA/SIL. Play en vivo usando el mismo synth del VM.
// Export: bloque `SONIDO n` ... FIN listo para insertar.

const NOTE_NAMES = ['DO', 'RE', 'MI', 'FA', 'SOL', 'LA', 'SI'];
const ACCIDENTALS = ['', '#', 'b'];
const NOTE_OFFSET = { DO: 0, RE: 2, MI: 4, FA: 5, SOL: 7, LA: 9, SI: 11 };

let dialog = null;
let editorView = null;
let state = freshState();

let liveSynth = null;
let liveAudioCtx = null;

export function initSoundEditor(view) {
  editorView = view;
  if (dialog) return;
  buildDialog();
  document.body.appendChild(dialog);
}

export function openSoundEditor() {
  if (!dialog) throw new Error('sound editor no inicializado');
  state = freshState();
  refreshAll();
  dialog.showModal();
}

function freshState() {
  return {
    wave: 'PUL',
    pulseWidth: 8,
    env: { a: 0, d: 2, s: 8, r: 2 },
    steps: [
      { type: 'note', name: 'DO', acc: '', octave: 5, ticks: 4 },
      { type: 'note', name: 'SOL', acc: '', octave: 5, ticks: 4 },
      { type: 'note', name: 'DO', acc: '', octave: 6, ticks: 6 },
    ],
  };
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'snd-dialog ide-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <header class="ide-dialog-head">
        <h2>Editor de sonidos</h2>
        <button class="ide-dialog-close" value="cancel" aria-label="Cerrar">×</button>
      </header>
      <div class="ide-dialog-body">
        <div class="snd-toolbar">
          <label>Slot
            <input type="number" id="snd-slot" min="0" max="15" value="0" />
          </label>
          <label>Forma
            <select id="snd-wave">
              <option>PUL</option><option>TRI</option><option>SIE</option><option>SEN</option>
            </select>
          </label>
          <label>PUL ancho
            <input type="range" id="snd-pul" min="0" max="15" value="8" />
            <span id="snd-pul-val">8</span>
          </label>
        </div>
        <fieldset class="snd-adsr">
          <legend>Envolvente ADSR</legend>
          ${['a','d','s','r'].map(k => `
            <label class="snd-adsr-row">
              <span class="snd-adsr-label">${k.toUpperCase()}</span>
              <input type="range" min="0" max="15" data-adsr="${k}" />
              <span data-adsr-val="${k}"></span>
            </label>
          `).join('')}
        </fieldset>
        <fieldset class="snd-steps">
          <legend>Notas</legend>
          <div id="snd-steps-list"></div>
          <div class="snd-steps-tools">
            <button type="button" id="snd-add-note">+ Nota</button>
            <button type="button" id="snd-add-silence">+ Silencio</button>
          </div>
        </fieldset>
      </div>
      <footer class="ide-dialog-foot">
        <button type="button" id="snd-play" class="ide-secondary">▶ Play</button>
        <button type="button" id="snd-stop">■ Stop</button>
        <span class="snd-spacer"></span>
        <button value="cancel">Cancelar</button>
        <button value="default" class="ide-primary">Insertar al cursor</button>
      </footer>
    </form>
  `;

  dialog.querySelector('#snd-wave').addEventListener('change', (e) => {
    state.wave = e.target.value;
    refreshPulEnable();
  });
  const pul = dialog.querySelector('#snd-pul');
  pul.addEventListener('input', () => {
    state.pulseWidth = parseInt(pul.value, 10);
    dialog.querySelector('#snd-pul-val').textContent = pul.value;
  });
  for (const slider of dialog.querySelectorAll('input[data-adsr]')) {
    slider.addEventListener('input', () => {
      const k = slider.dataset.adsr;
      state.env[k] = parseInt(slider.value, 10);
      dialog.querySelector(`[data-adsr-val="${k}"]`).textContent = slider.value;
    });
  }
  dialog.querySelector('#snd-add-note').addEventListener('click', () => {
    state.steps.push({ type: 'note', name: 'DO', acc: '', octave: 4, ticks: 4 });
    refreshSteps();
  });
  dialog.querySelector('#snd-add-silence').addEventListener('click', () => {
    state.steps.push({ type: 'silence', ticks: 4 });
    refreshSteps();
  });
  dialog.querySelector('#snd-play').addEventListener('click', play);
  dialog.querySelector('#snd-stop').addEventListener('click', stopPlay);

  dialog.addEventListener('close', () => {
    stopPlay();
    if (dialog.returnValue === 'default') doInsert();
  });
}

function refreshAll() {
  dialog.querySelector('#snd-wave').value = state.wave;
  dialog.querySelector('#snd-pul').value = state.pulseWidth;
  dialog.querySelector('#snd-pul-val').textContent = String(state.pulseWidth);
  for (const k of ['a', 'd', 's', 'r']) {
    dialog.querySelector(`input[data-adsr="${k}"]`).value = state.env[k];
    dialog.querySelector(`[data-adsr-val="${k}"]`).textContent = String(state.env[k]);
  }
  refreshPulEnable();
  refreshSteps();
}

function refreshPulEnable() {
  const pul = dialog.querySelector('#snd-pul');
  pul.disabled = state.wave !== 'PUL';
}

function refreshSteps() {
  const list = dialog.querySelector('#snd-steps-list');
  list.innerHTML = '';
  state.steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'snd-step';
    if (step.type === 'note') {
      row.innerHTML = `
        <select data-step-name></select>
        <select data-step-acc></select>
        <label>Oct
          <input type="number" data-step-oct min="0" max="7" value="${step.octave}" />
        </label>
        <label>Ticks
          <input type="number" data-step-ticks min="1" max="60" value="${step.ticks}" />
        </label>
        <button type="button" class="snd-step-rm" aria-label="Eliminar">×</button>
      `;
      const nameSel = row.querySelector('[data-step-name]');
      for (const n of NOTE_NAMES) {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        if (n === step.name) o.selected = true;
        nameSel.appendChild(o);
      }
      const accSel = row.querySelector('[data-step-acc]');
      for (const a of ACCIDENTALS) {
        const o = document.createElement('option');
        o.value = a; o.textContent = a || '—';
        if (a === step.acc) o.selected = true;
        accSel.appendChild(o);
      }
      nameSel.addEventListener('change', (e) => { step.name = e.target.value; });
      accSel.addEventListener('change', (e) => { step.acc = e.target.value; });
      row.querySelector('[data-step-oct]').addEventListener('input', (e) => {
        step.octave = parseInt(e.target.value, 10) | 0;
      });
      row.querySelector('[data-step-ticks]').addEventListener('input', (e) => {
        step.ticks = parseInt(e.target.value, 10) | 0;
      });
    } else {
      row.innerHTML = `
        <span class="snd-step-label">SIL</span>
        <label>Ticks
          <input type="number" data-step-ticks min="1" max="60" value="${step.ticks}" />
        </label>
        <button type="button" class="snd-step-rm" aria-label="Eliminar">×</button>
      `;
      row.querySelector('[data-step-ticks]').addEventListener('input', (e) => {
        step.ticks = parseInt(e.target.value, 10) | 0;
      });
    }
    row.querySelector('.snd-step-rm').addEventListener('click', () => {
      state.steps.splice(i, 1);
      refreshSteps();
    });
    list.appendChild(row);
  });
}

function buildSoundDef() {
  // Convierte el state a la def que loadSound espera (con semitone/octave).
  const steps = [];
  for (const s of state.steps) {
    if (s.type === 'silence') {
      steps.push({ type: 'silence', ticks: s.ticks | 0 || 1 });
    } else {
      let semitone = NOTE_OFFSET[s.name] | 0;
      if (s.acc === '#') semitone += 1;
      else if (s.acc === 'b') semitone -= 1;
      let octave = s.octave | 0;
      if (semitone < 0) { semitone += 12; octave -= 1; }
      if (semitone > 11) { semitone -= 12; octave += 1; }
      steps.push({ type: 'note', semitone, octave, ticks: s.ticks | 0 || 1 });
    }
  }
  return {
    wave: state.wave,
    pulseWidth: state.pulseWidth,
    env: { ...state.env },
    steps,
  };
}

function play() {
  stopPlay();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    alert('Tu browser no soporta Web Audio.');
    return;
  }
  liveAudioCtx = new Ctx();
  liveSynth = createSynth(null);
  attachAudioContext(liveSynth, liveAudioCtx);
  loadSound(liveSynth, 0, buildSoundDef());
  playSound(liveSynth, 0, 0);
}

function stopPlay() {
  if (liveSynth) {
    silenceChannel(liveSynth, 0);
    liveSynth = null;
  }
  if (liveAudioCtx) {
    try { liveAudioCtx.close(); } catch (_) { /* ya cerrado */ }
    liveAudioCtx = null;
  }
}

function doInsert() {
  if (!editorView) return;
  const slot = parseInt(dialog.querySelector('#snd-slot').value, 10);
  const lines = [`SONIDO ${slot}`, `ONDA ${state.wave}`];
  if (state.wave === 'PUL') lines.push(`PUL ${state.pulseWidth}`);
  lines.push(`ENV ${state.env.a},${state.env.d},${state.env.s},${state.env.r}`);
  for (const s of state.steps) {
    if (s.type === 'silence') {
      lines.push(`SIL ${s.ticks}`);
    } else {
      lines.push(`NOTA ${s.name}${s.acc}${s.octave} ${s.ticks}`);
    }
  }
  lines.push('FIN');
  insertAtCursor(editorView, lines.join('\n') + '\n');
}
