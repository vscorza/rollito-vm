// Memory inspector (v2-H, docs/PLAN.md §18.7).
//
// Modal que dumpea bytes de cualquier región de la memoria virtual de
// 512 KB de la VM. Soporta hex dump y, para CODE, disassembly via
// disasm() de bytecode.js. Lee fresco cada vez (sin cache) usando
// readByte.

import { readByte } from '../../src/core/memory.js';
import { disasm, decodeOpcode } from '../../src/core/bytecode.js';

const REGIONS = [
  { id: 'CODE',  base: 0x00000, size: 0x08000, label: 'CODE  (32 KB · bytecode)' },
  { id: 'STATE', base: 0x08000, size: 0x08000, label: 'STATE (32 KB · vars/arrays/actores/input)' },
  { id: 'SPR',   base: 0x10000, size: 0x08000, label: 'SPR   (32 KB · 32 patrones × 1 KB)' },
  { id: 'MAP',   base: 0x18000, size: 0x04000, label: 'MAP   (16 KB · 4 mapas × 4 KB)' },
  { id: 'PAL',   base: 0x1C000, size: 0x01000, label: 'PAL   (4 KB · 4 paletas × 1 KB)' },
  { id: 'SON',   base: 0x1D000, size: 0x03000, label: 'SON   (12 KB · 16 sonidos × 768 B)' },
  { id: 'FB',    base: 0x20000, size: 0x10000, label: 'FB    (64 KB · framebuffer 320×200)' },
  { id: 'FREE',  base: 0x30000, size: 0x50000, label: 'FREE  (320 KB · scratch del usuario)' },
];

const ROW_BYTES = 16;
const ROW_COUNT = 16;
const PAGE_BYTES = ROW_BYTES * ROW_COUNT;  // 256 B por vista

let dialog = null;
let getVm = null;

let state = {
  regionId: 'CODE',
  addr: 0,
  disasm: false,
};

export function initMemoryInspector(getVmFn) {
  getVm = getVmFn;
  if (dialog) return;
  buildDialog();
  document.body.appendChild(dialog);
}

export function openMemoryInspector() {
  if (!dialog) throw new Error('memory inspector no inicializado');
  refreshAll();
  dialog.showModal();
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'mem-dialog ide-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <header class="ide-dialog-head">
        <h2>Inspector de memoria</h2>
        <button class="ide-dialog-close" value="cancel" aria-label="Cerrar">×</button>
      </header>
      <div class="ide-dialog-body">
        <div class="mem-toolbar">
          <label>Región
            <select id="mem-region">
              ${REGIONS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}
            </select>
          </label>
          <label>Dirección
            <input id="mem-addr" type="text" value="0x00000" spellcheck="false" />
          </label>
          <button type="button" id="mem-prev" title="página anterior (-256 B)">◀</button>
          <button type="button" id="mem-next" title="página siguiente (+256 B)">▶</button>
          <button type="button" id="mem-refresh" title="re-leer la VM">↻ Actualizar</button>
          <label class="mem-disasm-toggle">
            <input type="checkbox" id="mem-disasm" />
            disasm (sólo CODE)
          </label>
        </div>
        <pre id="mem-dump" class="mem-dump"></pre>
        <p class="mem-hint" id="mem-hint"></p>
      </div>
      <footer class="ide-dialog-foot">
        <button value="cancel" class="ide-primary">Cerrar</button>
      </footer>
    </form>
  `;

  dialog.querySelector('#mem-region').addEventListener('change', (e) => {
    const r = REGIONS.find((x) => x.id === e.target.value);
    if (!r) return;
    state.regionId = r.id;
    state.addr = r.base;
    refreshAll();
  });
  dialog.querySelector('#mem-addr').addEventListener('change', (e) => {
    const v = parseAddr(e.target.value);
    if (v == null) return;
    state.addr = v;
    refreshAll();
  });
  dialog.querySelector('#mem-prev').addEventListener('click', () => {
    state.addr = Math.max(0, state.addr - PAGE_BYTES);
    refreshAll();
  });
  dialog.querySelector('#mem-next').addEventListener('click', () => {
    state.addr = Math.min(0x80000 - PAGE_BYTES, state.addr + PAGE_BYTES);
    refreshAll();
  });
  dialog.querySelector('#mem-refresh').addEventListener('click', refreshDump);
  dialog.querySelector('#mem-disasm').addEventListener('change', (e) => {
    state.disasm = !!e.target.checked;
    refreshDump();
  });
}

function parseAddr(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (t.startsWith('0x')) {
    const n = parseInt(t.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function fmtHex(n, w) {
  return n.toString(16).toUpperCase().padStart(w, '0');
}

function refreshAll() {
  const sel = dialog.querySelector('#mem-region');
  sel.value = state.regionId;
  const addrInput = dialog.querySelector('#mem-addr');
  addrInput.value = '0x' + fmtHex(state.addr, 5);
  dialog.querySelector('#mem-disasm').checked = state.disasm;
  refreshDump();
}

function refreshDump() {
  const out = dialog.querySelector('#mem-dump');
  const hint = dialog.querySelector('#mem-hint');
  const vm = getVm && getVm();
  if (!vm) {
    out.textContent = '(VM no inicializada — apretá "Correr" antes)';
    hint.textContent = '';
    return;
  }
  if (state.disasm && state.regionId === 'CODE') {
    out.textContent = renderDisasm(vm);
  } else {
    out.textContent = renderHexDump(vm);
  }
  const region = REGIONS.find((r) => r.id === state.regionId);
  hint.textContent = region
    ? `${region.label} · base=0x${fmtHex(region.base, 5)} · size=${region.size} B`
    : '';
}

function renderHexDump(vm) {
  const lines = [];
  for (let row = 0; row < ROW_COUNT; row++) {
    const a = state.addr + row * ROW_BYTES;
    if (a >= 0x80000) break;
    const hex = [];
    const ascii = [];
    for (let i = 0; i < ROW_BYTES; i++) {
      const b = readByte(vm.state, vm, a + i) & 0xff;
      hex.push(fmtHex(b, 2));
      ascii.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
    }
    lines.push(
      `0x${fmtHex(a, 5)}  ` +
      hex.slice(0, 8).join(' ') + '  ' +
      hex.slice(8).join(' ') + '  ' +
      ascii.join(''),
    );
  }
  return lines.join('\n');
}

function renderDisasm(vm) {
  // En CODE el state.addr puede no estar word-aligned; lo redondeamos.
  const startByte = state.addr & ~0x3;
  const startWord = startByte >>> 2;
  const lines = [];
  const code = vm.code;
  if (!code) return '(sin bytecode)';
  for (let i = 0; i < ROW_COUNT * 4; i++) {
    const wIdx = startWord + i;
    if (wIdx >= code.length) break;
    const w = code[wIdx] >>> 0;
    const op = decodeOpcode(w);
    if (op === 0 && i > 8) break;  // padding de NOPs al final
    lines.push(`@${fmtHex(wIdx, 4)}  ${disasm(w, wIdx).trim()}  ; word=0x${fmtHex(w, 8)}`);
  }
  return lines.join('\n');
}
