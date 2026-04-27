# RetroVM — Plan del editor web (Hito 9)

> Reemplazar la página single-canvas actual por una IDE en el navegador para
> escribir, probar y compartir programas `.retro` sin salir del browser.

## Contexto

Hoy la página de [web/](../web/) carga un `.retro` hardcodeado vía `?raw` y lo
corre en un canvas. Para cumplir con el espíritu del proyecto — "tipear un
programa de la revista y verlo correr" — necesitamos que el usuario pueda
escribir su propio código en el navegador, probarlo en vivo y tener herramientas
visuales para los assets retro (sprites, paletas, sonidos).

Este hito convierte la página en una IDE minimal pero completa.

## Tomas de decisión arquitectónicas

| Decisión                | Elección                                  | Por qué                                                            |
|-------------------------|-------------------------------------------|--------------------------------------------------------------------|
| Editor de código        | **CodeMirror 6**                          | Liviano (~30 KB gzip core), modular, modo `StreamLanguage` permite definir `.retro` con regex sin un parser Lezer completo. Monaco pesa 2 MB+, Prism es read-only. |
| Carga de ejemplos       | **`import.meta.glob`** de Vite            | `import.meta.glob('../games/*.retro', { query: '?raw', eager: true })` resuelve todos los .retro a build-time, sin necesidad de servidor. |
| Persistencia            | **`localStorage`** para borrador, `<input type="file">` + `FileReader` para abrir, blob download para guardar | Sin backend; el código del usuario sobrevive recargas. |
| Layout                  | **Grid CSS** 2 columnas (editor 60%, panel 40%) | Editor es la zona principal; canvas + controles a la derecha. Modales para sprite/paleta/sonido editors. |
| Linter inline           | Reusa [src/parser/linter.js](../src/parser/linter.js) + errores del parser | Ya existe; sólo hay que conectarlo al editor para anotar líneas. |
| Atajos                  | Ctrl/Cmd + Enter (correr), Ctrl/Cmd + S (guardar local), Ctrl/Cmd + O (abrir), Ctrl/Cmd + L (librería) | Ergonomía estándar de IDEs. |

## Layout objetivo

```
┌──────────────────────────────────────────────────────────────────────┐
│ RetroVM IDE                                          [docs] [tutorial]│
├──────────────────────────────────────────────────────────────────────┤
│ [Ejemplo: serpiente ▾] [Abrir...] [Guardar] [▶ Correr]  Lib: [Pal] [Spr] [Son] [Map]│
├────────────────────────────────────┬─────────────────────────────────┤
│                                    │ ┌─────────────────────────────┐ │
│  10 EN INICIOJUEGO IR 90           │ │                             │ │
│  20 EN CUADRO IR 100               │ │       (canvas 320x200       │ │
│  ...                               │ │        scaled 2x = 640x400) │ │
│  (CodeMirror 6 con syntax          │ │                             │ │
│   highlighting de .retro)          │ │                             │ │
│                                    │ └─────────────────────────────┘ │
│                                    │ Estado: jugando · CUA: 1234     │
│                                    │ PUN: 5 · L: 8 · seed: 42        │
│                                    │ ┌─────────────────────────────┐ │
│                                    │ │ [Pausa] [Reset] [⏪ ⏵ ⏩]    │ │
│                                    │ └─────────────────────────────┘ │
├────────────────────────────────────┴─────────────────────────────────┤
│ ⚠ L23 (33 chars >32): SI BTN(0) Y D<>1 ENT D=3 :B=B+1                │
│ ✗ L45: salto a línea 999 no existe                                   │
└──────────────────────────────────────────────────────────────────────┘
```

Ediciones de assets (sprite/paleta/sonido) se abren como **diálogo modal** que
ocupa la mitad superior de la página, con botón "Insertar al cursor" + "Cerrar".

## Estructura de archivos nueva

