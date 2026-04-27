# Tutorial — Serpiente desde cero

> Vamos a construir un juego de Serpiente jugable, paso a paso, desde un
> archivo `.retro` vacío hasta los ~60 renglones del juego completo.
> Si querés mirar el resultado final antes de arrancar, está en
> [games/serpiente.retro](../games/serpiente.retro).

**Antes de empezar**, conviene haber leído de un vistazo
[PLAN.md](PLAN.md) (la filosofía del VM) y
[REFERENCIA.md](REFERENCIA.md) (el catálogo de mnemónicos). No hace falta
memorizar nada — vamos a usar las cosas a medida que aparezcan.

**Cómo seguir el tutorial**: copiá los snippets a `games/mi-snake.retro`
y andá probándolos con `npm run dev` (cambiando el `import` en
[web/main.js](../web/main.js) si es necesario). Cada sección es un
incremento — el código del paso N incluye al de los pasos anteriores.

---

## 1. ¿Qué vamos a construir?

Un Snake clásico:

- Una serpiente de cuadraditos verdes que avanza en una grilla.
- Comida amarilla aparece en posiciones aleatorias.
- Las flechas del teclado rotan la dirección.
- Comer la comida hace crecer el cuerpo y suma puntos.
- Chocar con el cuerpo o con un borde termina el juego.

Hardware ficticio del VM: pantalla 320×200 con 16 colores indexados.
Vamos a usar una grilla de 32×20 celdas de 8×8 píxeles cada una, lo
que cubre 256×160 (centrado en pantalla con un margen para el HUD).

---

## 2. El esqueleto del archivo

Cada juego en RollitoVM empieza con un header y un bloque `PROGRAMA`.
Empezá tu archivo así:

```
JUEGO Serpiente
AUTOR Yo
VERSION 1

PROGRAMA
10 EN CUADRO IR 100
100 BOR 0
110 RET
```

Qué hace cada cosa:

- `JUEGO/AUTOR/VERSION` — metadatos del juego, opcionales pero
  convencionales.
- `PROGRAMA` — marca el inicio del código.
- `10 EN CUADRO IR 100` — engancha el handler del evento `CUADRO`
  (que dispara 60 veces por segundo) a la línea 100.
- `100 BOR 0` — pinta toda la pantalla de color 0 (negro).
- `110 RET` — vuelve del handler.

Si lo cargás en el VM, deberías ver una pantalla negra a 60 fps.
**No es muy emocionante todavía**, pero ya estás corriendo código.

> **Tip — la regla de los 32 caracteres**: cada línea del bloque
> `PROGRAMA` debe medir ≤ 32 chars (incluyendo el número de línea).
> El parser no rechaza líneas más largas, pero el linter avisa. La
> idea es que el código sea legible y compacto al estilo "revista de
> los 80". A medida que avanza el tutorial vas a ir aprendiendo
> trucos para entrar en 32.

---

## 3. La grilla

El cuerpo de nuestra serpiente vive en una **grilla de celdas** de
32×20, con celdas de 8×8 píxeles. Vamos a guardar las posiciones en
**columnas y filas** (no píxeles) y convertir a píxeles sólo al
dibujar.

Centrar la grilla en la pantalla:

- Margen horizontal: `(320 - 32×8) / 2 = 32` px.
- Margen vertical: `(200 - 20×8) / 2 = 20` px.

Para dibujar una celda en columna `c`, fila `f`:

```
X = 32 + c*8
Y = 20 + f*8
REC X,Y,8,8,11
```

`REC x,y,w,h,c` es un rectángulo relleno. Color 11 es el verde claro
de la paleta default (`00E436`).

**Probá esto** en el handler de CUADRO:

```
100 BOR 0
105 REC 32+15*8,20+10*8,8,8,11
110 RET
```

Vas a ver un cuadradito verde fijo en el centro. Próximo paso: hacerlo
moverse.

---

## 4. Variables y movimiento

Necesitamos guardar:

