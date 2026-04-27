# RollitoVM — Plan de Diseño

> Una máquina virtual estilo "revista de juegos de los 80" para el navegador.
> Programás en líneas cortas (≤ 32 caracteres) con mnemónicos en español
> y obtenés un juego de plataformas o puzzle 2D corriendo sobre HTML+JS.

---

## 1. Visión y filosofía

RollitoVM busca recrear el placer de tipear un programa BASIC publicado en una
revista de los 80 y verlo correr. Apuntamos a juegos pequeños (plataformas
simples, puzzles, arcades de un nivel) escritos en un lenguaje propio,
deliberadamente austero, con mnemónicos cortos en español.

Las decisiones de diseño se ordenan según estas prioridades, en orden
descendente. **Cuando una prioridad superior choca con una inferior, gana
la superior, sin discusión**:

1. **Performance del intérprete**. RollitoVM tiene que correr a 60 fps en
   notebooks modestas y en celulares de gama media. Toda decisión que
   amenace ese objetivo se rechaza, aunque cueste fidelidad al hardware
   ficticio que evocamos.
2. **Brevedad del código**: la línea promedio debe entrar en 32 caracteres.
3. **Texto plano para todo**: sprites, paletas, sonidos y código son texto.
4. **Alcance reducido**: nada de 3D, ni físicas avanzadas, ni red.
5. **Reminiscencia retro visual y sintáctica**: lo que nos importa es la
   sensación al programar y al ver la pantalla. **No nos importa** la
   precisión de timing, ni reproducir bugs del hardware original, ni
   sonar idéntico a un SID.
6. **Testabilidad**: el VM es determinista y se puede correr fuera del DOM.

Lo que **no** es RollitoVM: un emulador fiel del C64 ni del NES, una
herramienta general de gamedev, ni un motor competitivo con Pico-8. Es un
juguete deliberado, optimizado para que un juego escrito en su lenguaje se
sienta retro y corra rápido — en ese orden.

---

## 2. Especificaciones del hardware ficticio

| Recurso          | Valor                                              |
|------------------|----------------------------------------------------|
| Resolución       | 320 × 200 píxeles                                  |
| Profundidad      | 4 bits por píxel (16 colores activos por paleta)   |
| Paletas          | Hasta 4 paletas predefinidas, intercambiables      |
| Sprites en RAM   | 32 sprites cargados simultáneamente                |
| Tamaños sprite   | 8×8, 8×16, 16×8, 16×16                             |
| Canales de audio | 4 tonales + 1 ruido (inspirado en SID)             |
| Tasa de cuadros  | 60 Hz objetivo                                     |
| Eventos por línea| Hasta 200 por cuadro, sólo si hay handlers         |

Las "scanlines" son una abstracción del lenguaje: existen para permitir
cambios de paleta verticales y efectos similares, pero **no implican**
dispatch real 200 veces por cuadro a menos que el programa enganche un
handler de `LINEA`. Cuando no hay handler, el render se hace de un solo
plumazo (ver §11).

---

## 3. Arquitectura general

```
┌──────────────────────────────────────────────────────────┐
│                      RollitoVM (JS)                        │
│                                                          │
│  ┌────────────┐   ┌────────────┐   ┌─────────────────┐   │
│  │  Cargador  │──▶│   Parser   │──▶│   Compilador    │   │
│  │ (texto→IR) │   │ (líneas)   │   │ (IR → closures) │   │
│  └────────────┘   └────────────┘   └────────┬────────┘   │
│                                             │            │
│                          ┌──────────────────▼────────┐   │
│                          │      Núcleo del VM        │   │
│                          │  (loop de cuadro/línea)   │   │
│                          └──┬────┬─────────┬─────┬───┘   │
│                             │    │         │     │       │
│                  ┌──────────▼┐ ┌─▼──────┐ ┌▼────┐│       │
│                  │ Render    │ │ Audio  │ │Event││       │
│                  │ (canvas)  │ │(WebAud)│ │ Bus ││       │
│                  └───────────┘ └────────┘ └──┬──┘│       │
└─────────────────────────────────────────────┼───┼────────┘
                                              │   │
                                       Rutinas de usuario
```

Seis subsistemas claros:

- **Cargador**: toma el texto del juego y lo separa en bloques (`PROGRAMA`,
  `PALETA`, `SPRITE`, `MAPA`, `SONIDO`, `NIVEL`).
- **Parser**: convierte cada línea de programa en una instrucción interna.
- **Compilador**: traduce las instrucciones a *closures de JS*. Cada línea
  numerada del programa se vuelve una función. Los `IR <n>` se resuelven a
  índices directos del array de closures, no a búsquedas por número de
  línea. **Este paso es la decisión de performance más importante del
  proyecto** (§11).
- **Núcleo**: ejecuta el loop, dispara eventos enganchados y mantiene el
  estado.
- **Render**: dibuja el framebuffer en `<canvas>` con `putImageData`.
- **Audio**: traduce comandos del subsistema de sonido a nodos nativos de
  Web Audio API. **No** sintetiza muestras a mano.

Todos los subsistemas se comunican por un **bus de eventos** sincrónico,
lo que permite testear sin DOM ni audio reales.

---

## 4. Sistema de pantalla y render

### 4.1. Framebuffer

El framebuffer es un `Uint8Array` de 320 × 200 = 64 000 bytes. Cada byte
guarda el índice de color (0–15) en la paleta activa.

Adicionalmente mantenemos un `Uint32Array` de 64 000 entradas que es la
versión RGBA "lista para volcar". Lo poblamos según una **LUT precomputada**
de 16 entradas (la paleta activa traducida a RGBA empacado). Cada vez que
se cambia de paleta, regeneramos esa LUT (16 multiplicaciones, despreciable).

### 4.2. Eventos del ciclo de vida

| Evento                | Cuándo se dispara                                     |
|-----------------------|-------------------------------------------------------|
| `INICIOMOTOR`         | Una vez, al arrancar el VM                            |
| `PAUSA`               | Cuando el usuario o el código llama `PAUSA`           |
| `REANUDA`             | Al salir de pausa                                     |
| `INICIOJUEGO`         | Una vez, después de parsear todo                      |
| `CARGANIVEL`          | Antes de mostrar un nivel nuevo                       |
| `INICIONIVEL`         | Cuando empieza la jugabilidad del nivel               |
| `CUADRO`              | 60 veces por segundo, antes de dibujar                |
| `LINEA n`             | Antes de renderizar la scanline `n` (sólo si hay handler) |
| `FINCUADRO`           | Después de volcar al canvas                           |
| `CANAL c`             | Cuando un canal de audio termina su sonido            |
| `SILENCIO`            | Cuando todos los canales quedaron en silencio         |