```
web/
├── index.html          (re-armado: header + grid + modales)
├── style.css           (variables + layout grid + tema retro)
├── main.js             (entrypoint: orquesta todo)
├── editor/
│   ├── codemirror.js   (setup CodeMirror 6 + tema)
│   ├── retro-mode.js   (StreamLanguage: highlight de .retro)
│   ├── linter-bridge.js (bridge al linter del VM, devuelve diagnostics CM6)
│   ├── examples.js     (import.meta.glob de games/*.retro, dropdown)
│   ├── runner.js       (controla el VM: arranque, pause, reset, audio gesture)
│   ├── library.js      (DB de snippets predefinidos por categoría + insert)
│   ├── sprite-editor.js  (modal: grilla pintable + export SPRITE n WxH)
│   ├── palette-editor.js (modal: 16 slots de color + export hex array)
│   └── sound-editor.js   (modal: form ONDA/ENV/notas + play + export)
├── library/
│   ├── palettes.js     (PALETTE_DB: PICO-8, GameBoy, NES, etc.)
│   ├── sprites.js      (SPRITE_DB: balls, players, coins, enemies, tiles)
│   ├── sounds.js       (SOUND_DB: beep, jump, coin, explosion, etc.)
│   └── maps.js         (MAP_DB: floor, platform set, dungeon room, etc.)
└── ide.css             (estilos de modales y editores visuales)
```

Ningún cambio en `src/` — el VM ya expone todo lo necesario.

## Componentes en detalle

### 1. Editor de código con syntax highlighting

[web/editor/retro-mode.js](web/editor/retro-mode.js):

```js
import { StreamLanguage } from '@codemirror/language';
import { KEYWORDS, BUILTINS, FUNCTIONS } from '../../src/parser/lexer.js';

export const retroLanguage = StreamLanguage.define({
  startState: () => ({ inSonido: false, inSprite: false, inMapa: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/;.*$/)) return 'comment';

    // Bloques top-level (header keywords)
    if (stream.match(/^(JUEGO|AUTOR|VERSION|SPRITE|MAPA|SONIDO|PALETA|PROGRAMA)\b/)) {
      return 'keyword strong';
    }
    if (stream.match(/^(ONDA|PUL|ENV|NOTA|SIL|FIN|TRI|SIE|SEN)\b/)) return 'keyword';

    // Strings
    if (stream.match(/"[^"]*"/)) return 'string';

    // Línea numerada al inicio
    if (stream.sol() && stream.match(/^\s*\d+/)) return 'number-prefix';

    // Operadores
    if (stream.match(/(<=|>=|<>|\+=|-=|\*=|\/=|[+\-*/%<>=,():])/)) return 'operator';

    // Números
    if (stream.match(/\d+/)) return 'number';

    // Palabras: keyword / builtin / function / variable
    if (stream.match(/[A-Za-z]\w*/)) {
      const word = stream.current().toUpperCase();
      if (KEYWORDS.has(word))  return 'keyword';
      if (BUILTINS.has(word))  return 'def';        // BOR, MOV, REC, …
      if (FUNCTIONS.has(word)) return 'builtin';    // X, Y, BTN, ALE, …
      if (/^M[0-7]$/.test(word)) return 'builtin';
      return 'variable';
    }
    stream.next();
    return null;
  },
});
```

Tema con colores tipo CRT: fondo `#0a1530`, texto `#c0f0ff`, keywords `#ff77a8`,
builtins `#29adff`, funciones `#FFEC27`, números `#ff8040`, comentarios `#5f574f`.

**Linter bridge**: cada vez que el código cambia (debounced 300 ms), correr
`lint(code)` del VM + intentar `parseProgram(code)` en try/catch. Convertir los
warnings/errors a `Diagnostic[]` de `@codemirror/lint`. Los markers aparecen en
el gutter y el subrayado.

### 2. Botón "Correr"

[web/editor/runner.js](web/editor/runner.js):

```js
let vm = null;
let rafId = null;
let audioCtx = null;

export function run(source) {
  stop();
  try {
    vm = createVM(source, { seed: parseInt(document.getElementById('seed').value, 10) || 0x12345678 });
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (audioCtx) attachAudioContext(vm.synth, audioCtx);
    loop();
  } catch (e) {
    showError(e);
  }
}

export function stop() { if (rafId) cancelAnimationFrame(rafId); }
```

El botón "Correr" llama `run(editor.getValue())`. El loop hace rAF. Botones
secundarios: Pause/Resume (vm.pause/resume), Reset (re-run desde cero), Step
(runFrame manual una vez para debugging).

