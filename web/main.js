import { createEditor, getEditorDoc, setEditorDoc } from './editor/codemirror.js';
import { listExamples, getExample } from './editor/examples.js';
import { createRunner } from './editor/runner.js';
import { initPaletteEditor, openPaletteEditor } from './editor/palette-editor.js';
import { initSpriteEditor, openSpriteEditor } from './editor/sprite-editor.js';
import { initSoundEditor, openSoundEditor } from './editor/sound-editor.js';
import { initMemoryInspector, openMemoryInspector } from './editor/memory-inspector.js';
import { initLibraryMenu, openLibraryMenu } from './editor/library-menu.js';

// Los links del header apuntan al docs viewer (renderiza Markdown a HTML).
// Usamos rutas relativas para que funcione tanto en localhost como bajo
// el base-path de GitHub Pages (/rollito-vm/).
document.querySelector('a[href$="REFERENCIA.md"]').href = './docs-viewer.html?doc=REFERENCIA';
document.querySelector('a[href$="TUTORIAL.md"]').href  = './docs-viewer.html?doc=TUTORIAL';
document.querySelector('a[href$="PLAN.md"]').href      = './docs-viewer.html?doc=PLAN';

const STORAGE_KEY = 'retrovm:draft';
const SETTINGS_KEY = 'retrovm:settings';
const DEFAULT_EXAMPLE = 'serpiente';

// --- Bootstrap del editor --------------------------------------------
const editorRoot = document.getElementById('editor');
const initialSource = loadDraft() ?? getExample(DEFAULT_EXAMPLE) ?? '';

const editor = createEditor(editorRoot, initialSource, (text) => {
  saveDraft(text);
});

// Inicializar editores modales (todos comparten la referencia al editor).
initPaletteEditor(editor);
initSpriteEditor(editor);
initSoundEditor(editor);
initLibraryMenu(editor);
initMemoryInspector(() => runner.getVm());

// --- Selector de ejemplos --------------------------------------------
const exampleSelect = document.getElementById('example-select');
for (const name of listExamples()) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  exampleSelect.appendChild(opt);
}
const lastExample = loadSetting('lastExample') || DEFAULT_EXAMPLE;
if (lastExample) exampleSelect.value = lastExample;

exampleSelect.addEventListener('change', () => {
  const src = getExample(exampleSelect.value);
  if (!src) return;
  if (hasUnsavedChanges() && !confirm(`¿Reemplazar el código actual con "${exampleSelect.value}"?`)) {
    return;
  }
  setEditorDoc(editor, src);
  saveSetting('lastExample', exampleSelect.value);
  saveDraft(src);
});

// --- Runner -----------------------------------------------------------
const canvas = document.getElementById('screen');
const hud = {
  status: document.getElementById('hud-status'),
  cua: document.getElementById('hud-cua'),
  pun: document.getElementById('hud-pun'),
  niv: document.getElementById('hud-niv'),
};
const diagnostics = document.getElementById('diagnostics');

const runner = createRunner({
  canvas,
  onError: (err) => showDiag('error', String(err.message || err)),
  onTick: (st) => updateHud(st),
});

function updateHud(st) {
  if (!st) return;
  hud.cua.textContent = st.cua;
  hud.pun.textContent = st.pun;
  hud.niv.textContent = st.niv;
  hud.status.textContent = st.paused ? 'pausado' : 'jugando';
}

function showDiag(level, msg) {
  const line = document.createElement('p');
  line.className = `diag-line diag-${level}`;
  line.textContent = msg;
  diagnostics.appendChild(line);
  while (diagnostics.children.length > 20) diagnostics.removeChild(diagnostics.firstChild);
  diagnostics.scrollTop = diagnostics.scrollHeight;
}

function clearDiag() {
  while (diagnostics.firstChild) diagnostics.removeChild(diagnostics.firstChild);
}

function run() {
  runner.ensureAudio();
  clearDiag();
  const src = getEditorDoc(editor);
  const seed = parseInt(document.getElementById('seed').value, 10);
  const ok = runner.start(src, { seed });
  if (ok) {
    showDiag('ok', `▶ corriendo "${runner.getStatus()?.header.JUEGO || 'sin título'}"`);
    hud.status.textContent = 'jugando';
  } else {
    hud.status.textContent = 'error';
  }
}