El usuario engancha código a un evento con la palabra clave `EN`:

```
EN CUADRO IR 100
EN LINEA 50 IR 200
EN INICIONIVEL IR 500
```

**Detalle de performance**: los handlers se almacenan en estructuras
densas (arrays de funciones), no en mapas hash. `LINEA n` se guarda en un
`Array(200)` cuyo índice es `n`; el render itera sólo si ese array tiene
al menos un elemento no nulo (flag global). Si nadie enganchó scanlines,
el costo de chequeo es una sola comparación booleana por cuadro.

### 4.3. Dibujo directo

```
PIN x,y,c           ; pintar pixel (x,y) con color c
LIN x1,y1,x2,y2,c   ; línea
REC x,y,w,h,c       ; rectángulo relleno
BOR c               ; borrar pantalla con color c
TXT x,y,"hola"      ; texto en fuente 8×8 incluida
```

Coordenadas fuera de pantalla se descartan silenciosamente (clipping en
escritor, no en lector).

---

## 5. Sistema de paletas

Cada paleta tiene exactamente 16 colores en formato hex de 6 dígitos.
Se pueden definir hasta 4 paletas (índice 0–3).

```
PALETA 0
000000 1D2B53 7E2553 008751
AB5236 5F574F C2C3C7 FFF1E8
FF004D FFA300 FFEC27 00E436
29ADFF 83769C FF77A8 FFCCAA
```

Cambio de paleta desde el código:

```
PAL 1               ; activa paleta 1 a partir del próximo cuadro
PAL 1 LINEA         ; cambia paleta para la próxima scanline
PAL 2 NIVEL         ; cambia paleta global cuando arranca el nivel
```

El cambio por scanline es el caso que cuesta performance: regeneramos la
LUT 16-entrada al vuelo. Para mantenerlo barato, el cambio por scanline
se aplica en *bloques contiguos*: si el código pone `PAL 1 LINEA` en la
línea 50 y `PAL 0 LINEA` en la 100, las líneas 50–99 usan la LUT 1 y se
regenera la LUT sólo dos veces por cuadro, no por línea.

---

## 6. Sistema de sprites

### 6.1. Definición textual

Un sprite se define con dimensiones y una grilla de dígitos hexadecimales,
cada dígito un índice de color (0–15). El 0 se considera transparente por
defecto.

```
SPRITE 1 8x8
00111100
01222210
12222221
12222221
12222221
12222221
01222210
00111100
```

Para 16×8 cada fila tiene 16 dígitos, y así sucesivamente. Sprite con
dimensión inválida → error en carga.

### 6.2. Patrones y actores (1:1 por defecto)

RollitoVM mantiene **32 slots** que combinan imagen ("patrón") y estado
de actor (posición, velocidad, visibilidad, gravedad). Por defecto, el
sprite/actor n usa el patrón n (relación 1:1). Si querés varios actores
con la misma imagen (8 monedas, 4 enemigos iguales), usás:

```
PAT n,p             ; el actor n a partir de ahora usa el patrón p
```

Esto te ahorra desperdiciar 8 slots de imagen para una sola figura.
Internamente la representación es: por cada slot, un `patternIndex` y
una struct de 8 enteros de 16 bits (x, y, vx, vy, flags, anim,
estadoInterno, padding). Todos en un único `Int16Array` para evitar
punteros y mantener buena localidad de caché.

### 6.3. Comandos en programa

```
SPR n,x,y           ; dibuja patrón n en (x,y) — modo inmediato
SPR n,x,y,f         ; con flags: 1=flipX, 2=flipY, 3=ambos
MOV n,x,y           ; mueve actor n a (x,y) y lo hace visible
VEL n,vx,vy         ; setea velocidad por cuadro
INV n,EJE           ; invierte la velocidad del actor n en el eje (X|Y)
ANI n,a,b,t         ; cicla patrón del actor n entre a y b cada t cuadros
OCU n,1             ; oculta/muestra actor n (1 oculta, 0 muestra)
PAT n,p             ; actor n usa patrón p
```

Los actores con velocidad se actualizan automáticamente al inicio del
evento `CUADRO`, **antes** de invocar el código del usuario. El loop
"avance + colisión con mapa + colisión con bordes" está escrito en JS,
no en el lenguaje del VM, por razones obvias de performance.

---

## 7. Subsistema de sonido (inspirado en SID, no emulado)

**Decisión clave**: RollitoVM no emula a nivel de muestra. Cada canal es
un `OscillatorNode` + `GainNode` de Web Audio API, controlado por
`AudioParam` automatizado. El "sabor SID" viene de las formas de onda
disponibles, las envolventes ADSR cortas y la ausencia de filtros
elegantes — no de un emulador exacto. Esto nos compra ~2 órdenes de
magnitud de performance en audio y libera el thread principal.

### 7.1. Canales

5 canales en total: 4 tonales (`C0`–`C3`) y 1 de ruido (`R0`).
Cada canal tonal tiene:

- Forma de onda: `TRI` (triangular), `SIE` (sierra), `PUL` (pulso),
  `SEN` (senoidal — concesión moderna, opcional).
- Envolvente ADSR de 4 valores 0–15: ataque, decaimiento, sostén, liberación.
- Ancho de pulso (sólo para `PUL`), 0–15.

El canal de ruido es un `AudioBufferSourceNode` con buffer de ruido blanco
precomputado en loop, modulado por su propio ADSR.

### 7.2. Definición de un sonido

Un "sonido" es un script corto que se asigna a un slot (0–15) y luego se
dispara desde el programa. Las notas se escriben con notación hispana
(`DO`, `RE`, `MI`, `FA`, `SOL`, `LA`, `SI`) más octava (0–7) y, opcional,
sostenido (`#`) o bemol (`b`). La duración se mide en *ticks*, donde
1 tick = 1/60 s por defecto.

```
SONIDO 0
ONDA PUL
PUL 8
ENV 2,4,12,6
NOTA DO4 8
NOTA MI4 8
NOTA SOL4 16
FIN
```

Las notas se traducen a frecuencia en Hz **al cargar el sonido** (LUT
precomputada de 12 × 8 = 96 frecuencias). En tiempo de ejecución, cada
"NOTA" agenda una operación `frequency.setValueAtTime(...)` y dispara
la envolvente. Cero síntesis on-the-fly.

