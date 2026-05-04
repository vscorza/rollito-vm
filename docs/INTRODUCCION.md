# RollitoVM — Introducción

RollitoVM es una máquina
virtual retro para el
navegador. Programás juegos
2D en un lenguaje propio
con mnemónicos cortos en
español, en líneas que
entran cómodas en
**32 caracteres**. La
restricción está pensada
para que un juego entero
entre en un rollito,
al estilo de los
listados de BASIC que se
publicaban hace cuatro
décadas en las revistas
de juegos.

Probalo en:
`vscorza.github.io/
   rollito-vm`.

## Arquitectura

El runtime es JavaScript
ESM puro, sin dependencias.
Son seis subsistemas que se
comunican por un bus de
eventos sincrónico:

```
texto .retro
   │
   ▼
[ Cargador ]
   │
   ▼
[ Parser ]
   │
   ▼
[ Compilador ]
   │  emite closures JS
   ▼
[ Núcleo VM ]
   │
   ├─ Render (canvas)
   ├─ Audio (Web Audio)
   └─ Bus de eventos
```

- **Compilación a closures**.
  Cada línea numerada se
  traduce a una función JS;
  un `IR n` que resuelve a un
  índice de array en
  compile-time. Es
  el equivalente a un
  mini-JIT escrito en ~150
  líneas al que el motor V8
  o SpiderMonkey puede
  hacer inlining.
- **Cero reservas en el
  hot path**. Todo el
  estado vive en
  `Int32Array`/`Uint8Array`
  reusados: variables
  `A`–`Z`, ocho arreglos
  `M0`–`M7` de 256 enteros,
  32 actores, framebuffer
  indexado de 320×200 y
  hasta cuatro paletas de
  16 colores. El loop de
  cuadro y los handlers
  compilados nunca piden
  memoria.
- **Render por blit**.
  `putImageData` se llama
  exactamente una vez por
  cuadro sobre un
  `Uint32Array` reusado.
  Los fondos (`FON n`) se
  pre-renderizan a un
  buffer auxiliar y se
  copian con `set()` al
  inicio de cada cuadro.
- **Audio nativo**. Cada
  nota se registra con
  `setValueAtTime` y la
  envolvente se dibuja con
  `linearRampToValueAtTime`
  sobre 4 canales tonales
  más uno de ruido.
- **Eventos opt-in**.
  `EN CUADRO`,
  `EN INICIOJUEGO`,
  `EN CANAL c`, `EN PAUSA`,
  etc. permiten suscribir
  handlers a un bus denso. 
  Si nadie suscribe un evento,
  el costo de chequeo es una
  sola comparación booleana
  por cuadro.
- **Determinismo**. `ALE(n)`
  usa un xorshift32 con
  seed como parte del estado
  del VM y el reloj es
  virtual(1 cuadro=1/60s).
  Mismo seed más misma
  secuencia de inputs
  equivalen a la misma
  partida cuadro a cuadro.

El presupuesto vinculante
es **≤ 4 ms de CPU por
cuadro** en hardware de
referencia (notebook 2018),
con margen sobrado dentro
del frame budget de
16.7 ms.

## Sintaxis

Estructura del archivo:

```
JUEGO Nombre
AUTOR Vos
VERSION 1

PALETA n   ; 16 colores
SPRITE n WxH ; grilla hex
MAPA n WxH ; tiles
SONIDO n ... FIN

PROGRAMA
10 EN CUADRO IR 100
...
```

Lo esencial del lenguaje:

- **Variables**: 26 enteras
  `A`–`Z` más ocho arreglos
  `M0`–`M7` de 256 enteros.
  Asignación compuesta:
  `A+=1`, `B*=2`. Reservadas:
  `VID`, `PUN`, `NIV`, `CUA`
  (contador de cuadros).
- **Control**:
  `SI cond ENT acc [SINO acc]`,
  `PAR I=a A b ... SIG`,
  `IR n`, `LLA n`/`RET`. Varias
  instrucciones por línea
  separadas con `:`.
- **Dibujo**: `BOR c`,
  `PIN x,y,c`,
  `REC x,y,w,h,c`,
  `TXT x,y,"hola"`,
  `SPR n,x,y[,f]`,
  `MOV n,x,y`, `VEL n,vx,vy`,
  `INV n,X|Y`.
- **Mapas**: `MAPA n WxH`
  define un mapa de tiles,
  `MAP n,x,y[,a]` lo pinta
  una vez (alpha opcional),
  `FON n` lo fija como fondo
  automático, `SOL m,t1,...`
  declara tiles sólidos.
- **Físicas**: `GRA n,m,a`
  (gravedad y colisión),
  `SAL n,f` (salto),
  `LIM n,x1,y1,x2,y2`.
- **Entrada**: `BTN(0..7)`
  para direccionales y 
  botones (izq,der,arr,abj,A,
  B, INI, SEL); `TEC(k)`
  para teclas ASCII.
- **Sonido**: `SON n,c`
  dispara el sonido `n` en
  el canal `c` (0..3
  tonales); `RUI n` para
  ruido; `SIL c` silencia.
- **Convención**: cada
  handler termina con `RET`
  explícito.