- **Posición de la cabeza**: `A` (columna), `B` (fila).
- **Dirección**: `D` (0=arriba, 1=derecha, 2=abajo, 3=izquierda).

Al inicio del juego (evento `INICIOJUEGO`), inicializá los valores:

```
10 EN INICIOJUEGO IR 90
20 EN CUADRO IR 100

90 A=15:B=10
92 D=1
94 RET

100 BOR 0
105 REC 32+A*8,20+B*8,8,8,11
110 RET
```

Ahora vamos a mover la cabeza una celda según `D`. Cada cuadro:

```
100 SI D=0 ENT B-=1
105 SI D=1 ENT A+=1
110 SI D=2 ENT B+=1
115 SI D=3 ENT A-=1
120 BOR 0
125 REC 32+A*8,20+B*8,8,8,11
130 RET
```

**Pero esto va a la velocidad de 60 fps** — la cabeza se va a salir
de la pantalla en medio segundo. Necesitamos throttle.

---

## 5. Velocidad: avanzar cada V cuadros

Truco clásico: usá `CUA` (contador global de cuadros, read-only) y
sólo movete cuando `CUA % V == 0`, para alguna `V` razonable.
`V=8` da 60/8 = 7.5 movimientos por segundo, jugable.

```
90 A=15:B=10:D=1:V=8
94 RET

100 SI CUA%V<>0 ENT 120
105 SI D=0 ENT B-=1
110 SI D=1 ENT A+=1
115 SI D=2 ENT B+=1
117 SI D=3 ENT A-=1
120 BOR 0
125 REC 32+A*8,20+B*8,8,8,11
130 RET
```

Ahora la cabeza camina a una velocidad jugable. Le falta el input.

---

## 6. Input: las flechas

Los botones del VM (`BTN(b)`) son:

| `b` | Tecla en el browser |
|-----|---------------------|
| 0   | ←                   |
| 1   | →                   |
| 2   | ↑                   |
| 3   | ↓                   |

Cambiá `D` según las flechas, **pero evitá la reversa de 180°** (no
podés ir de derecha a izquierda directamente — eso te haría chocar
con tu propio cuello):

```
200 SI BTN(0) Y D<>1 ENT D=3
205 SI BTN(1) Y D<>3 ENT D=1
210 SI BTN(2) Y D<>2 ENT D=0
215 SI BTN(3) Y D<>0 ENT D=2
220 RET
```

Y llamalo desde `CUADRO` como subrutina:

```
100 LLA 200
105 SI CUA%V<>0 ENT 125
110 SI D=0 ENT B-=1
112 SI D=1 ENT A+=1
115 SI D=2 ENT B+=1
117 SI D=3 ENT A-=1
125 BOR 0
130 REC 32+A*8,20+B*8,8,8,11
135 RET
```

Probá: deberías poder mover la cabeza con las flechas.

---

## 7. El cuerpo: arreglos M0/M1 como ringbuffer

La cabeza sola no es una serpiente. Necesitamos un **cuerpo** —
una lista ordenada de celdas. Como las arreglos `M0..M7` tienen 256
slots, podemos usar:

- `M0(i)` = columna del segmento `i`.
- `M1(i)` = fila del segmento `i`.

Pero la serpiente crece y se mueve — agregar y sacar elementos al
azar costaría. **Usamos un ringbuffer**: tres índices guardan
el estado:

- `T` = índice de la **cola** en M0/M1.
- `H` = índice de la **cabeza**.
- `L` = **largo** actual.

Para "avanzar" la cabeza:

1. Calculá las nuevas coordenadas `(A, B)` (paso 5).
2. `H = (H+1) % 256` y guardá `M0(H)=A, M1(H)=B`.
3. `T = (T+1) % 256` (descartar el último segmento de la cola).

Para crecer (cuando comemos), saltamos el paso 3.

Iniciamos con un cuerpo de largo 3 horizontal:

