# RetroVM — Guía para Claude

## Proyecto

RetroVM es una máquina virtual estilo "revista de juegos de los 80" para el
navegador. El usuario escribe juegos en un lenguaje propio con mnemónicos en
español (≤ 32 caracteres por línea); RetroVM los corre a 60 fps sobre HTML
canvas + Web Audio. **El diseño completo vive en
[docs/PLAN.md](docs/PLAN.md); la referencia del lenguaje en
[docs/REFERENCIA.md](docs/REFERENCIA.md). Esos dos archivos son la fuente
de verdad — leelos antes de proponer cambios estructurales.**

Lo que **no** es: ni un emulador fiel del C64/NES, ni un motor general de
gamedev, ni un competidor de Pico-8. Es un juguete deliberado.

## Stack

- JavaScript ESM puro, sin TypeScript. Archivos `.js`.
- Test: **Vitest**. Dev/build: **Vite**.
- Sin dependencias de runtime. `package.json` no debe ganar `dependencies`
  salvo motivo muy fuerte. Las únicas devDependencies son las herramientas
  de test/build.
- Target: navegadores modernos (ES2022+). No hay backend, ni Node runtime
  de producción.

## Comandos

| Comando              | Para qué                                              |
|----------------------|-------------------------------------------------------|
| `npm test`           | Vitest una pasada (unit + integration + system stubs) |
| `npm run test:watch` | Vitest interactivo                                    |
| `npm run test:perf`  | Suite de performance (NO corre en CI)                 |
| `npm run dev`        | Vite dev server con la demo de canvas                 |
| `npm run build`      | Vite build → `dist/`                                  |

## Convenciones

- ESM (`import`/`export`), no CommonJS.
- Sin frameworks UI: canvas + JS plano. Nada de React/Vue/Svelte.
- **Aislamiento DOM**: el núcleo del VM corre headless. Los siguientes
  archivos **no** pueden tocar `document`, `window`, ni `AudioContext`
  directamente:
  - `src/core/**`
  - `src/parser/**`
  - `src/audio/synth.js` (recibe el `AudioContext` por inyección)
  - `src/render/framebuffer.js` (escribe en arrays tipados, no en canvas)
  - `src/builtins/**`

  El wiring DOM/Web Audio vive en `src/index.js` (factory que cablea todo)
  y en `web/`. Esto es lo que hace los tests posibles sin DOM real.
- **Idioma**: el dominio del lenguaje del VM está en español (mnemónicos,
  nombres de eventos: `CUADRO`, `LINEA`, `INICIONIVEL`, …). Mensajes de
  error del parser/linter también en español. Pero los identificadores
  JS (variables, funciones, clases) van en inglés.
- Sin emojis en código.

## Reglas de performance vinculantes

Eco de [docs/PLAN.md §11](docs/PLAN.md). Cualquier PR que rompa una de
éstas debe argumentar explícitamente por qué.

1. **Cero allocations en el hot path**. El loop de cuadro y los handlers
   compilados no allocan. Sin `for..of`, `Array.map`, generators ni
   iterators en el núcleo. Sólo `for` clásico con índice entero.
2. **Render por blit, no por API de píxel**. `putImageData` se llama
   exactamente una vez por cuadro sobre un `Uint32Array` reusado. Nunca
   `ctx.fillRect`/`ctx.fillStyle = '...'`/`ctx.getImageData` en hot path.
3. **Compilación a closures de JS**. El programa parseado se compila a un
   `Array<Function>` indexado por línea. `IR n` se resuelve a índice del
   array, no a búsqueda en runtime.
4. **Eventos densos y opt-in**. Handlers viven en arrays densos
   (`Array<Function|null>`). El loop chequea un flag booleano por tipo de
   evento antes de iterar; sin handler, sin loop interno.
5. **Audio sobre Web Audio nativo, no emulación de muestra**. Cada nota
   agenda `AudioParam.setValueAtTime` y la envolvente se dibuja con
   `linearRampToValueAtTime`. Cero síntesis on-the-fly.
6. **Presupuesto ≤ 4 ms CPU/cuadro** medido en hardware de referencia
   (notebook 2018). Cada hito tiene su test de performance.
7. **Determinismo**: `ALE(n)` usa xorshift32 con seed que es estado del
   VM; el reloj del VM es virtual (1 cuadro = 1/60 s sin importar el
   wall clock).

## Testing

Cuatro niveles ([docs/PLAN.md §12](docs/PLAN.md)):

- `tests/unit/` — parser, compilador, paletas, sprites, builtins,
  audio (sin DOM real). Corren en CI.
- `tests/integration/` — ciclo de vida completo, loop de cuadro, mapas +
  colisiones, eventos de audio. Corren en CI.
- `tests/system/` — golden hashes del framebuffer corriendo cada
  reference game (Pitfall, Serpiente, Billar). Corren en CI cuando los
  juegos existan.
- `tests/perf/` — throughput por cuadro, allocations en hot path, FPS
  sostenidos. **No** corre en CI por defecto (el CI no tiene perf
  estable); se mide localmente y en máquina de referencia.

## Definición del lenguaje del VM

[docs/REFERENCIA.md](docs/REFERENCIA.md) es la fuente de verdad de los
mnemónicos. Si implementás un builtin nuevo o cambiás el comportamiento
de uno existente:

1. Primero actualizá REFERENCIA.md con la firma y un ejemplo ≤ 32 chars.
2. Después implementá el cambio.
3. Mencioná la actualización de la referencia en el mensaje de commit.

Si el código diverge de la referencia, **es un bug** — alguno de los dos
está mal y hay que reconciliarlos.

## NO en este repo

- Frameworks UI (React, Vue, Svelte, etc.).
- Bundlers exóticos. Vite alcanza.
- Tipos (TypeScript, Flow, JSDoc estricto). El plan no los pide.
- Dependencias pesadas — RetroVM debe poder distribuirse como un único
  archivo JS embebible (Hito 9).
- Código muerto "por si acaso" o abstracciones especulativas (YAGNI).
- Backwards-compatibility hacks (renombres con `_unused`, comentarios
  `// eliminado: ...`, etc.).
- Comentarios que explican el QUÉ (los identificadores ya lo hacen).
  Sólo comentarios para el PORQUÉ no obvio: invariantes ocultos,
  workarounds, restricciones del hardware ficticio.

## Hojas de ruta

Hito en curso y siguientes en [docs/PLAN.md §15](docs/PLAN.md). DoD del
proyecto en [§16](docs/PLAN.md).
