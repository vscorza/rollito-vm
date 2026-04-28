# Devlog ROLLOX — escribiendo un run-and-gun en RollitoVM

> Acompaña a [TUTORIAL.md](TUTORIAL.md). Mientras el tutorial te enseña
> a hacer un juego desde cero (Serpiente), este devlog documenta
> en formato blog cómo se construyó **ROLLOX**, un run-and-gun
> platformer con scroll, parallax, 3 enemigos, multinivel y palette
> swap. La intención es mostrar el proceso evolutivo: qué decisiones
> se toman, qué falla, qué hay que rediseñar.
>
> Plan original (con todas las decisiones de arquitectura): ver
> [.claude/plans/read-docs-plan-md-twinkly-globe.md](../.claude/plans/read-docs-plan-md-twinkly-globe.md).

---

## Capítulo 0 — ¿Por qué este juego?

RollitoVM ya tiene 9 reference games — desde el simple `pelota`
hasta `tetris` (540 líneas) y `espacial` (214 líneas con starfield
procedural y múltiples enemigos). Los hitos cubiertos cubren
plataformas, scroll de starfield, sprites animados, mapas de tiles,
multinivel, y physics. Falta un juego que **integre todo a la vez**
y empuje los límites del motor:

- Scroll horizontal "infinito" (motor sin scroll automático).
- Parallax de fondo con efecto de relámpago (3+ capas).
- 3 tipos de enemigos con AI distinta corriendo simultáneos.
- Palette swap dinámico (4 paletas, cambio en runtime).
- Title screen con tipografía grande (sin fuente bitmap nativa).
- Game over con reinicio.

ROLLOX es ese juego.

## Capítulo 1 — Lo que el motor te da y lo que te toca a vos

Antes de escribir una línea de código, hay que saber **qué primitivas
existen** y dónde el motor te va a dejar solo:

| Necesidad               | ¿El motor lo da?                   | Workaround                        |
|-------------------------|-------------------------------------|-----------------------------------|
| Scroll de mapa          | ❌ no automático                     | trackear `camera_x`, redibujar    |
| Parallax background     | ❌                                   | capas con `REC` a distintas vel.  |
| Sprite > 16×16          | ❌ máx 16×16                         | `SPRR` con `esc=2..4` (rota+escala)|
| "Cualquier tecla"       | ❌                                   | OR de `BTN(0..5)` + `TEC(...)`    |
| Texto grande            | ❌ `TXT` es 8×8 fijo                 | sprites de letras + `SPRR esc=4`  |
| Anim. de muerte         | ❌ no automático                     | cambiar `PAT` + timer manual      |
| Plataformas móviles     | ❌                                   | arrays + `REC` + colisión AABB    |
| Pool de actores         | ✅ 32 slots                          | gestión manual en arrays `Mn`     |
| Gravedad + jump         | ✅ `GRA` + `SAL` + `PIE`              | usar mapa fantasma o colisión man.|
| Random determinístico   | ✅ `ALE(n)`                          | seed para layouts reproducibles   |
| Palette swap            | ✅ `PAL n`                           | definir 3-4 paletas               |
| Audio multi-canal       | ✅ 4 tonal + 1 ruido                 | 1 canal por tipo de SFX           |

**Conclusión**: el motor cubre lo crudo (sprites, actores, físicas,
audio, paletas). Todo lo "moderno" (scroll, parallax, UI grande)
se construye encima usando arrays + `REC` + `SPRR`.

## Capítulo 2 — Esqueleto y title screen

El primer paso es siempre el más cómodo de tocar: si la pantalla
prende y dice algo, el resto va a fluir.

### El problema del texto grande