Disparo:

```
SON 0,1             ; reproduce sonido 0 en canal 1
RUI 0               ; reproduce slot 0 en el canal de ruido
SIL 1               ; silencia canal 1
```

### 7.3. Eventos de audio

`CANAL c` permite encadenar música o efectos sin polling. Útil para
"cuando termine la melodía de victoria, cargá el próximo nivel".

---

## 8. Lenguaje y formato del programa

### 8.1. Estructura general de un archivo de juego

```
JUEGO Saltarin
AUTOR Tu Nombre
VERSION 1

PALETA 0 ...
PALETA 1 ...

SPRITE 0 8x8 ...
SPRITE 1 16x16 ...

MAPA 0 20x12 ...

SONIDO 0 ...
SONIDO 1 ...

PROGRAMA
10 EN INICIONIVEL IR 500
20 EN CUADRO IR 100
30 EN LINEA 100 PAL 1 LINEA
...
```

Las líneas que empiezan con `;` son comentarios y pueden aparecer en
cualquier parte del archivo, incluso dentro de bloques `PROGRAMA`. También
se acepta `;` al final de una línea de código.

### 8.2. Líneas

Cada línea de `PROGRAMA` empieza con un número (1–9999) y contiene una
instrucción. El parser tolera espacios alrededor de comas pero la guía
de estilo recomienda código apretado para entrar en 32 caracteres.

```
10 SI BTN(0) ENT VEL 1,1,0     ; 30 chars
20 SI COL(1,2) ENT VID-=1      ; 25 chars
30 PAR I=1 A 8 : SPR I,I*8,90  ; 30 chars
```

### 8.3. Categorías de instrucciones

- **Control**: `SI ... ENT ... [SINO ...]`, `PAR I=a A b ... SIG`, `IR n`,
  `LLA n` (llamar a "subrutina" = otra etiqueta), `RET`, `FIN`, `PAUSA`.
- **Variables**: 26 variables enteras `A`–`Z`, 8 arreglos `M0`–`M7` de
  256 enteros. Asignación: `A=5`, `M0(3)=7`. Asignación compuesta:
  `A+=5`, `B-=1`, `C*=2`, `D/=2`. Sin tipos float; las funciones que
  necesitan precisión retornan enteros con escala fija.
- **Dibujo**: `PIN`, `LIN`, `REC`, `BOR`, `SPR`, `MOV`, `ANI`, `OCU`,
  `INV`, `PAT`, `MAP`, `FON`, `SOL`, `TXT x,y,"hola"`.
- **Sonido**: `SON`, `RUI`, `SIL`.
- **Paleta**: `PAL`.
- **Eventos**: `EN <evento> IR <n>`.
- **Entrada**: `BTN(b)`, `TEC(k)` retornan 0/1. Botones 0–7
  (izq, der, arr, abj, A, B, INI, SEL).
- **Estado**: `VID`, `PUN`, `NIV` (atajos vida, puntos, nivel), `CUA`
  (contador global de cuadros), `LIN` (línea actual durante `LINEA`).

### 8.4. Funciones utilitarias

| Función              | Descripción                                          |
|----------------------|------------------------------------------------------|
| `ALE(n)`             | Aleatorio entre 0 y n-1                              |
| `ABS(x)`, `SGN(x)`   | Absoluto, signo                                      |
| `MIN(a,b)`,`MAX(a,b)`| Min / max                                            |
| `RAI(x)`             | Raíz cuadrada (entera)                               |
| `SEN(g)`,`COS(g)`    | Sen/cos en grados, devueltos en escala 1000          |
| `X(n)`,`Y(n)`        | Posición actual del actor n                          |
| `VX(n)`,`VY(n)`      | Velocidad actual del actor n                         |
| `VIS(n)`             | 1 si el actor está visible, 0 si oculto              |
| `PIE(n)`             | 1 si el actor pisa un tile sólido del mapa enlazado  |
| `DIS(s1,s2)`         | Distancia entre centros de dos actores (entera)      |
| `COL(s1,s2)`         | 1 si actores colisionan (AABB), 0 si no              |
| `COLM(s,m)`          | 1 si actor colisiona con tile sólido del mapa m      |
| `TIL(m,c,f)`         | Índice del tile en (columna, fila) del mapa m        |
| `GRA n,m,a`          | Aplica gravedad `a` al actor n y resuelve colisión con mapa `m` |
| `SAL n,f`            | Aplica fuerza vertical de salto al actor (sólo si está pisando) |
| `LIM n,x1,y1,x2,y2`  | Confina el actor n a un rectángulo                   |

`GRA n,m,a` + `SOL m,...` + `MAPA` son la trinidad mínima para un
plataformero. La resolución de colisión está hardcodeada en JS: AABB,
two-pass (primero X, luego Y), revertir posición al chocar.

### 8.5. Mapas de tiles

Para puzzles y plataformas convienen mapas de tiles. Un mapa es una
matriz de índices a sprites (cada dígito hex representa el patrón a
usar; `0` es vacío):

```
MAPA 0 20x12
00000000000000000000
00000000000000000000
00000000000022000000
00000000000000000000
00000000000000000000
00000022222200000000
00000000000000000000
00000000000000000000
00000000000000000000
22222222222222222222
22222222222222222222
22222222222222222222
```

Comandos asociados:

```
MAP n,x,y           ; pintar el mapa n una vez en (x,y)
FON n               ; usar el mapa n como fondo (auto cada cuadro)
SOL m,t1,t2,...     ; declara qué tiles del mapa m son sólidos
```

`FON n` es la opción rápida: al fijar un fondo, lo pre-renderizamos a un
buffer auxiliar de 320×200 una sola vez y lo copiamos con `set()` al
framebuffer al inicio de cada cuadro. Cero costo por tile en runtime.
Si el código modifica el mapa con `TIL(m,c,f)=v` (asignación), el buffer
se invalida y se vuelve a pre-renderizar.

---

## 9. Modelo de memoria y estado

Todo el estado mutable vive en **typed arrays** de tamaño fijo. Esto evita
el GC, mantiene buena localidad de caché y permite snapshots baratos para
testing.