```
90 M0(0)=15:M1(0)=10
92 M0(1)=16:M1(1)=10
94 M0(2)=17:M1(2)=10
96 T=0:H=2:L=3
98 D=1:V=8
99 RET
```

Para dibujar todos los segmentos, recorrelos con un `PAR`:

```
400 PAR I=0 A L-1
405 J=(T+I)%256
410 X=32+M0(J)*8
412 Y=20+M1(J)*8
415 REC X,Y,8,8,11
420 SIG
425 RET
```

Y reemplazá el dibujo de la cabeza única por un `LLA 400` en el
handler de cuadro.

> **Recordá**: `PAR I=0 A L-1` itera **inclusive**. Si `L=3`, va
> `I=0,1,2` — exactamente los 3 segmentos.

---

## 8. Movimiento real con ringbuffer

Ahora el "step" mueve la cabeza y avanza el ringbuffer:

```
300 A=M0(H):B=M1(H)
305 SI D=0 ENT B-=1
310 SI D=1 ENT A+=1
315 SI D=2 ENT B+=1
320 SI D=3 ENT A-=1
360 H=(H+1)%256
365 M0(H)=A:M1(H)=B
372 T=(T+1)%256
375 RET
```

Y desde el handler de cuadro:

```
100 LLA 200                  ; input
105 SI CUA%V<>0 ENT 130
110 LLA 300                  ; step
130 BOR 0
135 LLA 400                  ; draw body
140 RET
```

Probá: una serpiente de 3 segmentos camina y gira con las flechas.

---

## 9. La comida

Una sola variable de columna `F` y otra de fila `G` alcanzan. Al
spawnearla, usamos `ALE(n)` — random entre 0 y n-1, con un PRNG
**determinista** (mismo seed = misma secuencia).

```
800 F=ALE(32)
805 G=ALE(20)
810 RET
```

Llamalo en el INICIOJUEGO (`LLA 800` antes del `RET`).

Dibujala como un cuadradito amarillo (color 8):

```
460 X=32+F*8:Y=20+G*8
465 REC X,Y,8,8,8
470 RET
```

E invocala desde el handler:

```
130 BOR 0
135 LLA 400
138 LLA 460
140 RET
```

---

## 10. Crecer al comer

Antes del paso `T = (T+1) % 256`, chequeamos si la cabeza está sobre
la comida:

```
360 H=(H+1)%256
365 M0(H)=A:M1(H)=B
370 SI A=F Y B=G ENT 390
372 T=(T+1)%256
375 RET

390 L+=1:PUN+=1
392 LLA 800                  ; respawn comida
394 RET
```

Si comimos: largo+=1, score+=1, spawn nueva comida, y **no avanzamos
la cola** (eso es lo que hace crecer al cuerpo).

`PUN` es una variable especial del VM (puntos del jugador). Cualquier
otra variable A-Z también valdría, pero `PUN` deja al host mostrarla
en interfaz fácil.

---

## 11. Game over: chocar con el cuerpo o con un borde

Ya casi está. Después de calcular `(A, B)` y antes de mover la
cabeza, validá:

```
325 SI A<0 O A>31 ENT 380
330 SI B<0 O B>19 ENT 380
335 PAR I=0 A L-1
340 J=(T+I)%256
345 SI M0(J)=A Y M1(J)=B ENT Z=1
350 SIG
355 SI Z=1 ENT 380
```

Donde `Z=1` significa "game over". El handler general también lo
chequea para skipear input/movimiento:

```
100 SI Z=1 ENT 130           ; skip input + step
105 LLA 200
110 SI CUA%V<>0 ENT 130
115 LLA 300
130 BOR 0
135 LLA 400
138 LLA 460
140 SI Z=0 ENT 150
145 TXT 96,80,"GAME OVER",8
150 RET
```

`TXT x,y,"texto"[,c]` dibuja con la fuente 8×8 hardcoded del VM.
Color 8 es el rojo brillante en la paleta default.

Y el handler de "muerte" inicial:

```
380 Z=1
385 RET
```

