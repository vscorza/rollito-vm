import { PALETTE_DB, buildPaletteBlock } from '../library/palettes.js';
import { SPRITE_DB, buildSpriteBlock } from '../library/sprites.js';
import { SOUND_DB, buildSoundBlock } from '../library/sounds.js';
import { MAP_DB, buildMapBlock } from '../library/maps.js';
import { insertAtCursor } from './codemirror.js';

// Menú único de "Librería" — un dialog que tabula entre paletas, sprites
// y sonidos. Cada entrada tiene preview + click para insertar. El slot
// para cada bloque se pide en un input arriba.

let dialog = null;
let editorView = null;

const TABS = [
  { id: 'palettes', label: 'Paletas', db: PALETTE_DB },
  { id: 'sprites',  label: 'Sprites', db: SPRITE_DB },
  { id: 'sounds',   label: 'Sonidos', db: SOUND_DB },
  { id: 'maps',     label: 'Mapas',   db: MAP_DB },
];

let currentTab = 'palettes';

export function initLibraryMenu(view) {
  editorView = view;
  if (dialog) return;
  buildDialog();
  document.body.appendChild(dialog);
}

export function openLibraryMenu(tab = 'palettes') {
  if (!dialog) throw new Error('library menu no inicializado');
  setTab(tab);
  dialog.showModal();
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'lib-dialog ide-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <header class="ide-dialog-head">
        <h2>Librería</h2>
        <button class="ide-dialog-close" value="cancel" aria-label="Cerrar">×</button>
      </header>
      <div class="ide-dialog-body">
        <nav class="lib-tabs">
          ${TABS.map(t => `<button type="button" class="lib-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
        </nav>
        <div class="lib-toolbar">
          <label>Slot
            <input type="number" id="lib-slot" min="0" max="31" value="0" />
          </label>
          <span class="lib-help">Click en un item para insertar al cursor.</span>
        </div>
        <ul class="lib-list" id="lib-list"></ul>
      </div>
      <footer class="ide-dialog-foot">
        <button value="cancel">Cerrar</button>
      </footer>
    </form>
  `;

  for (const btn of dialog.querySelectorAll('.lib-tab')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
}

function setTab(id) {
  currentTab = id;
  for (const btn of dialog.querySelectorAll('.lib-tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === id);
  }
  refreshList();
}

function refreshList() {
  const tab = TABS.find((t) => t.id === currentTab);
  const list = dialog.querySelector('#lib-list');
  list.innerHTML = '';
  for (const entry of tab.db) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    li.innerHTML = `
      <header class="lib-item-head">
        <strong>${entry.name}</strong>
        <span>${entry.description}</span>
      </header>
      <div class="lib-item-preview"></div>
    `;
    const preview = li.querySelector('.lib-item-preview');
    if (currentTab === 'palettes')      renderPalettePreview(preview, entry);
    else if (currentTab === 'sprites')  renderSpritePreview(preview, entry);
    else if (currentTab === 'sounds')   renderSoundPreview(preview, entry);
    else if (currentTab === 'maps')     renderMapPreview(preview, entry);
    li.addEventListener('click', () => insert(entry));
    list.appendChild(li);
  }
}

function renderPalettePreview(host, p) {
  for (let i = 0; i < 16; i++) {
    const sw = document.createElement('span');
    sw.className = 'lib-preview-swatch';
    sw.style.background = '#' + p.colors[i];
    host.appendChild(sw);
  }
}

function renderSpritePreview(host, s) {
  const canvas = document.createElement('canvas');
  canvas.width = s.width; canvas.height = s.height;
  canvas.className = 'lib-preview-sprite';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.width = `${s.width * 4}px`;
  canvas.style.height = `${s.height * 4}px`;
  const ctx = canvas.getContext('2d');
  // Pinta usando una paleta default; los 0 quedan transparentes.
  const pal = PALETTE_DB[0].colors;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const ch = s.rows[y][x];
      const idx = parseInt(ch, 16);
      if (idx === 0) continue;
      ctx.fillStyle = '#' + pal[idx];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  host.appendChild(canvas);
}

function renderSoundPreview(host, s) {
  // Mostramos como bloque de texto monoespaciado.
  const pre = document.createElement('pre');
  pre.className = 'lib-preview-sound';
  pre.textContent = s.block.replace('{n}', '0').trim();
  host.appendChild(pre);
}

function renderMapPreview(host, m) {
  // Canvas chico tipo minimapa: un pixel = una celda. Color 0 transparente,
  // resto un gris claro distinguible.
  const canvas = document.createElement('canvas');
  canvas.width = m.cols; canvas.height = m.rows;
  canvas.className = 'lib-preview-map';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.width  = `${Math.min(m.cols * 6, 320)}px`;
  canvas.style.height = `${Math.min(m.rows * 6, 240)}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a1530';
  ctx.fillRect(0, 0, m.cols, m.rows);
  ctx.fillStyle = '#c2c3c7';
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (m.cells[y][x] !== '0') ctx.fillRect(x, y, 1, 1);
    }
  }
  host.appendChild(canvas);
}

function insert(entry) {
  if (!editorView) return;
  const slot = parseInt(dialog.querySelector('#lib-slot').value, 10) | 0;
  let block;
  if (currentTab === 'palettes')      block = buildPaletteBlock(slot, entry.colors);
  else if (currentTab === 'sprites')  block = buildSpriteBlock(slot, entry);
  else if (currentTab === 'sounds')   block = buildSoundBlock(slot, entry);
  else if (currentTab === 'maps')     block = buildMapBlock(slot, entry);
  insertAtCursor(editorView, block);
  dialog.close('default');
}
