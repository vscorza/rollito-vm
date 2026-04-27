# RetroVM

Una máquina virtual estilo "revista de juegos de los 80" para el navegador.
Programás en líneas cortas (≤ 32 caracteres) con mnemónicos en español
y obtenés un juego de plataformas o puzzle 2D corriendo sobre HTML+JS.
JavaScript puro, sin dependencias de runtime, deliberadamente austero.

## Estado

Diseño completo, **Hito 0** (andamio) en curso. Ver la hoja de ruta en
[docs/PLAN.md §15](docs/PLAN.md). El lenguaje del VM está totalmente
documentado en [docs/REFERENCIA.md](docs/REFERENCIA.md).

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