`TXT x,y,"texto"` dibuja con fuente 8×8 fija. No hay escalado de
texto, no hay font de 16×16. Pero existe `SPRR n,x,y,ang,esc` —
sprite con rotación + escala. La unidad de escala es **`esc/64`**
(ver [src/core/sprites.js:251](src/core/sprites.js#L251)). Entonces:

- `esc=64` → 1× (8×8 píxeles)
- `esc=128` → 2× (16×16)
- `esc=192` → 3× (24×24) ← elegido para el título
- `esc=255` → ~4× (máximo posible, `esc` es u8)

Con `esc=192`, una letra-sprite de 8×8 se renderiza a 24×24 píxeles.
"ROLLOX" ocupa 6×24 = 144 px más spacing → cabe cómodo en 320 px de
ancho. Definimos 4 sprites únicos (R, O, L, X) y reusamos O y L.

### Definir letras como sprites

Cada letra se dibuja con índice de paleta `7` (blanco). El fondo
queda en `0` (negro):

```
SPRITE 20 8x8       ; R
07770000
07007000
07007000
07770000
07700000
07070000
07007000
00000000
```

Los `0`s son "transparentes" en la práctica porque la paleta tiene
color `0=000000` y el `BOR 0` (fondo del título) también es negro.
Si quisieras transparency real (mezclar con un fondo distinto),
necesitarías `SPRA` (alpha blending) — overkill para un título.

### "Cualquier tecla" = OR de varios `BTN`

El motor no tiene primitiva any-key. Pero todas las inputs caben en
6 botones físicos + algunas teclas. Para detectar "el jugador
apretó algo", testeamos los 5 botones más comunes uno por línea:

```
720 SI BTN(0) ENT S=1
722 SI BTN(1) ENT S=1
724 SI BTN(4) ENT S=1
726 SI BTN(5) ENT S=1
728 SI BTN(6) ENT S=1
730 SI TEC(32) ENT S=1
```

Sería tentador combinarlos con `O` lógico, pero `SI BTN(0) O BTN(1)
O BTN(4) O BTN(5) ENT S=1` tiene 38 chars — pasa el límite de 32.
Mejor 5 líneas cortas que ofuscar la lectura.

### Estado global S

Variable `S` es el estado de la máquina:
- `S=0`: title
- `S=1`: jugando
- `S=2`: game over

El handler `CUADRO` es un dispatcher de una sola línea:

```
200 SI S=0 ENT LLA 700:RET
210 SI S=2 ENT LLA 800:RET
215 BOR 1
220 TXT 96,96,"PLAYING (STUB)"
225 RET
```

Así separamos cada pantalla en su propia subrutina (700, 800,
gameplay-default).

### Verificación

Smoke test desde Node:

```js
import { createVM } from './src/index.js';
const vm = createVM(fs.readFileSync('games/rollox.retro', 'utf8'));
vm.runFrame();
// Frame 1 con título: 915 píxeles blancos (letras + "PRESIONA...")
vm.inputState.buttons[0] = 1;
vm.runFrame();
// S transiciona de 0 a 1
```

Stage 1 cerrado: **título a pantalla**, **transición a "playing"
stub** funcionando.

## Capítulo 3 — Player, scroll horizontal y la lección del parser

### El plan inicial

- Variable `A` = camera_x (coordenadas de mundo, mod 2048).
- Variable `B` = player_y, `C` = player_vy, `D` = dirección, `E` = on_ground.
- Player se queda fijo en screen_x=80; al moverse, el mundo (cámara)
  se desplaza.
- 8 estalactitas de fondo en `M0(0..7)` con world_x random fijo.
  Render: `T=(M0(I)-A/2+2048)%2048` → `REC T,32,8,40,2`. Velocidad de
  cámara 1/2 = parallax básico.
- Físicas a mano: `B+=C`; `C+=1` (gravedad); cap a 16; floor en y=160.

### Trampa #1: `SI cond ENT a:b` no encadena `b` al condicional

Mi primer borrador tenía esto:

```
300 SI BTN(0) ENT D=1:A-=2
305 SI BTN(1) ENT D=0:A+=2
```

Lógica esperada: si presionás izq, dirección=1 y cámara avanza al
revés. Pero el smoke test mostraba `cam=0` siempre, sin importar
qué tecla apretara. ¿Por qué?

Mirando [src/parser/parser.js:39](src/parser/parser.js#L39):

> `SI ... ENT <stmt> [SINO <stmt>]: <stmt> es una sola sentencia (no permite ':' anidado).`

Es decir, el parser rompe en el primer `:` después de `ENT`. La línea
de arriba se entiende como dos sentencias separadas por `:`:

1. `SI BTN(0) ENT D=1`  → si presionás izq, D=1.
2. `A-=2`              → **siempre** decrementa A.

Y la siguiente línea hace lo simétrico (`A+=2` siempre). Resultado:
`A` se decrementa Y se incrementa cada cuadro → cancelación → cero
movimiento.

**Lección**: en v2-A clásico, "if cond then do multiple things"
necesita o bien repetir el `SI`:

```
300 SI BTN(0) ENT D=1
302 SI BTN(0) ENT A-=2
305 SI BTN(1) ENT D=0
307 SI BTN(1) ENT A+=2
```

…o usar `IR` para saltarse un bloque cuando la cond es falsa:

```
350 SI B<160 ENT IR 376    ; si en aire, saltea reset
352 B=160:C=0:E=1
376 ...
```

El segundo patrón es más compacto cuando el bloque tiene 3+ stmts.

### Trampa #2: dispatcher por estado

Misma raíz. Mi primer dispatcher:

```
200 SI S=0 ENT LLA 700:RET
210 SI S=2 ENT LLA 800:RET
215 LLA 300   ; gameplay
```

El `:RET` después del primer `SI` se ejecuta **siempre**. Cuando
S=1 (gameplay), la línea 200 no llama a 700, pero igual hace `RET`
y nunca se llega al gameplay. Bug.

Solución: invertir y saltear con `IR`:

```
200 SI S=1 ENT IR 215
205 SI S=0 ENT LLA 700
210 SI S=2 ENT LLA 800
212 RET
215 LLA 300
220 LLA 350
225 LLA 600
230 RET
```

- S=1: salta a 215 (gameplay).
- S=0: 205 llama a 700 (title), 210 falsa, 212 RET.
- S=2: 210 llama a 800 (over), 212 RET.

### Render del player

Sin primitiva de flip-actor, opté por **no usar el auto-render del
motor** para el player:

- `OCU 0,1` no se usa porque tampoco uso `MOV` para el slot 0.
- En su lugar, `SPR p,80,B,D` cada frame, donde `D=0` (mira derecha)
  o `D=1` (mira izq, flip horizontal vía bit 0 del flag).

Selección del sprite p:

```
660 SI E=1 ENT IR 664
662 SPR 2,80,B,D       ; jumping
663 RET
664 Q=0                 ; on-ground: ¿está moviéndose?
666 SI BTN(0) ENT Q=1
667 SI BTN(1) ENT Q=1
668 SI Q=0 ENT P=0      ; idle
670 SI Q=1 ENT P=CUA/6%2 ; walk: alterna 0/1 cada 6 frames
672 SPR P,80,B,D
674 RET
```

`CUA/6%2` aprovecha el contador global de cuadros para animar sin
necesidad de `ANI` (que no funciona porque no usamos actor 0).

### Lightning flash

Trigger barato: `SI ALE(180)=0 ENT G=3`. Con 60 fps, eso
es ~60/180 = 1/3 de chance por segundo de empezar un flash.
Cuando G>0, `BOR 7` (blanco) sustituye al fondo. `G-=1` decrementa.

Inicialmente lo había escrito como `SI G>0 ENT BOR 7:G-=1` — misma
trampa #1: el `G-=1` corría cada frame y G iba a -∞. Solución
trivial: dos líneas.

### Verificación

```
parse OK
S= 1
after 30 right: cam= 60      (60 = 30 frames * 2 px/frame ✓)
mid-jump: B=135 C=-2 E=0     (en aire, vy decelerando ✓)
post-land: B=160 C=0 E=1     (vuelve al piso, vy=0, on_ground ✓)
```

Player corre, salta, y el mundo se desplaza con parallax. Title
sigue funcionando. Stage 2 cerrado.

## Capítulo 4 — Plataformas y la trampa del "land instantáneo"

### Storage

- `M1(i)` = world_x base.
- `M2(i)` = y screen.
- `M3(i)` = ancho.
- Slots 0..5 = estáticas, 6..9 = móviles. La separación por rango de
  índice evita un 4to array para el flag de "moving".
- 10 plataformas total. Layout reproducible vía `ALE` (sembrado por
  `NIV` cuando se implemente subida de nivel).

### Movimiento horizontal

Para las móviles uso `SEN(CUA*4 + I*8)/32` como offset:
- `SEN` retorna ±1000 (escala mil del seno en grados).
- `/32` lo escala a ±31 px.
- `CUA*4` es la velocidad angular: ciclo completo cada 256/4 = 64
  frames ≈ 1 seg.
- `I*8` desfasa cada plataforma 8° → no se mueven en fase.

Cuidado con la longitud: `SI I>=6 ENT W=SEN(CUA*4+I*32)` mide 33
chars. Reduje el desfase a `*8` para entrar en 32. La técnica "compute
once outside loop" no aplica porque depende de `I`.

### Colisión: la trampa del "land instantáneo"

Mi primer intento (overlap simple):

```
SI B+16<M2(I)-2 ENT IR ...    ; player.bottom encima de plat.top
SI B+16>M2(I)+8 ENT IR ...    ; player.bottom muy debajo
```

El bug: cuando el jugador saltaba con `v=-7`, el peak quedaba en
B=132. Una plataforma a y=130 nunca se podía alcanzar limpiamente
porque player.bottom (=148) ya estaba *muy* por debajo de plat.top
(=130) en el peak. Resultado: el sistema detectaba "overlap" y
teletransportaba al player a `B = plat.y - 16 = 114` desde B=132. 18
píxeles de teleport vertical.

La solución estándar de side-scroller: **detectar la transición de
arriba a abajo**, no el overlap actual.

Guardé el `B` del frame anterior en `R`:

```
348 R=B          ; antes del physics
350 B+=C
355 C+=1
...
```

Después, en el chequeo de plataforma:

```
390 SI C<=0 ENT IR 408            ; sólo si está cayendo
392 SI T>=96 ENT IR 408            ; sin overlap X
394 SI T+M3(I)<=80 ENT IR 408
396 SI R+16>=M2(I) ENT IR 408     ; si ya estaba por debajo, skip
398 SI B+16<M2(I) ENT IR 408       ; si todavía no cruzó, skip
400 B=M2(I)-16:C=0:E=1             ; LAND
408 SIG
```

Las dos condiciones clave:
- `R+16 >= plat.top`: el frame **anterior** ya estaba abajo. Skip
  (no fue una transición desde arriba).
- `B+16 < plat.top`: este frame todavía no llegó. Skip.

Sólo cuando `prev_bottom < plat.top ≤ new_bottom` decimos que el
jugador cruzó hacia abajo este frame y aterrizó.

### Calibración de altura de salto

Con `v=-7`, peak `B = 160 - (7+6+...+1) = 132`. Player.bottom en peak
= 148. Para que una plataforma sea alcanzable, su `y` tiene que ser
> 148 (más abajo en pantalla, valor más alto).

Subí el salto a `v=-10`. Peak `B = 160 - 55 = 105`. Player.bottom en
peak = 121. Plataformas con `y` en (121, 159) son alcanzables — un
rango de 38 filas, suficiente para variedad.

`504 M2(I)=120+ALE(28)` → plats en y ∈ [120, 147].

### Verificación

```
plat: x=80 y=140 w=40
frame 0  B=141 C=-8 E=0   (saltando hacia arriba)
frame 6  B=108 C=-2 E=0
frame 9  B=105 C= 1 E=0   (peak)
frame 15 B=124 C= 0 E=1   (LAND, B=plat.y-16=124, E=1 ✓)
```

Sin teleport, sin glitch. Player se sienta limpio sobre la
plataforma.

## Capítulo 5 — Disparo y balas: screen-relative vs world-relative

### Decisión de coordenadas

Las balas pueden vivir en uno de dos espacios:

1. **Screen-relative**: `M5(i) = screen_x`. Cuando la cámara scrollea
   las balas no se mueven con el mundo — siguen volando por el aire
   "fijas" relative al jugador.
2. **World-relative**: `M5(i) = world_x`. Las balas viven en el
   mundo; al scrollear, su screen_x se calcula. Una bala disparada
   y luego volver caminando hacia ella te la podría re-encontrar.

Para un run-and-gun, **screen-relative** es lo que el jugador
espera: la bala vuela y desaparece. Más fácil de programar y rinde
mejor (no hay que recomputar screen_x cada frame).

### Slots rotativos

4 slots de bala, índice rotativo `U`:

```
436 U=(U+1)%4
```

Si todos los slots están ocupados, el más viejo se sobreescribe.
Para un cooldown de 8 frames, esto garantiza que las 4 balas vivas
nunca se pisan: 4 slots × 8 frames = 32 frames de aire mínimo entre
overwrites; las balas (vx=4) cubren 32×4=128 px en ese tiempo, así
que ya están off-screen para cuando vuelven a usarse.

### Cooldown F

```
420 SI F>0 ENT F-=1     ; siempre decrementa
422 SI BTN(5)=0 ENT IR 446  ; sin botón, salta
424 SI F>0 ENT IR 446        ; con cooldown, salta
426 ... spawn bullet
438 F=8                       ; reset cd
```

Sin la línea 420 (decremento incondicional), el cooldown nunca
bajaría. Confiar en el orden importa: primero `F-=1`, después el
`SI F>0` chequea el valor *post-decremento*.

### Posición de spawn

`M5(U)=96` (D=0, mira derecha) o `M5(U)=80` (D=1, mira izq). El
sprite del player es 16×16 con la pistola asomando del lado
derecho; en flip, asoma del izq, así que cambiamos el spawn x.

### Verificación

```
bullets after 100 frames:
  0 x=328 vx=0    (despawned: x>=328 → vx=0)
  1 x=0   vx=0
  2 x=0   vx=0
  3 x=0   vx=0
```

Las 4 balas spawnearon, volaron, salieron de pantalla. Cooldown
funcionando.

## Capítulo 6 — Enemigos: 3 tipos en un sistema

### El problema de la asignación de arrays

Con 26 vars y 8 arrays Mn de 256 ints, la regla práctica es: **un
campo, un array**. Pero ya tengo:

- M0 = estalactitas (slots 0..7)
- M1, M2, M3 = plataformas (slots 0..9, 3 campos)
- M5, M6, M7 = bullets (slots 0..3, 3 campos)

Quedan apenas 1.5 arrays (M4 y los slots altos del resto). Para 8
enemigos con 7 campos cada uno, la solución fue **reusar los mismos
arrays con offset por convención**:

| Array      | Slots 0..15 (lo que ya estaba)    | Slots 16..23 (enemigos) |
|------------|-----------------------------------|-------------------------|
| `M0`       | estalactitas (0..7)               | enemy world_x           |
| `M1`       | plat world_x (0..9)               | enemy y                 |
| `M2`       | plat y (0..9)                     | enemy vx                |
| `M3`       | plat width (0..9)                 | (libre)                 |
| `M4`       | enemy type (0..7)                 | (libre)                 |
| `M5`       | bullet screen_x (0..3)            | enemy hp                |
| `M6`       | bullet y (0..3)                   | enemy timer             |
| `M7`       | bullet vx (0..3)                  | (libre)                 |

Acceder al campo `f` del enemigo `I` queda como `Mf(16+I)`. Verboso
pero no hay alternativa sin sacrificar features. Empaquetar campos en
bits queda como optimización futura — el aritmético sería muy ruidoso
en líneas de 32 chars.

### Spawn unificado: el flag `V`

PAR/SIG no tiene "break" — necesitás un flag para asegurar que sólo
un slot se llena por llamada al spawner:

```
906 V=0
908 PAR I=0 A 7
910 SI V=1 ENT IR 924       ; ya spawneado, skip
912 SI M4(I)<>0 ENT IR 924  ; slot ocupado, skip
914 M4(I)=ALE(3)+1           ; 1=bat, 2=wolf, 3=alien
...
923 V=1
924 SIG
```

`V` se setea sólo cuando un slot vacío se llena, frenando spawns
posteriores en el mismo cuadro. Sin esto, todos los slots vacíos se
llenarían de golpe — contraproducente para el ritmo del juego.

### AI por tipo: dispatcher con `LLA`

El motor permite `LLA` adentro de un `PAR/SIG`. Lo aproveché para
un dispatcher limpio:

```
930 PAR I=0 A 7
932 SI M4(I)=0 ENT IR 956
934 SI M4(I)=1 ENT LLA 960   ; bat AI
936 SI M4(I)=2 ENT LLA 980   ; wolf AI
938 SI M4(I)=3 ENT LLA 1000  ; alien AI
940 SI M5(16+I)<=0 ENT M4(I)=0  ; HP=0 → muere
956 SIG
```

El `I` es la variable de loop de PAR; cuando entrás a 960/980/1000,
`I` sigue siendo válido y vos accedés a tus campos vía `Mf(16+I)`.

**Bat** (línea 960): `M0(16+I) += M2(16+I)` (vuela horizontal),
`M1(16+I) = 60 + SEN(CUA*4+I)/64` (sinusoide en y, ±15 px).

**Wolf** (980): camina hacia el player. Use temp `V` para
descomponer `SI ... ENT M2(16+I)=-1` (que medía 33 chars y rompía el
límite de 32). Ahora:

```
981 V=M2(16+I)              ; temp
982 SI M0(16+I)<W ENT V=1   ; player a la derecha
984 SI M0(16+I)>W ENT V=-1
986 M2(16+I)=V
987 M0(16+I)+=V
```

**Alien** (1000): camina hacia player + teletransport cada 80 frames.
El teleport es `M0(16+I) = A + ALE(320)` — random world_x dentro de
la pantalla actual. Sin animación todavía (Stage 8 polish).

### Render con flip por dirección

Una sola subrutina (1050) renderiza los 3 tipos según `M4(I)`:

```
1058 N=0
1060 SI M2(16+I)<0 ENT N=1   ; vx<0 → flip horizontal
1061 Y=M1(16+I)               ; precompute para fits-in-32
1062 SI M4(I)=1 ENT LLA 1085  ; bat (animado)
1064 SI M4(I)=2 ENT SPR 6,T,Y,N
1066 SI M4(I)=3 ENT SPR 8,T,Y,N
```

Bat anima entre sprites 4 y 5: `P=4+CUA/8%2; SPR P,T,Y,N`. Wolf y
alien son sprites estáticos.

### Verificación

Con seed default los wolves no aparecieron (~13% de prob de no
salir wolves en 5 spawns). Con seed=42:

```
seed=42: bats:2 wolves:3 aliens:3 ✓
seed=7:  bats:3 wolves:3 aliens:2 ✓
```

Distribución uniforme sobre tipos. ALE funciona como esperado.

## Capítulo 7 — Colisiones, score y level-up (con detour al motor)

### Bullet ↔ enemy: doble PAR anidado

```
1130 PAR I=0 A 7              ; outer: enemigos
1132 SI M4(I)=0 ENT IR 1166
1134 W=(M0(16+I)-A+2048)%2048  ; enemy screen_x
1136 SI W>=320 ENT IR 1166
1138 Y=M1(16+I)
1140 PAR J=0 A 3              ; inner: balas
1142 SI M7(J)=0 ENT IR 1162
1144 SI M5(J)+4<W ENT IR 1162
1146 SI M5(J)>W+12 ENT IR 1162
1148 SI M6(J)+2<Y ENT IR 1162
1150 SI M6(J)>Y+12 ENT IR 1162
1152 M5(16+I)-=1               ; HP -= 1
1153 M7(J)=0                   ; bullet despawn
1154 SI M5(16+I)<=0 ENT LLA 1300  ; enemy died?
1162 SIG
1166 SIG
```

Dos `PAR` anidados (depth 2). La engine soporta hasta `LOOP_DEPTH=8`,
así que sobra. La AI dispatcher (`LLA 980/1000`) ya ocupaba un nivel
extra cuando entraba a wolf/alien con su propio acceso a campos —
todo entra en presupuesto.

### Player ↔ enemy: 1-hit dies

Lógica simple: cualquier overlap del BB del player (16×16 en
`(80, B)`) con el de un enemy → `S=2` (game over). Sin vidas
múltiples; iteración futura puede agregar barra de vida tipo
mario-mini.

### El bug del slot equivocado: `vars[28]` no es `NIV`

Mi primer smoke test leía `vm.state.vars[28]` esperando ver `NIV`.
Después de un kill que debía gatillar level up, el test mostraba:

```
NIV=0  pal=1  K=0  PUN=1
```

Inconsistente: la paleta cambió a 1, pero NIV seguía en 0. El bug
estaba en el test, no en el juego. Mirando
[src/core/memory.js:5-7](src/core/memory.js#L5-L7):

```
//   VID          → slot 28
//   PUN          → slot 29
//   NIV          → slot 30
```

Slot 28 es `VID`, no `NIV`. `vars[30]` mostró el valor correcto
(NIV=1). Lección: cuando un valor "se computa pero no se ve",
siempre revisar primero el harness antes que la lógica del juego.

### El detour: implementar `PAL n` en el motor

Mi level-up tenía esta línea:

```
1324 PAL NIV%3
```

Falló en parse: "identificador PAL sin asignación ni builtin
conocido". Viendo
[src/parser/lexer.js:34](src/parser/lexer.js#L34) y
[docs/REFERENCIA.md:366](docs/REFERENCIA.md#L366):

> **No implementado todavía** como statement: el sistema multi-paleta
> vive al nivel del bank.

`PAL n` estaba *documentado* pero no *implementado*. La infraestructura
JS existía (`createPaletteBank`/`setActivePalette` en
[src/render/palette.js](src/render/palette.js)) pero nunca se cabló a
un opcode v2-A.

En vez de hackear un workaround (cambiar el color de `BOR` para
falsificar un swap), implementé el opcode real. Cinco cambios:

1. **`bytecode.js`**: `PAL: 0x91` (nuevo opcode, slot libre tras
   `CARNIV: 0x90`).
2. **`lexer.js`**: agregar `'PAL'` al set `BUILTINS`.
3. **`compiler.js`**: `case 'PAL': return emitFixed(ctx, ast, 1, OP.PAL);`
   — patrón idéntico a `CARNIV`.
4. **`interpreter.js`**: case `OP.PAL` que pop el arg y llama
   `setActivePalette(vmRef.bank, n)`.
5. **`v2a-to-rvm32.js` + `mmio.js`**: `CMD.PAL: 0x51` para que la
   transpilación a RVM-32 funcione idéntica al v2-A interpreter.

Total ~15 líneas de motor. Validación trivial: en el test post-kill,
`vm.bank.active` pasó de 0 a 1 al subir de nivel. Los 321 tests
existentes siguieron verdes.

REFERENCIA.md también se actualizó: la nota de "no implementado
todavía" desaparece; queda sólo el caveat del scanline-override
(que sigue reservado para futuro).

**Por qué vale la pena el detour**: el juego declarativo "este
nivel es purpura" es más expresivo que "BOR=2 representa purpura
porque sí". Y el costo fue pequeño porque la infra ya estaba.

### Score como dígitos

Patrón calcado de [tetris.retro:9100-9180](games/tetris.retro#L9100):
descomponer `PUN` en 4 dígitos (miles, cientos, decenas, unidades),
guardar en `M2(28..31)`, e iterar con `SI V=N ENT TXT X,8,"N",7`
para cada dígito 0-9.

Es 10 líneas por dígito-render — quizá la cosa más fea del juego —
pero es lo que hay sin un primitivo `TXT_NUM`. Posible mejora futura:
agregar `TXT n,x,y,c` que tome int en vez de string-literal.

## Capítulo 8 — Audio, relámpago, restart

### SONIDO blocks: 6 SFX

```
SONIDO 0 (shoot)   ONDA PUL, PUL 4, ENV 0,1,8,1, NOTA SOL5/DO5
SONIDO 1 (jump)    ONDA TRI, NOTA DO4 → SOL4 → DO5 (sweep up)
SONIDO 2 (hit)     ONDA SIE, NOTA FA3 corto
SONIDO 3 (kill)    ONDA TRI, DO5 → FA4 → DO4 (sweep down)
SONIDO 4 (thunder) ONDA SIE, NOTA DO2 16 (largo y profundo)
SONIDO 5 (level)   acorde DO/MI/SOL → DO5 (resolución)
```

Triggers en cada lugar relevante:
- `SON 0,0` después de spawn de bala (línea 440).
- `SON 1,1` al saltar (línea 311, condicional al jump válido).
- `SON 2,2` al pegarle a un enemigo con bala (línea 1155).
- `SON 3,3` cuando un enemigo muere (línea 1305).
- `SON 4,3` al disparar relámpago (línea 603).
- `SON 5,3` en level up (línea 1325).

Los canales se eligen para evitar pisarse: shoot/hit en canales bajos
(0,2), kill/level/thunder en alto (3) — el VM tiene 4 canales tonales
+ 1 ruido, la elección impacta polifonía.

### Restart desde game over

Cuando el player muere, además de `S=2` reseteo `L=0` (contador de
wait) y disparo `SON 2,3` (hit grave). El handler 800:

```
800 BOR 0
802 L+=1
805 TXT 8,8,"PUN",7
806 LLA 1240             ; render PUN como dígitos
810 TXT 112,80,"GAME OVER"
812 SI L<30 ENT IR 824   ; pre-cooldown: no aceptar input
814 TXT 80,140,"PRESIONA TECLA"
816 SI BTN(0) ENT IR 830
818 SI BTN(1) ENT IR 830
820 SI BTN(4) ENT IR 830
822 SI BTN(5) ENT IR 830
824 RET

830 LLA 100              ; re-init partida
834 RET
```

Trick: el cooldown de 30 frames (medio segundo a 60 fps) evita que el
mismo botón que mató al player (probablemente apretado al momento de
la muerte) lo haga restart instantáneo. Patrón clásico en arcades.

### Verificación

```
after death:    S=2  L=4   (justo después de morir)
after wait:     L=39        (>30 cooldown pasado)
after BTN(0):   S=0  PUN=0  cam=0   (full reset al title)
```

Stage 9 cerrado.

## Capítulo 9 — Cosim RVM-32: el juego pasa la línea

ROLLOX es ahora el reference game número 10. Lo agregué a
[tests/integration/rvm32-games.test.js](tests/integration/rvm32-games.test.js)
con `fbMax: 0` — exige identidad byte-a-byte entre v2-A interpretado y
RVM-32 transpilado.

```js
const games = [
  { name: 'pelota',     fbMax: 0 },
  ...
  { name: 'espacial',   fbMax: 256 },  // ALE order
  { name: 'rollox',     fbMax: 0 },    // identidad pura
];
```

Pasa al primer intento. Esto incluye el `PAL n` que acabo de agregar:
los dos paths (v2-A directo y RVM-32 vía MMIO `CMD.PAL`) deciden la
misma paleta activa, así que el blit final usa el mismo banco de
colores. El framebuffer queda idéntico.

Con esto cierra el ciclo: **el juego está implementado, testeado, y
demostrado portable a la ISA RVM-32 sin pérdida**. La próxima vez que
alguien escriba un nuevo reference game con `PAL n`, queda como
parte del lenguaje, sin asteriscos.

### Cifras finales

- **~470 líneas** de `.retro` (sprites + paletas + sonidos +
  PROGRAMA).
- **6 sprites de player** (4 frames + 2 reservados), 6 sprites
  de enemigo, 4 letras de título.
- **3 paletas** de 16 colores (cueva base + variantes nivel).
- **6 sonidos** (shoot/jump/hit/kill/thunder/level).
- **8 slots de enemigos** simultáneos, 4 de balas, 10 de plataformas,
  8 de estalactitas. Todo en arrays Mn con offsets convencionales.
- **0 modificaciones** al núcleo del motor *fuera* de implementar
  `PAL n` — el resto fue cuestión de combinar primitivas.

### Lo que no entró (deuda técnica explícita)

- **Animación de portal de spawn**: los enemigos aparecen
  instantáneamente. Sería un sprite extra + 3 frames de timer
  pre-spawn. Polish.
- **Caca de bat / proyectil de alien**: los aliens no disparan, los
  bats no dropean caca. Requiere otro pool de proyectiles separado de
  las balas del player. ~30 líneas.
- **Aiming up**: el player dispara horizontal. Para matar bats hay
  que jumping al nivel correcto. Una mecánica `BTN(2)+BTN(5)` →
  bullet diagonal sería ~10 líneas.
- **Vidas múltiples**: 1-hit dies. Un sistema de vidas con barra
  HUD vendría como ~20 líneas extra.
- **Variación visual real entre paletas**: las 3 paletas son
  cualitativamente distintas (cueva azul → púrpura → roja) pero
  todos los sprites comparten los mismos índices. Un swap más
  agresivo cambiaría también la paleta de sprites.

Estos quedan como ejercicios abiertos para iteraciones futuras.

### Comparación con los otros reference games

| Juego       | Líneas | Sprites | Sonidos | Cosim fbMax |
|-------------|-------:|--------:|--------:|------------:|
| pelota      |    ~80 |       2 |       1 |           0 |
| serpiente   |   ~110 |       0 |       2 |           0 |
| memoria     |   ~190 |       6 |       2 |           0 |
| pong        |   ~160 |       2 |       2 |           0 |
| saltarin    |   ~180 |       4 |       3 |           0 |
| camaleon    |   ~200 |       6 |       2 |           0 |
| espacial    |   ~210 |       4 |       3 |         256 |
| mario-mini  |   ~260 |       8 |       4 |           0 |
| tetris      |   ~540 |       7 |       3 |           0 |
| **rollox**  |  ~470 |     ~16 |       6 |           0 |

ROLLOX no es el más grande (tetris lo es), pero es el más
*sistémico* — múltiples sub-sistemas (scroll, parallax, AI por tipo,
collisions, level-up) trabajando juntos. Es el reference game que
demuestra que el motor escala más allá de juegos simples.

---

## Capítulo 10 — Iteración: aiming, vertical sin, balas-grandes

Tres pedidos de ajuste post-stage-10:

### Aiming hacia arriba con BTN(2)

Las balas tenían sólo `vx`. Para disparar hacia arriba agregué un
storage de `vy` por bala usando otro slot de array libre:
- `M3(20+i)` = bullet vy (i en 0..3).

Los slots `M3(0..9)` ya estaban en plat width — slots 20..23 estaban
vacíos. Misma convención que el resto: cada array reserva rangos
para distintos pools.

En el shoot:
```
432 M7(U)=4
434 SI D=1 ENT M7(U)=-4
435 M3(20+U)=0
436 SI BTN(2) ENT M3(20+U)=-5
437 SI BTN(2) ENT M7(U)=0      ; up tiene prioridad
438 SI BTN(2) ENT M5(U)=80
```

`BTN(2)` (arriba) sobreescribe vx=0 y setea vy=-5. Bala sale recta.

### Bullet "vivo" con ambos componentes

El check de "bala activa" antes era `M7(I)=0`. Ahora una bala con
vy distinto de cero pero vx=0 (subiendo) se contaba como muerta.
Cambié a sumar las dos velocidades:

```
1101 Q=M7(I)+M3(20+I)
1102 SI Q=0 ENT IR 1108
```

Si ambas son 0 → muerta. Si cualquiera es != 0 → viva. Q es temp y
se reusa en cada iteración del loop. La línea original con
condición compuesta (`M7=0 Y vy=0`) medía 41 chars — temp con `+`
fue la salida más corta y compatible con el linter.

### Flying enemies cubren toda la vertical

El usuario notó que los bats con `y = 60 + SEN/64` quedaban en una
banda de 30 px arriba — fácil de ignorar. Cambié a:

```
962 M1(16+I)=80+SEN(CUA*4+I)/16
```

`SEN` retorna ±1000, `/16 = ±62`. Y queda en `[18, 142]` — desde el
techo de la cueva hasta justo encima del piso. El jugador ahora sí
tiene que mirar todo el cuadro para ubicarlos.

Para los aliens hice lo mismo pero más lento (`CUA*2` en vez de
`CUA*4`):
```
1009 M1(16+I)=80+SEN(CUA*2+I)/16
```

Los wolves siguen pegados al piso (caminan, no vuelan).

### Balas tamaño-personaje

`REC M5(I),M6(I),4,2,10` (4×2 px) → `REC M5(I),M6(I),16,16,10`
(16×16). Bala amarilla del tamaño del jugador. Visualmente
dominante pero matchea el "feel" pesado que pidió el usuario.

Las hitboxes de colisión también pasaron de `+4/+12` a `+16/+16`
para ser consistentes con el visual:

```
1144 SI M5(J)+16<W ENT IR 1162
1146 SI M5(J)>W+16 ENT IR 1162
1148 SI M6(J)+16<Y ENT IR 1162
1150 SI M6(J)>Y+16 ENT IR 1162
```

El spawn x también se ajustó: izquierda dispara desde `M5=64` (16
px a la izq del player) en vez de `80` (encima del player).

### Resultado

Los 322 tests siguen verdes. Cosim RVM-32 verde. El juego se siente
más "completo" — hay verticalidad real, las balas tienen presencia,
y el jugador tiene una mecánica para alcanzar bats sin necesidad de
estar parado en una plataforma específica.

---

**Fin del devlog.** El código completo en
[games/rollox.retro](../games/rollox.retro).