**HUD live**: mostrar `state.vars[CUA/PUN/NIV/L]` actualizado cada N cuadros.

### 3. Selector de ejemplos / abrir archivo

[web/editor/examples.js](web/editor/examples.js):

```js
const modules = import.meta.glob('../../games/*.retro', { query: '?raw', import: 'default', eager: true });
export const EXAMPLES = Object.fromEntries(
  Object.entries(modules).map(([path, src]) => {
    const name = path.replace(/^.*\//, '').replace(/\.retro$/, '');
    return [name, src];
  })
);
```

UI: un `<select>` con todos los nombres + opción "Abrir archivo...". Al
seleccionar un ejemplo, sobreescribe el editor (con confirmación si hay cambios
sin guardar). Al elegir "Abrir archivo...", dispara `<input type="file"
accept=".retro">` y carga via `FileReader`.

### 4. Links a docs y tutorial

Header con dos `<a target="_blank">`:
- "Referencia" → [`/docs/REFERENCIA.md`](../docs/REFERENCIA.md) (Vite sirve archivos del repo).
- "Tutorial Serpiente" → [`/docs/TUTORIAL.md`](../docs/TUTORIAL.md).

Como Vite no renderiza Markdown nativo, hay dos opciones:
- A: Servir como texto plano (`<pre>`). Funcional pero feo.
- B: Bundlear `marked` (~30 KB) y renderizar el MD a HTML en una página secundaria.
- C: Convertir a HTML estático en build-time vía un plugin Vite. Cleanest.

**Recomendado: C.** Configurar `vite-plugin-md` o un plugin custom que pre-genere
`docs/REFERENCIA.html` y `docs/TUTORIAL.html` durante `vite build`. En `dev`,
servir vía un middleware simple.

### 5. Librería de snippets predefinidos

[web/library/](web/library/) — archivos JS que exportan datos:

```js
// web/library/palettes.js
export const PALETTE_DB = [
  {
    name: 'PICO-8',
    description: '16 colores estilo PICO-8 (default del VM)',
    block: `PALETA 0
000000 1D2B53 7E2553 008751
AB5236 5F574F C2C3C7 FFF1E8
FF004D FFA300 FFEC27 00E436
29ADFF 83769C FF77A8 FFCCAA`,
  },
  { name: 'Game Boy', description: '4 verdes clásicos × 4 tonos', block: '...' },
  { name: 'NES', description: '...', block: '...' },
  { name: 'CGA', description: 'IBM CGA palette 1 (cyan/magenta)', block: '...' },
];
```

[web/library/sprites.js](web/library/sprites.js):
- "Pelota 8x8", "Player walking 8x8 (2 frames)", "Coin 8x8", "Enemy 8x8",
  "Floor brick 16x16", "Ladder 8x16", etc.

[web/library/sounds.js](web/library/sounds.js):
- "Salto", "Pickup moneda", "Game over", "Disparo", "Click UI", "Música intro corta", etc.

[web/library/maps.js](web/library/maps.js):
- "Floor + 2 platforms 20x12", "Dungeon room 16x16", "Maze 32x20", etc.

UI: menú "Lib" en el header desplega categorías. Al seleccionar un snippet:
- Muestra preview (color swatch para paletas, mini-canvas para sprites/maps).
- Botón "Insertar al cursor" agrega el bloque en la posición actual del editor,
  con auto-renumeración de slots si es necesario (ej. si ya hay un SPRITE 0,
  inserta como SPRITE 1).

### 6. Editor visual de sprites

Modal abierto con Ctrl+Shift+P o desde el menú Lib > Sprites > "Crear nuevo".

Componentes:
- **Selector de tamaño**: 8×8, 8×16, 16×8, 16×16 (radio buttons).
- **Paleta activa**: muestra los 16 colores como swatches; click para elegir el
  color actual de pintura. Por default carga la PICO-8 default; opcional cargar
  desde el bloque PALETA del programa actual.
- **Grilla pintable**: matriz de cells clickables (cada una es un `<button>` o
  `<div>` con `onclick`). Click pinta con el color actual; right-click o tecla
  Shift pinta transparente (color 0).
