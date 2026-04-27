# RollitoVM

Una máquina virtual estilo "revista de juegos de los 80" para el navegador.
Programás en líneas cortas (≤ 32 caracteres) con mnemónicos en español
y obtenés un juego de plataformas o puzzle 2D corriendo sobre HTML+JS.
JavaScript puro, sin dependencias de runtime, deliberadamente austero.

## La idea: código en papel

La motivación de RollitoVM es **compartir juegos imprimiendo el código
en papel**, al estilo de las revistas de juegos de los 80 (donde tipeabas
listados de BASIC y los corrías). El medio impreso pensado es la
plataforma editorial **[Rollito](https://www.instagram.com/rollito_editorial/)** —
fanzines/folletos publicados por entrega. La restricción de 32 caracteres
por línea, los mnemónicos cortos en español y el formato plano (todo es
texto: sprites, paletas, sonidos, mapas y programa) son justamente para
que un juego entero entre cómodo en pocas páginas.

Probá la versión web en
**[vscorza.github.io/rollito-vm](https://vscorza.github.io/rollito-vm/)**.

## Estado

VM y editor IDE completos (Hitos 0–9). Ver hoja de ruta en
[docs/PLAN.md §15](docs/PLAN.md). El lenguaje del VM está totalmente
documentado en [docs/REFERENCIA.md](docs/REFERENCIA.md). Tutorial
paso-a-paso para construir un juego en
[docs/TUTORIAL.md](docs/TUTORIAL.md).

## Quickstart

```
nvm use            # Node 20+
npm install
npm run dev        # canvas con un degradé animado en localhost
npm test           # tests unitarios e integración
npm run test:perf  # benchmark de blits/segundo (no corre en CI)
npm run build      # build de producción (vite) en dist/
```

## Estructura

```
src/
  core/         loop del VM, bus de eventos, memoria
  parser/       lexer + parser + compilador a closures + linter
  render/       framebuffer, paleta, sprite
  audio/        synth Web Audio + tabla de notas
  builtins/     funciones del lenguaje (math, físicas, colisión)
  index.js      entrada de la lib
games/          juegos en formato .retro (incluidos: pelota, saltarin)
tests/
  unit/         vitest, sin DOM
  integration/  vitest, ciclo de vida + loop
  system/       golden testing del framebuffer (Pitfall, Serpiente, Billar)
  perf/         throughput, presupuesto ≤4 ms/cuadro
docs/
  PLAN.md       diseño completo
  REFERENCIA.md referencia del lenguaje
web/            página de demo (carga el VM en un canvas)
```

## Filosofía (por orden de prioridad — la mayor gana)

1. **Performance del intérprete**: 60 fps en hardware modesto.
2. **Brevedad del código**: línea promedio ≤ 32 caracteres.
3. **Texto plano para todo**: sprites, paletas, sonidos, código.
4. **Alcance reducido**: nada de 3D, físicas avanzadas, ni red.
5. **Reminiscencia retro**: la sensación importa, la fidelidad de hardware no.
6. **Testabilidad**: el VM es determinista y corre fuera del DOM.

Detalles en [docs/PLAN.md §1](docs/PLAN.md).

## Licencia

[MIT](LICENSE).