---

## 12. Sonido

Definí dos sonidos antes del bloque `PROGRAMA`. Cada `SONIDO n` se
cierra con `FIN`.

```
SONIDO 0
ONDA PUL
PUL 6
ENV 0,1,12,2
NOTA SOL5 2
NOTA DO6 3
FIN

SONIDO 1
ONDA SIE
ENV 0,4,0,4
NOTA DO3 8
NOTA FA2 12
FIN
```

`ONDA PUL/SIE/TRI/SEN` define la forma de onda (cuadrada/sierra/
triangular/senoidal). `ENV a,d,s,r` es la envolvente ADSR
(0..15 cada valor). `NOTA <nota> <ticks>` toca durante `ticks/60`
segundos. Las notas usan notación hispana (`DO RE MI FA SOL LA SI`)
+ octava `0..7` + opcional `#` o `b`.

Disparalos desde el código:

- Al comer: `SON 0,0` (sonido 0 en canal tonal 0).
- Al morir: `SON 1,1` (sonido 1 en canal 1).

Insertalos en las líneas correspondientes:

```
380 Z=1:SON 1,1
385 RET
390 L+=1:PUN+=1:SON 0,0
392 LLA 800
394 RET
```

> **Importante**: el browser sólo activa el AudioContext después del
> primer gesto del usuario (apretar una tecla, hacer clic). Hasta
> entonces no vas a escuchar nada — es una limitación de los
> navegadores, no del VM.

---

## 13. Score y mensaje

La fuente del VM no tiene una primitiva "imprimir número", pero
podemos faquearlo con un loop de rectangulitos:

```
102 TXT 8,4,"PUNTOS",7
104 SI PUN=0 ENT 110
106 PAR I=1 A PUN%10
108 REC 64+I*5,4,4,8,11
109 SIG
```

7 es el blanco crema (`FFF1E8`). Cada punto se ve como un
rectanguliito verde a la derecha de "PUNTOS".

Insertalo al principio del CUADRO handler.

---

## 14. Determinismo y testing

Acá está la pieza interesante: si creás dos VMs con el mismo `seed`
y les das la misma secuencia de inputs, jugás partidas **idénticas
cuadro a cuadro**. La comida aparece en las mismas celdas, la
serpiente termina en el mismo lugar.

```js
// En tests/system/serpiente.test.js (ya existe en el repo):
const a = createVM(source, { seed: 7 });
const b = createVM(source, { seed: 7 });
a.runFrame(); b.runFrame();
expect(a.state.vars[5]).toBe(b.state.vars[5]);  // F
```

Eso te permite tests de regresión con golden frames si querés ir más
lejos. Es la base de los tests de sistema reproducibles.

---

## 15. Más allá

Tu Serpiente está terminado. Ideas para extenderlo:

- **Aumentar velocidad** con cada comida: `V-=1` cuando `L%5=0`.
- **Paredes internas**: agregá tiles sólidos en el mapa de fondo y
  chequeá colisión usando `MAPA + COLM`.
- **Comida especial**: una segunda comida amarilla que vale 5 puntos
  pero dura sólo 60 cuadros. Usá `M2(0)=cuenta` para el timer.
- **Pausa**: `EN PAUSA` para mostrar "PAUSADO" cuando el host
  llama `vm.pause()` (Esc en el browser).
- **Niveles**: con `CARNIV n` cambiás el "nivel" (ej. cambia paleta,
  velocidad, layout). Activa los handlers `CARGANIVEL` e
  `INICIONIVEL` automáticamente.

---

## El código completo

Está en [games/serpiente.retro](../games/serpiente.retro). Tiene
exactamente las piezas que armamos acá, pero las líneas están
numeradas distinto y agrupadas por función. La línea más larga mide
32 chars exactos.

Una buena practica es leer el archivo final completo después de
haber armado las piezas paso a paso — vas a entender por qué cada
decisión está así y vas a poder modificarlo con confianza.

¡A jugar! 🐍