- **Toolbar**: Limpiar, Espejar X, Espejar Y, Rotar 90, Tomar muestra (eye-dropper).
- **Preview en zoom 1×** al lado del editor.
- **Slot index** (0..31) en input numérico.
- **Botones**: "Insertar al cursor" pega el bloque `SPRITE n WxH\n<grid hex>` en
  el editor; "Reemplazar SPRITE n" si ya existe; "Cerrar".

### 7. Editor visual de paletas

Modal con 16 slots dispuestos en grilla 4×4. Cada slot:
- Un cuadrado grande con el color actual.
- Un input `<input type="color">` y un input de texto hex (sincronizados).
- Un botón pequeño "Sample" para tomar de un swatch existente.

Toolbar:
- "Cargar PALETA n del editor": parsea el bloque PALETA del programa actual.
- "Importar de librería" → desplegable con PALETTE_DB.
- "Exportar como bloque PALETA n": botón que pega `PALETA n\n<4 líneas hex>`.
- Slot index para el bloque exportado.

### 8. Editor de sonidos

Modal con form:
- **ONDA**: `<select>` con TRI/SIE/PUL/SEN.
- **PUL** (ancho de pulso): slider 0..15 (sólo si ONDA=PUL, sino disabled).
- **ADSR**: 4 sliders 0..15 con preview del shape (canvas chico que dibuja la
  envolvente).
