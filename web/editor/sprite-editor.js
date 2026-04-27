import { PALETTE_DB, findPaletteBlock } from '../library/palettes.js';
import { insertAtCursor, getEditorDoc } from './codemirror.js';

// Editor visual de sprites. Modal con grilla pintable, paleta activa
// (16 swatches), selector de tamaño 8x8 / 8x16 / 16x8 / 16x16,
// tools básicas. Exporta `SPRITE n WxH` + grid hex.

const SIZES = [
  { w: 8, h: 8, label: '8x8' },
  { w: 16, h: 8, label: '16x8' },
  { w: 8, h: 16, label: '8x16' },
  { w: 16, h: 16, label: '16x16' },
];

const VALID_HEX_DIGITS = '0123456789ABCDEF';

let dialog = null;
let editorView = null;

let state = {
  w: 8, h: 8,
  pixels: new Uint8Array(8 * 8),
  activeColor: 1,
  palette: PALETTE_DB[0].colors.slice(),
};

export function initSpriteEditor(view) {
  editorView = view;
  if (dialog) return;
  buildDialog();
  document.body.appendChild(dialog);
}

export function openSpriteEditor() {
  if (!dialog) throw new Error('sprite editor no inicializado');
  // Reset al abrir: tamaño default 8x8, color 1, paleta default.
  setSize(8, 8);
  state.activeColor = 1;
  state.palette = PALETTE_DB[0].colors.slice();
  refreshAll();
  dialog.showModal();
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'spr-dialog ide-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <header class="ide-dialog-head">
        <h2>Editor de sprites</h2>
        <button class="ide-dialog-close" value="cancel" aria-label="Cerrar">×</button>
      </header>
      <div class="ide-dialog-body">
        <div class="spr-toolbar">
          <label>Tamaño
            <select id="spr-size">
              ${SIZES.map((s, i) => `<option value="${i}">${s.label}</option>`).join('')}
            </select>
          </label>
          <label>Slot
            <input type="number" id="spr-slot" min="0" max="31" value="0" />
          </label>
          <button type="button" id="spr-load-pal">Cargar paleta del código</button>
          <span class="ide-sep"></span>
          <button type="button" id="spr-clear" title="Vaciar">Limpiar</button>
          <button type="button" id="spr-flip-x" title="Espejar X">↔</button>
          <button type="button" id="spr-flip-y" title="Espejar Y">↕</button>
        </div>
        <div class="spr-paint-row">
          <div class="spr-grid-wrap">
            <div id="spr-grid" class="spr-grid"></div>
            <p class="spr-hint">click izq pinta · click der borra (transparente)</p>
          </div>
          <div class="spr-side">
            <div class="spr-palette" id="spr-palette" aria-label="Paleta activa"></div>
            <p class="spr-active">Color actual: <span id="spr-active-idx">1</span></p>
            <div class="spr-preview-wrap">
              <p class="spr-help">vista previa 1x:</p>
              <canvas id="spr-preview" width="16" height="16"></canvas>
            </div>
          </div>
        </div>
      </div>
      <footer class="ide-dialog-foot">
        <button value="cancel">Cancelar</button>
        <button value="default" class="ide-primary">Insertar al cursor</button>
      </footer>
    </form>
  `;

  dialog.querySelector('#spr-size').addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10) | 0;
    setSize(SIZES[idx].w, SIZES[idx].h);
    refreshGrid();
    refreshPreview();
  });
  dialog.querySelector('#spr-clear').addEventListener('click', () => {
    state.pixels.fill(0);
    refreshGrid();
    refreshPreview();
  });
  dialog.querySelector('#spr-flip-x').addEventListener('click', () => {
    flipX();
    refreshGrid();
    refreshPreview();
  });
  dialog.querySelector('#spr-flip-y').addEventListener('click', () => {
    flipY();
    refreshGrid();
    refreshPreview();
  });
  dialog.querySelector('#spr-load-pal').addEventListener('click', () => {
    if (!editorView) return;
    const slot = 0;
    const found = findPaletteBlock(getEditorDoc(editorView), slot);
    if (!found) {
      alert(`No se encontró PALETA ${slot} en el código. Sigue la paleta default.`);
      return;
    }
    state.palette = found.colors;
    refreshPalette();
    refreshGrid();
    refreshPreview();
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'default') doInsert();
  });
}

function setSize(w, h) {
  state.w = w;
  state.h = h;
  state.pixels = new Uint8Array(w * h);
}

function refreshAll() {
  refreshPalette();
  refreshGrid();
  refreshActive();
  refreshPreview();
}

function refreshPalette() {
  const pal = dialog.querySelector('#spr-palette');
  pal.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'spr-pal-swatch';
    if (i === 0) sw.classList.add('is-transparent');
    sw.style.background = i === 0 ? 'transparent' : '#' + state.palette[i];
    sw.title = `${i}: ${i === 0 ? 'transparente' : '#' + state.palette[i]}`;
    sw.dataset.idx = i;
    sw.textContent = i.toString(16).toUpperCase();
    if (i === state.activeColor) sw.classList.add('is-active');
    sw.addEventListener('click', () => {
      state.activeColor = i;
      refreshPalette();
      refreshActive();
    });
    pal.appendChild(sw);
  }
}

function refreshActive() {
  const span = dialog.querySelector('#spr-active-idx');
  if (span) span.textContent = state.activeColor.toString(16).toUpperCase();
}

function refreshGrid() {
  const grid = dialog.querySelector('#spr-grid');
  grid.style.gridTemplateColumns = `repeat(${state.w}, 1fr)`;
  grid.style.aspectRatio = `${state.w} / ${state.h}`;
  grid.innerHTML = '';
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      const i = y * state.w + x;
      const cell = document.createElement('div');
      cell.className = 'spr-cell';
      paintCell(cell, state.pixels[i]);
      cell.addEventListener('mousedown', (e) => {
        if (e.button === 2) state.pixels[i] = 0;
        else state.pixels[i] = state.activeColor;
        paintCell(cell, state.pixels[i]);
        refreshPreview();
      });
      cell.addEventListener('mouseenter', (e) => {
        if (e.buttons === 1) {
          state.pixels[i] = state.activeColor;
          paintCell(cell, state.pixels[i]);
          refreshPreview();
        } else if (e.buttons === 2) {
          state.pixels[i] = 0;
          paintCell(cell, 0);
          refreshPreview();
        }
      });
      cell.addEventListener('contextmenu', (e) => e.preventDefault());
      grid.appendChild(cell);
    }
  }
}

function paintCell(cell, value) {
  cell.dataset.idx = value;
  if (value === 0) {
    cell.style.background = '';
    cell.classList.add('is-transparent');
  } else {
    cell.style.background = '#' + state.palette[value];
    cell.classList.remove('is-transparent');
  }
}

function refreshPreview() {
  const canvas = dialog.querySelector('#spr-preview');
  if (!canvas) return;
  canvas.width = state.w;
  canvas.height = state.h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, state.w, state.h);
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      const v = state.pixels[y * state.w + x];
      if (v === 0) continue;
      ctx.fillStyle = '#' + state.palette[v];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function flipX() {
  const out = new Uint8Array(state.pixels.length);
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      out[y * state.w + (state.w - 1 - x)] = state.pixels[y * state.w + x];
    }
  }
  state.pixels = out;
}

function flipY() {
  const out = new Uint8Array(state.pixels.length);
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      out[(state.h - 1 - y) * state.w + x] = state.pixels[y * state.w + x];
    }
  }
  state.pixels = out;
}

function doInsert() {
  if (!editorView) return;
  const slot = parseInt(dialog.querySelector('#spr-slot').value, 10);
  const lines = [`SPRITE ${slot} ${state.w}x${state.h}`];
  for (let y = 0; y < state.h; y++) {
    let row = '';
    for (let x = 0; x < state.w; x++) {
      row += VALID_HEX_DIGITS[state.pixels[y * state.w + x] & 0x0f];
    }
    lines.push(row);
  }
  insertAtCursor(editorView, lines.join('\n') + '\n');
}