| Estructura       | Tipo               | Tamaño                   |
|------------------|--------------------|--------------------------|
| Variables A–Z    | `Int32Array(26)`   | 104 bytes                |
| Arreglos M0–M7   | `Int32Array(2048)` | 8 KB (8 × 256)           |
| Estado de actores| `Int16Array(32×8)` | 512 bytes                |
| Framebuffer      | `Uint8Array`       | 64 000 bytes             |
| Buffer RGBA      | `Uint32Array`      | 256 000 bytes            |
| Patrones (img)   | `Uint8Array`       | hasta 32 × 256 = 8 KB    |
| Mapas            | `Uint8Array`       | hasta 4 × 40 × 25 = 4 KB |
| Pila de llamadas | `Int32Array(16)`   | 64 bytes (depth máx 16)  |

Total bajo el millón de bytes, todo allocateado **una sola vez al cargar
el juego**. En runtime no se hace `new` ni de arrays ni de objetos.

Variables especiales (`VID`, `PUN`, `NIV`, `CUA`, `LIN`) son slots fijos
del Int32Array de variables, mapeados por nombre en el parser.

---

## 10. Restricción de 32 caracteres

Esta restricción dirige decisiones de diseño:

- Los mnemónicos son de 3 letras siempre que sea posible.
- Operadores compuestos: `+=`, `-=`, `*=`, `/=` (ahorran ~3 chars cada uso).
- Múltiples instrucciones en una línea separadas por `:`.
- Sin literales de string largos. `TXT` es la excepción.
- Indentación inexistente; bloques se reemplazan por `IR` y etiquetas.

El parser **no rechaza** líneas más largas (sería frustrante), pero el
linter sí avisa si una línea pasa de 32 caracteres. La mayoría del
ejemplo idiomático debe respetar el límite.

---

## 11. Decisiones de performance

Lista vinculante de decisiones tomadas en favor del intérprete. **Cualquier
PR que rompa una de estas debe argumentar explícitamente por qué**.

### 11.1. Compilación a closures de JS

Después de parsear, cada línea numerada se transforma en una función JS
cerrada sobre el estado del VM. El "programa" final es un `Array<Function>`.
Ejecutar una línea es una invocación de función con argumentos enteros, no
un switch sobre opcodes ni una lookup de string.

`IR n` se resuelve, en compile-time, al índice del array que corresponde
a la línea `n`. No hay búsqueda lineal ni hash de números de línea en
runtime.

Esto es el equivalente de un mini-JIT, escrito en ~150 líneas de JS. No
es bytecode interpretado; es JS código que el motor V8/SpiderMonkey
puede inlinar.

**Memoria virtual via address translation**: el mapa de memoria de
512 KB (§18) no se materializa como un único `ArrayBuffer`. Cada región
sigue viviendo en su typed array nativo (sprites, mapas, paletas,
framebuffer); las primitivas `LDM`/`STM`/`LDR`/`STR` traducen una
dirección lógica a la región y offset físico. Esto deja la región CODE
respaldada por bytes reales (el bytecode emitido en v2-A) y al mismo
tiempo da al usuario una vista plana y direccionable de toda la VM.

> **v2-A**: el compilador emite bytecode 32-bit a `vmRef.codeMem` y un
> intérprete (`src/core/interpreter.js`) lo ejecuta. La regla de "cero
> allocations en el hot path" se mantiene (el stack de evaluación es
> un `Int32Array` reusado), pero el presupuesto de **≤ 4 ms / cuadro**
> queda en pausa hasta que se mida con bytecode real. Detalles en §18.1.

### 11.2. Cero allocations en el hot path

El loop de cuadro y todos los handlers compilados **no allocan**. Esto
significa:

- Argumentos a builtins se pasan posicionales, no como objeto.
- Resultados intermedios usan slots reservados del Int32Array, no
  variables JS locales que podrían escapar.
- Strings literales se internan en el compilador, nunca se concatenan
  en runtime.
- Iterators, generators, `for..of`, `Array.map` están prohibidos en el
  núcleo. Sólo `for` clásico con índice entero.

### 11.3. Render por blit, no por píxel-API

`putImageData` se llama **una sola vez por cuadro** sobre el `Uint32Array`
RGBA. Nunca se usa `ctx.fillRect`, `ctx.fillStyle = '...'`, ni
`ctx.getImageData` en el hot path. Las APIs lentas del canvas se usan
sólo al inicio para crear el `ImageData` reusable.

### 11.4. Eventos densos y opt-in

- Handlers de eventos viven en arrays densos (`Array<Function|null>`).
- El loop chequea un *flag* booleano por tipo de evento antes de iterar.
  Si nadie enganchó `LINEA`, no entramos al loop interno de scanlines.
- `CANAL c` se dispara desde el callback de Web Audio (`onended`), no
  desde polling.

### 11.5. Audio sobre Web Audio nativo

No emulamos el SID a nivel de muestra. Cada nota agenda
`AudioParam.setValueAtTime` y la envolvente se dibuja con
`linearRampToValueAtTime`. Esto delega el procesamiento a un thread de
audio dedicado del navegador, fuera del thread principal del juego.

Costo: el sonido **no será idéntico** al SID. Eso está OK por la prioridad
#5.

### 11.6. Fondos pre-renderizados

`FON n` pinta el mapa una vez en un `Uint8Array` auxiliar y luego copia
con `framebuffer.set(fondo)` al inicio de cada cuadro. Un mapa 20×12 con
tiles 16×16 son 64 000 bytes de memcpy: en JS moderno, microsegundos.

### 11.7. Sprites pre-decodificados

Los patrones se almacenan ya como bytes de índices de paleta planos
(width × height bytes), no como strings hex. La decodificación pasa una
vez al cargar.

### 11.8. Determinismo y testing

`ALE(n)` usa un PRNG xorshift32 cuyo seed es parte del estado del VM.
Esto hace que los tests de sistema sean reproducibles y permite
"replay" de partidas. El reloj del VM también es virtual: 1 cuadro =
1/60 s, sin importar el wall clock real, lo que permite correr juegos
en velocidad acelerada para tests.

### 11.9. Presupuesto por cuadro

Objetivo: **≤ 4 ms de CPU por cuadro** en hardware target (notebook 2018).
Esto deja 12 ms de margen sobre los 16.7 ms del frame budget para que el
navegador haga su trabajo. Cada milestone tiene un test de performance
que falla si supera el presupuesto.

---

## 12. Estrategia de pruebas

Cuatro niveles, todos sobre el mismo VM headless (sin canvas real) salvo
los de performance que necesitan medición:

### 12.1. Pruebas unitarias

