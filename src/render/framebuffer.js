export const WIDTH = 320;
export const HEIGHT = 200;
export const PIXELS = WIDTH * HEIGHT;

// Blit hot-path. Mapea cada índice del framebuffer indexado a su entrada
// RGBA en el "PaletteBank" y lo escribe en el buffer RGBA de salida.
//
// Camino rápido (scanlineDirty=false): una sola LUT para todo el cuadro,
// loop plano de PIXELS iteraciones. Es el caso común — sólo cambia cuando
// el código del juego enganchó un swap por scanline.
//
// Camino lento (scanlineDirty=true): walk por scanline, switch de LUT
// barato cuando hay override. Cada switch es una asignación a la variable
// local `lut`. La regeneración de LUT no ocurre acá — `setPalette` ya la
// dejó precomputada en el bank.
export function blit(fb, bank, rgba32) {
  if (!bank.scanlineDirty) {
    const lut = bank.activeLut;
    for (let i = 0; i < PIXELS; i++) {
      rgba32[i] = lut[fb[i]];
    }
    return;
  }
  const views = bank.views;
  const overrides = bank.scanlineOverride;
  let lut = bank.activeLut;
  let p = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const ov = overrides[y];
    if (ov >= 0) lut = views[ov];
    for (let x = 0; x < WIDTH; x++) {
      rgba32[p] = lut[fb[p]];
      p++;
    }
  }
}

// Pinta un gradiente de índices en el framebuffer indexado. El offset
// depende del frame, así el demo muestra el ciclo entero de 16 colores
// deslizándose horizontalmente.
export function paintGradientIndexed(fb, frame) {
  const offset = frame & 0xff;
  let i = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      fb[i++] = ((x + y + offset) >> 2) & 0x0f;
    }
  }
}