- **Notas**: lista editable de filas. Cada fila: nota name (DO/RE/MI...) +
  accidental (none/#/b) + octava (0..7) + ticks (1..30). Botones "+ Nota" y
  "+ Silencio" para agregar; "×" para eliminar.
- **Play** (▶): instancia un `AudioContext` temporario, crea un `synth` con
  `createSynth`, hace `loadSound(synth, 0, def)` con la def construida del form,
  llama `playSound(synth, 0, 0)`. Reusa el código de `src/audio/synth.js`
  exactamente.
- **Stop** (■): silencia el canal y limpia el AudioContext.
- **Slot index** y "Insertar al cursor" / "Reemplazar SONIDO n" / "Cerrar".

El export reconstruye el bloque `SONIDO n` con todos los subcomandos.

### 9. Atajos de teclado

| Atajo                       | Acción                                  |
|-----------------------------|-----------------------------------------|
| Ctrl/Cmd + Enter            | Correr el código (o reset y correr)     |
| Ctrl/Cmd + .                | Stop / pause                            |
| Ctrl/Cmd + S                | Guardar borrador en localStorage        |
| Ctrl/Cmd + Shift + S        | Descargar como archivo `.retro`         |
| Ctrl/Cmd + O                | Abrir archivo                           |
| Ctrl/Cmd + L                | Abrir librería de snippets              |
| Ctrl/Cmd + Shift + P        | Editor de sprites                       |
| Ctrl/Cmd + Shift + L        | Editor de paletas                       |
| Ctrl/Cmd + Shift + N        | Editor de sonidos                       |
| F1                          | Abrir documentación                     |

Los atajos se registran en CodeMirror via `keymap.of([...])` y para los modales
se usan listeners globales en `document` con `e.preventDefault()`.

### 10. Persistencia

- **localStorage**: clave `retrovm:draft` guarda el código actual cada 1s
  (debounced) o al disparar Ctrl+S manual. Al cargar la página, si existe
  borrador y es distinto del último ejemplo seleccionado, mostrar un cartel
  "Tenés un borrador sin guardar — ¿restaurar?".
- **localStorage**: `retrovm:settings` para preferencias (seed default, último
  ejemplo abierto, theme).
- **Descarga**: `Blob` + `URL.createObjectURL` + `<a download="mi-juego.retro">`.

### 11. Cambios de build / dependencies

`package.json` agrega:

```json
"dependencies": {
  "@codemirror/state": "^6",
  "@codemirror/view": "^6",
  "@codemirror/language": "^6",
  "@codemirror/commands": "^6",
  "@codemirror/lint": "^6",
  "@codemirror/search": "^6",
  "codemirror": "^6"
}
```

(CodeMirror 6 es modular pero `codemirror` re-exporta el core básico.)

[vite.config.js](../vite.config.js) ya está OK (sirve `web/` como root, permite
imports a `..`).

## Estructura del index.html

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>RetroVM — IDE</title>
    <link rel="stylesheet" href="./style.css" />
    <link rel="stylesheet" href="./ide.css" />
  </head>
  <body>
    <header class="ide-header">
      <h1>RetroVM</h1>
      <nav>
        <a href="/docs/REFERENCIA.html" target="_blank">Referencia</a>
        <a href="/docs/TUTORIAL.html" target="_blank">Tutorial</a>
      </nav>
    </header>

    <div class="ide-toolbar">
      <select id="example-select"><!-- llenado por JS --></select>
      <button id="open-file">Abrir...</button>
      <button id="save-file">Descargar</button>
      <button id="run">▶ Correr</button>
      <button id="pause">⏸</button>
      <button id="reset">↻</button>
      <span class="sep"></span>
      <button id="lib-palettes">Lib: Paletas</button>
      <button id="lib-sprites">Sprites</button>
      <button id="lib-sounds">Sonidos</button>
      <button id="lib-maps">Mapas</button>
    </div>

    <main class="ide-main">
      <div id="editor"></div>
      <aside class="ide-canvas-pane">
        <canvas id="screen" width="320" height="200"></canvas>
        <div id="hud"></div>
      </aside>
    </main>

    <footer id="diagnostics"></footer>

    <dialog id="sprite-editor"><!-- contenido --></dialog>
    <dialog id="palette-editor"></dialog>
    <dialog id="sound-editor"></dialog>
    <dialog id="library-browser"></dialog>

    <input id="file-input" type="file" accept=".retro" hidden />
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

Uso de `<dialog>` nativo: `dialog.showModal()` y `dialog.close()` para los
editores. Cero overlay manual.

## Plan de phasing (qué shipear primero)

Si el alcance es grande, orden recomendado:

**Fase A (núcleo IDE) — semana 1**
1. CodeMirror 6 + retro-mode + tema.
2. Botón Correr + canvas + linter bridge.
3. Selector de ejemplos (auto-glob).
4. localStorage draft.
5. Links a docs (texto plano OK por ahora).

**Fase B (assets) — semana 2**
6. Librería de paletas (la más simple) con insert.
7. Editor de paletas modal.
8. Editor de sprites modal.
9. Editor de sonidos modal con play.

**Fase C (refinamiento) — semana 3**
10. Librería de sprites/sonidos/mapas con preview visual.
11. Atajos de teclado completos.
12. Render Markdown de docs en HTML (Vite plugin).
13. Pause/Reset/Step controles.
14. Export de framebuffer como PNG (bonus).

## Lo que **no** entra

- Cuentas de usuario / sharing online. Todo es local.
- Multi-archivo / proyectos. Un `.retro` self-contained alcanza.
- Debugger paso a paso del VM (más allá de Step). Hito futuro si hace falta.
- Grabación de gameplay como GIF/video. Bonus muy posterior.
- Mobile-first. Target es desktop con teclado físico; mobile se ve aceptable
  pero los editores visuales quedan apretados.

## Verificación end-to-end

1. `npm install` instala CodeMirror sin errores.
2. `npm run dev` abre la IDE; puedo:
   - Seleccionar "serpiente" del dropdown → carga el código en el editor.
   - Ver syntax highlighting con keywords coloreados.
   - Apretar "Correr" → la serpiente aparece en el canvas y responde a flechas.
   - Editar la línea de velocidad (`V=8` → `V=4`) y volver a correr → la
     serpiente va el doble de rápido.
   - Abrir editor de paletas → cambiar el color 11 a magenta → "Reemplazar
     PALETA 0" → el cuerpo de la serpiente se vuelve magenta.
   - Abrir editor de sprites → dibujar un sprite 8×8 → "Insertar al cursor"
     → corre y se ve en pantalla.
   - Abrir editor de sonidos → componer "DO RE MI" en PUL → Play (escucho) →
     "Insertar como SONIDO 2" → llamarlo desde el código.
   - Cerrar la pestaña, recargar → ver borrador restaurado desde localStorage.
3. `npm run build` produce `dist/` con HTML/CSS/JS y los `.retro` bundleados.
   El bundle pesa < 200 KB gzipped.
4. Tests del VM siguen verde (no tocamos `src/`).