- Parser: cada categoría de instrucción se parsea correctamente y emite
  errores claros frente a entradas malformadas.
- Compilador: una línea parseada produce la closure esperada y resuelve
  saltos correctamente.
- Paletas: cargar, validar 16 colores, swap por línea/cuadro/nivel,
  regeneración de LUT.
- Sprites: cargar dimensiones válidas, rechazar inválidas, transparencia,
  flips, `PAT` clona patrón.
- Funciones utilitarias: `ALE` con seed determinista, `COL` con todas las
  esquinas, `DIS`, trig, `PIE`, `COLM`.
- Audio: traducción de notas a frecuencias, ADSR, eventos de canal libre.

Marco recomendado: **Vitest** (rápido, integra bien con módulos JS).

### 12.2. Pruebas de integración

- Ciclo de vida completo: cargar archivo → eventos en orden esperado.
- Loop de cuadro: contador `CUA` avanza, eventos de línea se disparan
  sólo cuando hay handler, paletas por línea se aplican en bloque.
- Audio + eventos: `CANAL c` se dispara cuando corresponde.
- Mapas + colisiones: un actor con gravedad cae sobre el mapa y se
  detiene; `PIE(n)` se vuelve 1.

### 12.3. Pruebas de sistema

Cada juego de ejemplo se ejecuta con un **driver de prueba** que reemplaza
entrada y tiempo por valores controlados, captura el framebuffer cada N
cuadros y compara contra hashes esperados (golden testing).

### 12.4. Pruebas de performance

Suite separada que **no** corre en CI por defecto (el CI no tiene perf
estable), pero sí localmente y en una máquina de referencia documentada.
Mide:

- Tiempo total por cuadro en cada juego de ejemplo.
- Allocations en el hot path (debe ser 0).
- Tamaño del heap después de 10 segundos de juego (debe estar plano).
- FPS sostenidos durante 60 s con cada ejemplo.

Si alguna métrica regresa, la PR no se mergea.

---

## 13. Juegos de ejemplo

Cinco ejemplos que cubren todo el VM. El primero es el "hola mundo";
los siguientes incrementan complejidad.

1. **Pelota** — un círculo rebota contra los 4 bordes.
   Cubre: `CUADRO`, `MOV`, `VEL`, `INV`, sonido de rebote.

2. **Pong** — dos paletas, un puntaje en pantalla, sonido de impacto.
   Cubre: dos jugadores, entrada, colisiones sprite-sprite, `TXT`, `PUN`.

3. **Saltarín** — plataformero de un nivel.
   Cubre: gravedad, salto, mapa de tiles, `SOL`, `COLM`, animación,
   paleta por nivel, melodía de fondo, `PAT` para clones.

4. **Memoria** — juego de cartas con paletas que cambian al revelar.
   Cubre: cambio de paleta por scanline (efecto de revelado), arreglos,
   estado de juego.

5. **Serpiente** — la clásica.
   Cubre: arreglos largos, ALE, sonido procedural, fin de partida.

Cada ejemplo vive en `games/<nombre>.retro` y tiene su test de sistema.
Idealmente cada uno cabe en menos de 60 líneas de programa.

### Reference Games — suite de validación end-to-end

En paralelo a los 5 ejemplos didácticos, RollitoVM define una suite de
**tres reference games** que actúan como prueba de sistema integral.
No son demos pedagógicas: son los juegos más exigentes que el VM debe
correr a 60 fps cumpliendo el presupuesto del §11.9. Cuando los tres
pasan sus tests dorados en Chrome y Firefox, el VM cumple su DoD (§16).

| Juego        | Estilo                          | Estresa                                                                                                        |
|--------------|---------------------------------|----------------------------------------------------------------------------------------------------------------|
| **Pitfall**  | Plataformero estilo Pitfall!    | Mapas grandes, gravedad, salto, hazards, paleta por nivel, melodía de fondo, `PAT` para clones.                |
| **Serpiente**| Snake clásico                   | Arreglos largos `M0`–`M7`, `ALE` con seed determinista, sonido procedural, fin de partida.                     |
| **Billar**   | Bolas que rebotan e interactúan | Múltiples actores con física continua, colisiones actor-actor con reflexión vectorial, `INV n,EJE`, `SEN`/`COS`. |

Los slots de tests viven en `tests/system/{pitfall,serpiente,billar}.test.js`
y comparten driver headless en `tests/system/_driver.js`. Los `.retro`
correspondientes (`games/pitfall.retro`, `games/serpiente.retro`,
`games/billar.retro`) y sus hashes dorados se generan al implementar
los Hitos 3–6.

---

## 14. Estructura de carpetas

```
rollito-vm/
├── src/
│   ├── core/
│   │   ├── vm.js
│   │   ├── eventBus.js
│   │   └── memory.js
│   ├── parser/
│   │   ├── lexer.js
│   │   ├── parser.js
│   │   ├── compiler.js   ← traduce a closures de JS
│   │   └── linter.js
│   ├── render/
│   │   ├── framebuffer.js
│   │   ├── palette.js
│   │   └── sprite.js
│   ├── audio/
│   │   ├── synth.js      ← Web Audio nativo, no emulación
│   │   └── notes.js
│   ├── builtins/
│   │   ├── math.js
│   │   ├── physics.js
│   │   └── collision.js
│   └── index.js
├── games/
│   ├── pelota.retro
│   ├── pong.retro
│   ├── saltarin.retro
│   ├── memoria.retro
│   ├── serpiente.retro
│   ├── pitfall.retro      ← reference game (Hito 8)
│   └── billar.retro       ← reference game (Hito 8)
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── system/
│   └── perf/
├── docs/
│   ├── PLAN.md          (este archivo)
│   ├── REFERENCIA.md    (todos los mnemónicos)
│   └── TUTORIAL.md
├── web/
│   ├── index.html
│   ├── editor.js
│   └── style.css
└── package.json
```

---

## 15. Hoja de ruta por hitos

**Hito 0 — andamio (1 semana)**
Repo, package.json, vitest, canvas básico que pinte un gradiente con
`putImageData`. Test de performance que mide blits/segundo. Establece la
máquina de referencia.

**Hito 1 — render y framebuffer (1 semana)**
Framebuffer + LUT de paleta + blit. Cumplir presupuesto: ≥ 1000 fps de
blits puros. Esta es la *baseline* sobre la que todo lo demás se mide.

**Hito 2 — paletas (0.5 semana)**
4 paletas, swap global, swap por scanline en bloques. Tests de paleta.

