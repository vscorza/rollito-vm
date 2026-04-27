// Estado de input. El browser hookea keydown/keyup para mantener
// `buttons` y `keys` actualizados; el VM los lee vía BTN(b) y TEC(k).
//
// Buttons — 8 slots según docs/PLAN.md §8.3:
//   0 izquierda, 1 derecha, 2 arriba, 3 abajo,
//   4 A, 5 B, 6 INICIO, 7 SELECCIONAR.

export const BUTTON_COUNT = 8;
export const KEY_COUNT = 256;

export function createInputState() {
  return {
    buttons: new Uint8Array(BUTTON_COUNT),
    keys: new Uint8Array(KEY_COUNT),
  };
}
