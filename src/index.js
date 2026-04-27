export { WIDTH, HEIGHT, PIXELS, blit, paintGradientIndexed } from './render/framebuffer.js';
export {
  PALETTE_SIZE, MAX_PALETTES, DEFAULT_PALETTE,
  createPaletteBank, setPalette, setActivePalette,
  setScanlinePalette, clearScanlineOverrides,
} from './render/palette.js';
export { tokenize, KEYWORDS, BUILTINS, FUNCTIONS, SPECIAL_VARS } from './parser/lexer.js';
export { parseProgram, parseStatement } from './parser/parser.js';
export { compile } from './parser/compiler.js';
export { lint, MAX_LINE_LENGTH } from './parser/linter.js';
export { createVM } from './core/vm.js';
export { attachAudioContext, TOTAL_CHANNELS } from './audio/synth.js';