**Hito 3 — parser + compilador (1.5 semanas)**
Lexer + parser para variables, asignación, `SI/ENT/SINO`, `PAR/SIG`,
`IR`, eventos `EN CUADRO`. Compilador que produce closures. Linter de
32 chars. Tests unitarios de cada categoría.

**Hito 4 — sprites (1 semana)**
Definición textual, RAM de 32, `SPR/MOV/VEL/ANI/OCU/INV/PAT`, flips,
animación. Tests de colisión AABB.

**Hito 5 — mapas y físicas (1 semana)**
`MAPA`, `MAP`, `FON`, `SOL`, `GRA`, `SAL`, `LIM`, `COLM`, `PIE`. El
plataformer mínimo ya debería ser jugable.

**Hito 6 — audio (1 semana)**
Web Audio synth: 4 canales tonales + ruido, ADSR via `AudioParam`,
parser de `SONIDO`, `SON/RUI/SIL`, eventos `CANAL`.

**Hito 7 — ciclo de vida completo (0.5 semana)**
Eventos `INICIOJUEGO`, `CARGANIVEL`, `INICIONIVEL`, `PAUSA`, `REANUDA`.
Driver de pruebas determinista (PRNG seedable, reloj virtual).

**Hito 8 — ejemplos y tests de sistema (1.5 semanas)**
Implementar Pelota, Pong, Saltarín, Memoria, Serpiente. Golden tests.

**Hito 9 — editor web (1 semana)**
Editor con resaltado, cargador de archivos `.retro`, exportar a HTML
auto-contenido para compartir.

Total razonable: **~9.5 semanas** de un dev part-time.

---

## 16. Definición de "terminado"

El proyecto está listo para compartir cuando:

- Los 5 ejemplos corren a 60 fps sostenidos en Chrome y Firefox modernos
  sobre el hardware de referencia (notebook 2018).
- El presupuesto de **≤ 4 ms de CPU por cuadro** se cumple en cada ejemplo.
- 0 allocations medidas en el hot path tras 10 s de juego.
- Los tests unitarios, de integración, de sistema y de performance están
  en verde.
- La cobertura del parser, del compilador y del synth supera 90%.
- `REFERENCIA.md` documenta todos los mnemónicos con un ejemplo de
  ≤ 32 caracteres cada uno.
- El editor web carga un `.retro` y lo ejecuta sin recargar la página.
- Hay un `TUTORIAL.md` que enseña a hacer Pelota desde cero.

---

## 17. Riesgos y decisiones abiertas

- **Compilación a closures vs. bytecode**: vamos con closures (más simple,
  motor JS optimiza bien). Si se descubre que el motor desoptimiza por
  polimorfismo, evaluamos cambiar a un bytecode + dispatch table.
- **Texto en pantalla**: sólo ASCII básico + ñ, áéíóú. La fuente es un
  array de bitmaps 8×8 hardcodeado, no un sprite cargable.
- **Persistencia**: por ahora, ninguna. Si hace falta, agregamos `GUA n`
  y `CAR n` con `localStorage`.
- **Distribución**: aspiramos a un único `rollito-vm.js` embedible. Se
  decide al llegar al Hito 9.
- **Mobile**: el target principal es desktop. Mobile es nice-to-have
  pero no parte del DoD.

---

## 18. Mapa de memoria y encoding de instrucciones

Esta sección documenta el "hardware ficticio" de RollitoVM: el espacio
direccionable de 512 KB y el formato de palabra de 32 bits. La VM real
sigue ejecutando closures de JS (§11.1); este modelo está expuesto al
programador a través de las primitivas `LDM`/`STM`, `LDW`/`STW`,
`LDR`/`STR`, `MEMCPY`, `MEMSET`. Todas las direcciones son **absolutas**
(0..0x7FFFF) — no hay registro de página estilo `LUI`/`HI`.

### 18.1. Tamaño de palabra y encoding de instrucciones

La memoria lógica se direcciona por **byte**, pero la **palabra natural**
es de **32 bits**: coincide con el `Int32Array` de variables, con el ancho
del PRNG xorshift32 y con la unidad de fetch del intérprete. Cada
instrucción ocupa 1 word fijo (4 bytes).

```
 31                                          8 7         0
+--------------------------------------------+-----------+
|                  operand (24 bits)         |  opcode   |
+--------------------------------------------+-----------+
```

Un opcode = 8 bits → hasta 256 instrucciones; hoy emitimos ~80. El
operand de 24 bits se interpreta según el opcode:

| Forma            | Uso                                                          |
|------------------|--------------------------------------------------------------|
| ignorado         | Aritmética/lógica/memoria sin args inmediatos (`ADD`, `LDM`) |
| signed 24-bit    | Literal inmediato (`LDI`)                                    |
| unsigned 24-bit  | Bytecode PC absoluto para `JMP`, `JZ`, `JNZ`, `CALL`         |
| índice (5 bits)  | Variable (`LDV`, `STV`, `ADDV`, ...)                         |
| índice (3 bits)  | Arreglo Mn (`LDA`, `STA`, ...)                               |
| arity            | Builtins variádicos (`SOL`, `TXT`, `SPR`)                    |
| eje              | `INV` (0=X, 1=Y)                                             |
| pool index       | `LDC` para strings y enteros >24-bit                         |

Los stacks runtime viven en `state`:
- `evalStack` (`Int32Array(256)`): operands de expresiones y args.
- `loopStack` (4 ints/frame, profundidad 8): PAR/SIG.
- `callStack` (16 ints): LLA/RET (PCs absolutos del bytecode).

> Tabla canónica de opcodes en [src/core/bytecode.js](src/core/bytecode.js).
> Implementación del intérprete en
> [src/core/interpreter.js](src/core/interpreter.js).

### 18.2. Mapa de memoria (512 KB = `0x80000` bytes)

| Offset    | Tamaño | Región    | Contenido                                   |
|-----------|-------:|-----------|---------------------------------------------|
| `0x00000` | 32 KB  | **CODE**  | Programa compilado (8K instrucciones, reservado para v2-A) |
| `0x08000` | 32 KB  | **STATE** | Vars + arrays + loop/call + actores + input |
| `0x10000` | 32 KB  | **SPR**   | 32 patrones × 1 KB stride (256 B útiles)    |
| `0x18000` | 16 KB  | **MAP**   | 4 mapas × 4 KB stride (max 64×64 cells)     |
| `0x1C000` | 4 KB   | **PAL**   | 4 paletas × 1 KB stride (64 B útiles = 16 colores RGBA) |
| `0x1D000` | 12 KB  | **SON**   | 16 sonidos × 768 B stride (def serializada) |
| `0x20000` | 64 KB  | **FB**    | Framebuffer indexado (320×200 = 64 000 B)   |
| `0x30000` | 320 KB | **FREE**  | Memoria de propósito general                |
| `0x80000` |        | **END**   | (512 KB)                                     |