document.getElementById('run').addEventListener('click', run);
document.getElementById('pause').addEventListener('click', () => {
  if (!runner.getVm()) return;
  if (runner.getVm().state.paused) runner.resume();
  else runner.pause();
});
document.getElementById('reset').addEventListener('click', () => {
  if (runner.getVm()) run();
});
document.getElementById('step').addEventListener('click', () => {
  if (runner.getVm()) runner.step();
});
document.getElementById('export-png').addEventListener('click', () => {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retrovm-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 'image/png');
});

// --- Open/Save -------------------------------------------------------
const fileInput = document.getElementById('file-input');
document.getElementById('open-file').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  setEditorDoc(editor, text);
  saveDraft(text);
  fileInput.value = '';
});

// --- Editores modales + librería ------------------------------------
document.getElementById('open-pal-editor').addEventListener('click', openPaletteEditor);
document.getElementById('open-spr-editor').addEventListener('click', openSpriteEditor);
document.getElementById('open-snd-editor').addEventListener('click', openSoundEditor);
document.getElementById('open-mem-inspector').addEventListener('click', openMemoryInspector);
document.getElementById('open-lib').addEventListener('click', () => openLibraryMenu('palettes'));

document.getElementById('save-file').addEventListener('click', () => {
  const src = getEditorDoc(editor);
  const name = (deriveJuegoName(src) || 'juego').toLowerCase().replace(/\s+/g, '-');
  const blob = new Blob([src], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.retro`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

function deriveJuegoName(src) {
  const m = src.match(/^\s*JUEGO\s+(.+)$/im);
  return m ? m[1].trim() : null;
}

// --- Atajos de teclado globales --------------------------------------
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // Atajos globales (no chocan con los del juego porque son con modificador).
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    run();
    return;
  }
  if (mod && e.shiftKey && (e.code === 'KeyL' || e.key === 'L')) {
    e.preventDefault();
    openPaletteEditor();
    return;
  }
  if (mod && e.shiftKey && (e.code === 'KeyP' || e.key === 'P')) {
    e.preventDefault();
    openSpriteEditor();
    return;
  }
  if (mod && e.shiftKey && (e.code === 'KeyN' || e.key === 'N')) {
    e.preventDefault();
    openSoundEditor();
    return;
  }
  if (mod && !e.shiftKey && (e.code === 'KeyL' || e.key === 'l')) {
    e.preventDefault();
    openLibraryMenu('palettes');
    return;
  }
  if (mod && e.key === '.') {
    e.preventDefault();
    if (runner.getVm()) runner.step();
    return;
  }
  // El runner se ocupa de las teclas del juego sólo cuando hay VM corriendo.
  if (runner.isRunning()) runner.handleKeyDown(e);
});
window.addEventListener('keyup', (e) => {
  if (runner.isRunning()) runner.handleKeyUp(e);
});

// --- localStorage helpers --------------------------------------------
function loadDraft() {
  try { return localStorage.getItem(STORAGE_KEY); }
  catch (_) { return null; }
}
function saveDraft(text) {
  try { localStorage.setItem(STORAGE_KEY, text); }
  catch (_) { /* full o disabled */ }
}
function loadSetting(key) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw)[key] : null;
  } catch (_) { return null; }
}
function saveSetting(key, value) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
  } catch (_) { /* no-op */ }
}
function hasUnsavedChanges() {
  // Si el draft es distinto del ejemplo seleccionado, asumimos que hay cambios.
  const draft = loadDraft();
  const lastEx = loadSetting('lastExample');
  if (!draft || !lastEx) return false;
  return draft.trim() !== (getExample(lastEx) || '').trim();
}

// --- Mensaje inicial -------------------------------------------------
showDiag('ok', `Listo. Apretá ▶ Correr o Ctrl/Cmd+Enter. Hay ${listExamples().length} ejemplos en el dropdown.`);
