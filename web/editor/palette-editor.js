import { PALETTE_DB, buildPaletteBlock, findPaletteBlock } from '../library/palettes.js';
import { insertAtCursor, getEditorDoc } from './codemirror.js';

// Editor visual de paletas. Modal con 16 slots de color editables + presets
// del PALETTE_DB. Exporta el bloque `PALETA n` listo para insertar.

let dialog = null;
let editorView = null;       // referencia al CodeMirror principal
let slotInputs = [];         // 16 { swatch, hex } para los slots
let currentColors = new Array(16).fill('000000');

export function initPaletteEditor(view) {
  editorView = view;
  if (dialog) return;
  buildDialog();
  document.body.appendChild(dialog);
}

export function openPaletteEditor() {
  if (!dialog) throw new Error('palette editor no inicializado');
  // Default: cargar PICO-8.
  loadFromDb(PALETTE_DB[0].name);
  dialog.showModal();
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'pal-dialog ide-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <header class="ide-dialog-head">
        <h2>Editor de paletas</h2>
        <button class="ide-dialog-close" value="cancel" aria-label="Cerrar">×</button>
      </header>
      <div class="ide-dialog-body">
        <div class="pal-toolbar">
          <label>Slot
            <input type="number" id="pal-slot" min="0" max="3" value="0" />
          </label>
          <label>Cargar preset
            <select id="pal-preset"></select>
          </label>
          <button type="button" id="pal-load-from-code">Cargar PALETA n del código</button>
        </div>
        <div class="pal-grid" id="pal-grid"></div>
        <div class="pal-preview" id="pal-preview" aria-hidden="true"></div>
      </div>
      <footer class="ide-dialog-foot">
        <button value="cancel">Cancelar</button>
        <button value="default" id="pal-insert" class="ide-primary">Insertar al cursor</button>
      </footer>
    </form>
  `;

  // Llenar el preset selector.
  const sel = dialog.querySelector('#pal-preset');
  for (const p of PALETTE_DB) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => loadFromDb(sel.value));

  // Construir 16 slots.
  const grid = dialog.querySelector('#pal-grid');
  slotInputs = [];
  for (let i = 0; i < 16; i++) {
    const cell = document.createElement('div');
    cell.className = 'pal-cell';
    cell.innerHTML = `
      <span class="pal-cell-idx">${i.toString(16).toUpperCase()}</span>
      <input type="color" class="pal-cell-swatch" value="#000000" aria-label="Slot ${i}" />
      <input type="text" class="pal-cell-hex" maxlength="6" pattern="[0-9A-Fa-f]{6}" value="000000" />
    `;
    grid.appendChild(cell);
    const swatch = cell.querySelector('.pal-cell-swatch');
    const hex = cell.querySelector('.pal-cell-hex');
    swatch.addEventListener('input', () => {
      const v = swatch.value.slice(1).toUpperCase();
      hex.value = v;
      currentColors[i] = v;
      refreshPreview();
    });
    hex.addEventListener('input', () => {
      const v = hex.value.toUpperCase();
      if (/^[0-9A-Fa-f]{6}$/.test(v)) {
        swatch.value = '#' + v;
        currentColors[i] = v;
        refreshPreview();
      }
    });
    slotInputs.push({ swatch, hex });
  }

  // Listeners de los botones.
  dialog.querySelector('#pal-load-from-code').addEventListener('click', loadFromCode);
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'default') doInsert();
  });
}

function loadFromDb(name) {
  const p = PALETTE_DB.find((p) => p.name === name);
  if (!p) return;
  setColors(p.colors);
}

function loadFromCode() {
  if (!editorView) return;
  const slot = parseInt(dialog.querySelector('#pal-slot').value, 10);
  const found = findPaletteBlock(getEditorDoc(editorView), slot);
  if (!found) {
    alert(`No se encontró PALETA ${slot} en el código.`);
    return;
  }
  setColors(found.colors);
}

function setColors(colors) {
  for (let i = 0; i < 16; i++) {
    const c = (colors[i] || '000000').toUpperCase();
    currentColors[i] = c;
    slotInputs[i].swatch.value = '#' + c;
    slotInputs[i].hex.value = c;
  }
  refreshPreview();
}

function refreshPreview() {
  const preview = dialog.querySelector('#pal-preview');
  if (!preview) return;
  preview.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const sw = document.createElement('span');
    sw.className = 'pal-preview-swatch';
    sw.style.background = '#' + currentColors[i];
    sw.title = `${i}: #${currentColors[i]}`;
    preview.appendChild(sw);
  }
}

function doInsert() {
  if (!editorView) return;
  const slot = parseInt(dialog.querySelector('#pal-slot').value, 10);
  const block = buildPaletteBlock(slot, currentColors);
  insertAtCursor(editorView, block);
}