Notas por región:

- **CODE** contiene el bytecode emitido por el compilador como una
  vista `Uint32Array` sobre `vmRef.codeMem`. `LDM(addr)` en CODE
  devuelve el byte correspondiente del bytecode (útil para
  introspección/disassembly). `STM` y `STW` en CODE muta el buffer
  in-place; el intérprete relee `code[pc]` en cada fetch, así una
  reescritura es **visible al próximo fetch** dentro del mismo handler
  o en handlers siguientes (modelo: zero-instruction-cache).
- **STATE** mapea vars (`Int32Array`), arrays M0..M7, stacks de loop/call,
  actores y `inputState.buttons/keys` a un layout flat. Se accede en
  little-endian. La escritura está permitida pero no chequea
  invariants — usarla sólo para introspección y patches deliberados.
- **SPR** / **MAP** / **PAL** son full read/write con efectos colaterales:
  - `STR(MAP, slot, off, val)` setea `m.dirty = true` (invalida
    pre-render del fondo).
  - `STR(PAL, slot, off, val)` actualiza `bank.luts[slot*16 + colorIdx]`
    byte a byte (cada color es RGBA little-endian).
  - `STR(SPR, ...)` muta `pattern.pixels` directamente — el render lo
    lee fresh cada cuadro.
- **SON**: `LDR` retorna bytes según el layout serializado (§18.4).
  `STR(SON, ...)` muta `sonMem` y marca el slot dirty; el próximo
  `SON n,c` re-deserializa antes de disparar.
- **FB** byte-accesible: equivalente a `PIN` sin clipping.
- **FREE**: `Uint8Array(320*1024)` en `vmRef.freeMem`. Útil para
  scratch space, snapshots, level-loading, save states.

### 18.3. Constantes simbólicas

El lexer resuelve `$NAME` a un literal numérico antes de parsear. Tabla
canónica en `src/parser/lexer.js` (`SYMBOLIC_CONSTS`); detalle en
REFERENCIA.md §15.6. Cubre IDs de región, bases, strides, tamaños
útiles y dimensiones del framebuffer.

### 18.4. Layout de SON (sonidos serializados)

Cada slot ocupa 768 bytes. Layout flat:

| Offset | Bytes | Contenido                                                |
|--------|-------|----------------------------------------------------------|
| 0      | 1     | wave (0=TRI, 1=SIE, 2=PUL, 3=SEN)                        |
| 1      | 1     | pulseWidth (0..15)                                       |
| 2..5   | 4     | ADSR (a, d, s, r — 1 byte cada uno)                      |
| 6..7   | 2     | step count (uint16 little-endian)                        |
| 8+     | 4·N   | cada step: (tipo, nota empacada, ticks, padding)         |

Donde **nota empacada** = `semitone (bits 0..3) | octave (bits 4..6)`.
Hasta 190 steps por sonido (8 + 190·4 = 768). En v1 se serializa al
cargar; modificar bytes con `STR(SON, ...)` no afecta la reproducción
(v2-C agrega re-parseo en `SON n,c`).

### 18.5. Magic registers (memory-mapped IO, v2-E)

Direcciones dentro de STATE que disparan acciones cuando se escriben
con `STW`. Útiles para invocar el runtime sin builtins dedicados:
empaquetar comandos como integers, escribirlos a una dirección, listo.

| Constante      | Dirección  | Acción al `STW val`                              |
|----------------|-----------:|--------------------------------------------------|
| `$MR_SILENCE`  | `0x0B000`  | `silenceChannel(val & 0xff)`                     |
| `$MR_PLAY`     | `0x0B004`  | `playSound(slot = val & 0xf, ch = (val>>4)&0xf)` |
| `$MR_NOISE`    | `0x0B008`  | `playNoise(slot = val & 0xf)`                    |
| `$MR_CARNIV`   | `0x0B00C`  | Setea `NIV = val` y `pendingLevelLoad = true`    |
| `$MR_REPAINT`  | `0x0B010`  | Marca el fondo activo `dirty` (fuerza re-prerender) |

Reglas:
- Sólo `STW` (32 bits) dispara la acción. `STM` byte-a-byte en este
  rango es **no-op silente**.
- Lectura (`LDM`/`LDW`) en este rango devuelve `0` — no hay backing
  storage.
- Direcciones dentro del rango pero no asignadas son no-op.

### 18.6. Side effects al escribir

| Región | `STR`/`STM`     | Efecto                                              |
|--------|-----------------|-----------------------------------------------------|
| PAL    | byte → LUT      | `bank.luts[slot*16 + idx]` se actualiza byte a byte |
| MAP    | byte → cell     | cell mutado + `m.dirty = true`                      |
| SPR    | byte → pixel    | `pattern.pixels[off] = val & 0xf`                   |
| SON    | byte → sonMem   | marca slot dirty; `SON n,c` re-deserializa antes    |
| FB     | byte → pixel    | `vmRef.fb[off] = val`                                |
| FREE   | byte → freeMem  | `vmRef.freeMem[off] = val`                           |
| STATE  | byte → state    | escritura directa, sin chequeo de invariants        |
| CODE   | (no-op)         | reservado para v2-A                                  |

### 18.7. Roadmap v2 (deferred)

Lo siguiente queda **diseñado pero no implementado** en v1. Las
estructuras de v1 (codeMem, sonMem, magic register offsets, layout
serializado) están dimensionadas para que activarlo sea cambiar pocos
archivos sin romper la API:

- **v2-A — Bytecode real**: ✅ **incluido en v1**. Compilador emite
  words a `vmRef.codeMem`; `runFromBytecode` hace `fetch → decode →
  execute`. Cumple §18.1. Disassembler básico via `disasm()` en
  `bytecode.js`.
- **v2-B — Self-modifying code**: ✅ **incluido en v1**. El intérprete
  relee `code[pc]` en cada fetch sin caching, así `STM`/`STW` en CODE
  son visibles al próximo fetch (mismo handler o subsiguiente). Tests
  en [tests/unit/memory.test.js](tests/unit/memory.test.js) "v2-B".