Referencia completa de
mnemónicos en REFERENCIA.md;
diseño y decisiones de
performance en PLAN.md.
Lo encontrás en el sitio de 
github.io

## Ejemplo 1 — pixel rebotando

Un pixel rebota contra los
cuatro bordes. Copialo tal
cual al editor:

```
JUEGO Rebote
AUTOR Tu
VERSION 1

PROGRAMA
10 EN INICIOJUEGO IR 50
20 EN CUADRO IR 100

50 A=160:B=100:C=2:D=1
55 RET

100 BOR 0
110 A+=C:B+=D
120 SI A<0 O A>319 ENT C=-C
130 SI B<0 O B>199 ENT D=-D
140 PIN A,B,7
150 RET
```

Cubre `EN INICIOJUEGO`/
`EN CUADRO`, variables,
asignación compuesta,
condicionales en una línea,
`BOR` y `PIN`.

## Ejemplo 2 — sprite jugable

Una pelota se mueve con 
direccionales dentro de
la pantalla:

```
JUEGO Mover
AUTOR Tu
VERSION 1

SPRITE 0 8x8
00188100
017FF710
01FFFF10
000FF000
00088000
00888800
000CC000
00CCCC00

PROGRAMA
10 EN INICIOJUEGO IR 50
20 EN CUADRO IR 100

50 A=160:B=100
55 MOV 0,A,B:RET

100 BOR 7
110 SI BTN(0) ENT A-=2
120 SI BTN(1) ENT A+=2
130 SI BTN(2) ENT B-=2
140 SI BTN(3) ENT B+=2
150 LIM 0,0,0,312,192
160 MOV 0,A,B
170 RET
```

Cubre la definición textual
de un sprite, `BTN`, `MOV`,
`LIM`, y el patrón típico
de cuadro: borrar fondo →
leer input → actualizar
estado → dibujar.

## Ejemplo 3 — parallax y audio

Dos planos de scroll a
velocidades distintas, una
nave que se mueve en
vertical y una melodía que
suena cada segundo. Cubre
`MAPA`, `SONIDO`, `MAP`
con coordenada variable y
uso de `CUA`.

```
JUEGO Vuelo
AUTOR Tu
VERSION 1

SPRITE 0 8x8
00007000
00070700
00700070
99999888
09888880
00CC8000
00CC0000
00000000

SPRITE 1 16x16
0000000000000000
0000000000000000
0000000000000000
0000000000000000
0000000000000000
0000007776000000
0000077777707600
0000677777777770
0007767767776760
0006776777677600
0000067767760000
0000000000000000
0000000000000000
0000000000000000
0000000000000000
0000000000000000

SPRITE 2 16x16
7777777777777777
7777477777477777
4444444444444444
4474444744444744
4444244444244444
4444444444444444
4424444424444424
4444444444444444
4244244244244244
4444444444444444
4424424424424424
4444444444444444
4244244244244244
2222222222222222
2222222222222222
2222222222222222

MAPA 0 20x4
00000000000000000000
00000000000000000000
00110001000111000100
10000100010000011011

MAPA 1 20x6
00000000000000000000
00000000000000000000
00000000000000000000
00000000000000000000
00000000000000000000
22222222222222222222

SONIDO 0
ONDA PUL
PUL 8
ENV 1,2,8,4
NOTA DO5 4
NOTA SOL5 4
FIN

PROGRAMA
10 EN INICIOJUEGO IR 50
20 EN CUADRO IR 100

50 A=20:B=100:RET

100 BOR 12
105 T=-(CUA/4)%320
110 U=-(CUA/2)%320
115 MAP 0,T,64
120 MAP 0,T+320,64
125 MAP 1,U,104
130 MAP 1,U+320,104
135 SI BTN(2) ENT B-=2
140 SI BTN(3) ENT B+=2
145 SI CUA%60=0 ENT SON 0,1
150 LIM 0,0,0,312,192
155 MOV 0,A,B
160 RET
```

Parallax: cada mapa mide
exactamente 320 px de
ancho (20 tiles de 16) y
se pinta dos veces por
cuadro, en `T` y en
`T+320`. Cuando una copia
sale por la izquierda, la
otra entra por la derecha.
Las velocidades son
distintas: el plano lejano
(nubes) usa
`T=-(CUA/4)%320` y el
cercano (suelo) usa
`U=-(CUA/2)%320`, creando
ilusión de profundidad.

Sonido: el sonido 0 declara
una onda de pulso con
envolvente ADSR corta y
dos notas (`DO5` y `SOL5`)
de cuatro ticks cada una.
La línea `150` lo dispara
en el canal 1 cada vez que
`CUA` es múltiplo de 60,
es decir una vez por
segundo.

---

Para profundizar leé
PLAN.md (diseño
completo y decisiones de
performance) y REFERENCIA.md
(todos los mnemónicos con
ejemplos cortos), o abrí
el editor en
`vscorza.github.io
  /rollito-vm`
y probá los juegos
incluidos: Pelota,
Saltarín, Serpiente, Pong,
Memoria, Tetris,
Mario-mini, Espacial,
Camaleón, Rollox.