- **v2-C — Modificación de sonidos byte a byte**: ✅ **incluido en v1**.
  `STR(SON, ...)` muta `sonMem` y marca el slot dirty; `SON n,c`
  re-deserializa desde los bytes antes de disparar. Layout flat en §18.4.
- **v2-D — `LDW`/`STW` (32-bit word access)**: ✅ **incluido en v1**.
- **v2-I — Registro `LUI` (paginación de direcciones)**: si los `.retro`
  empiezan a hacer mucho `LDM(0x30000+i)` con offsets variables, podría
  agregarse un registro `adrHi` de 16 bits y un mnemónico `LUI hi` que
  lo setea. `LDM(addr)` haría `(adrHi << 16) | addr`. Se evaluó y se
  descartó en v1: el lenguaje ya soporta enteros de 32 bits, así que
  `LDM(0x30000+i)` funciona sin overhead. La implementación quedaría
  pequeña si la demanda surge.
- **v2-E — Memory-mapped IO**: ✅ **incluido en v1**. STW a 5 magic
  registers (`$MR_SILENCE`, `$MR_PLAY`, `$MR_NOISE`, `$MR_CARNIV`,
  `$MR_REPAINT`) dispara las acciones del runtime. Detalle en §18.5.
- **v2-F — `MEMCPY` / `MEMSET`**: ✅ **incluido en v1**.
- **v2-G — Constantes simbólicas (`$RPAL`, etc.)**: ✅ **incluido en v1**.
- **v2-H — Memory inspector en la IDE**: ✅ **incluido en v1**. Modal
  "🔍 Memoria" en la toolbar abre un dump hex de las 8 regiones del
  memory map + disassembler para CODE. Botón ◀/▶ pagina de a 256 B.
  Construido sobre `readByte` y `disasm`.

---

## 19. Hardware target & RVM-32 ISA

RollitoVM v2-A es bytecode interpretado en JS. Para llevarlo a silicio
diseñamos **RVM-32**, una ISA RISC mínima (33 opcodes, 32-bit fijo,
16 registros) con coprocesadores fijos para gráficos y audio
accedidos vía MMIO. El objetivo es FPGA económica (Lattice ECP5 25F,
~$15-20) + algunos chips off-the-shelf (DAC audio I2S, MCU input).

**Spec completa**: [RVM32-ISA.md](RVM32-ISA.md). Cubre encoding,
opcodes, ABI, MMIO, BRAM budget para ECP5, BOM estimado, y cobertura
del transpilador v2-A → RVM-32.

**Decisiones de arquitectura**: [V2-ARCH-DECISIONS.md](V2-ARCH-DECISIONS.md)
fija las 10 decisiones que estabilizan la ISA antes del RTL (HW divider,
callee-saves-link, trig LUT en ROM, $RNG register, peepholes de
queries/BTN/TEC/ALE, math inline). Implementadas en este sprint;
density -12% promedio sobre los 9 juegos del repo.

**Estado actual** (toolchain JS — completo):
- ✅ ISA tabla + encode/decode → [src/asm/rvm32-isa.js](src/asm/rvm32-isa.js).
  Incluye `DIV`/`REM`/`DIVU`/`REMU` (0x29..0x2C) y `LH`/`LHU`/`SH`
  (0x15..0x17) además de los 26 base.
- ✅ Intérprete RVM-32 en JS → [src/asm/interpreter.js](src/asm/interpreter.js).
  Incluye intercept de `$RNG` (0xB300/0xB304) y trig LUT en 0x0A700.
- ✅ MMIO command bus → [src/asm/mmio.js](src/asm/mmio.js): registros
  ARG0..ARG7 + CMD + RESULT en STATE+0x3100. Dispatcher rutea cada
  comando a los helpers JS existentes (drawPattern, blitMap, playSound,
  aabbCollide, readByteIndexed, etc.). `Q_DIV`/`Q_MOD` deprecated:
  el transpiler usa los opcodes nativos.
- ✅ Transpilador v2-A → RVM-32 completo →
  [src/asm/v2a-to-rvm32.js](src/asm/v2a-to-rvm32.js): cubre todos los
  87 opcodes del bytecode v2-A. Incluye peephole infra (defer-LDI),
  CFG analysis para CALL/RET callee-saves, math inline (ABS/SGN/MIN/MAX),
  trig LUT, $RNG, queries actor con `LH` directo a STATE.
- ✅ Extensiones gráficas v2-A: `SPRR n,x,y,ang,esc` (rot+scale,
  nearest neighbor) y `SPRA n,x,y,a` (alpha blending via tabla).
- ✅ Cosim de los 9 juegos del repo: vars match 100%, fb match
  byte-a-byte (excepto espacial con diff <256 px por orden de ALE en
  starfield procedural).
- ✅ Plan RTL + container Docker → [docs/RTL-PLAN.md](RTL-PLAN.md) +
  [hw/Dockerfile](../hw/Dockerfile) con Yosys + nextpnr-ecp5 +
  Trellis + Verilator + cocotb.

**Tests**:
- [tests/unit/sprr-spra.test.js](tests/unit/sprr-spra.test.js) — 12
  tests de los rasterizadores affine + alpha.
- [tests/unit/rvm32-isa.test.js](tests/unit/rvm32-isa.test.js) — 10
  tests de encoding/decoding round-trip.
- [tests/unit/rvm32-interp.test.js](tests/unit/rvm32-interp.test.js) —
  11 tests del intérprete (ALU, branches, jumps, memoria).
- [tests/unit/rvm32-transpile.test.js](tests/unit/rvm32-transpile.test.js)
  — 20 tests de cosim contra v2-A (aritmética, comparaciones, arrays,
  CALL/RET, PAR/SIG, memoria, builtins, queries).
- [tests/integration/rvm32-games.test.js](tests/integration/rvm32-games.test.js)
  — 9 tests cosim de juegos completos (pelota..tetris+espacial).

Total: **321 tests** (313 base + RVM-32). Los 9 cosim de juegos siguen
verdes byte-a-byte tras el sprint de refactors; ver
[V2-ARCH-DECISIONS.md §12](V2-ARCH-DECISIONS.md) para la tabla de density.

**Próximo**: implementación RTL siguiendo el roadmap de
[docs/RTL-PLAN.md](RTL-PLAN.md) §5 (CPU core → bus + MMIO → GPU →
synth → scan-out → bring-up).
