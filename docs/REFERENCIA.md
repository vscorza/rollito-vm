# RollitoVM — Referencia del Lenguaje

Lista canónica de todos los mnemónicos de RollitoVM. Cada entrada incluye
firma, descripción breve y un ejemplo de ≤ 32 caracteres. Los ejemplos
asumen que ya hay sprites/paletas/sonidos definidos en el archivo.

> Los números de línea en los ejemplos son ilustrativos. En tu programa
> usá los que te queden cómodos.

---

## Convenciones

- `n`, `m`, `c`, `p` → enteros 0..N
- `x`, `y`, `w`, `h` → enteros (coordenadas o tamaños en pixeles)
- `var` → una de las 26 variables enteras (`A`..`Z`)
- `expr` → expresión entera
- `cond` → expresión booleana (0 = falso, ≠0 = verdadero)
- `EJE` → literal `X` o `Y`
- Comentarios: línea o sufijo que empieza con `;`

---

## 1. Estructura del archivo

| Clave    | Descripción                                              |
|----------|----------------------------------------------------------|
| `JUEGO`  | Nombre del juego (una palabra)                           |
| `AUTOR`  | Nombre libre                                             |
| `VERSION`| Entero                                                   |
| `PALETA n`  | Define paleta n (16 colores hex en líneas siguientes) |
| `SPRITE n WxH` | Define patrón gráfico                              |
| `MAPA n WxH`   | Define mapa de tiles                               |
| `SONIDO n` | Define un efecto/melodía                               |
| `PROGRAMA` | Marca el inicio del código                             |

Las definiciones de paleta, sprite, mapa y sonido se cierran cuando
empieza otra cláusula del mismo nivel o `PROGRAMA`. `SONIDO` cierra con
`FIN`.

> **Paleta default**: si declarás `PALETA 0` en el archivo, esa paleta
> queda activa al iniciar el juego (sobrescribe la PICO-8 hardcoded).
> Las paletas 1, 2 y 3 quedan disponibles en el bank para usarlas
> programáticamente.

---

## 2. Eventos del ciclo de vida

`EN <evento> IR <linea>` engancha código. Un mismo evento sólo puede
tener un handler activo; el último `EN` gana.

| Evento          | Disparo                                              |
|-----------------|------------------------------------------------------|
| `INICIOMOTOR`   | Una vez al arrancar el VM                            |
| `INICIOJUEGO`   | Una vez tras cargar todo                             |
| `CARGANIVEL`    | Antes de mostrar nivel (también con `CARNIV n`)      |
| `INICIONIVEL`   | Cuando empieza la jugabilidad                        |
| `CUADRO`        | 60 veces por segundo, antes del render               |
| `FINCUADRO`     | Después del blit                                     |
| `PAUSA`         | Al pausar (vía statement `PAUSA` o `vm.pause()`)     |
| `REANUDA`       | Al reanudar (sólo `vm.resume()` desde el host)       |
| `CANAL c`       | Cuando termina un sonido en canal `c` (0..3 tonal, 4 ruido) |
| `SILENCIO`      | Cuando todos los canales quedan en silencio          |
| `LINEA n`       | **No implementado**. Reservado para futuro hito.    |

```
10 EN CUADRO IR 100      ; 19 chars
20 EN CANAL 1 IR 500     ; 20 chars
30 EN INICIONIVEL IR 800 ; 24 chars
```

---

## 3. Control de flujo

### `SI cond ENT acción [SINO acción]`
Condicional en una línea. La acción puede ser una instrucción simple,
otra `SI`, o un número de línea (atajo de `IR`).

```
10 SI A>5 ENT IR 100              ; 19
20 SI BTN(0) ENT VEL 0,-2,0       ; 27
30 SI VID=0 ENT FIN SINO IR 50    ; 30
```

### `PAR var=a A b ... SIG`
Bucle for-next clásico. Las iteraciones recorren `var` de `a` hasta `b`
inclusive. Anidamiento permitido hasta profundidad 8.

```
10 PAR I=0 A 7                    ; 14
20 PIN I*4,50,I                   ; 15
30 SIG                            ;  6
```

### `IR n`
Salto incondicional a línea `n`.

```
40 IR 100                         ;  9
```

### `LLA n`
Llamada a "subrutina" (push del PC actual). Vuelve con `RET`.

```
50 LLA 200                        ; 10
```

### `RET`
Retorno de subrutina o de handler de evento.

```
60 RET                            ;  6
```

### `FIN`
Termina el programa. El VM queda en estado de "game over".

```
70 SI VID=0 ENT FIN               ; 19
```

### `PAUSA`
Pone el VM en pausa. Detiene el handler actual y dispara `EN PAUSA` al inicio
del próximo cuadro. **Importante**: el código del juego no puede salir de
pausa por sí mismo — sólo el host (browser/test driver) llamando
`vm.resume()`. Cuando el host reanuda, dispara `EN REANUDA`.

```
80 SI BTN(6) ENT PAUSA            ; 22
```

---

## 4. Variables y asignación

26 variables `A`..`Z` enteras (32 bits con signo). 8 arreglos `M0`..`M7`,
cada uno de 256 enteros.

| Forma         | Descripción                                  |
|---------------|----------------------------------------------|
| `var = expr`  | Asignación simple                            |
| `var += expr` | Incrementar                                  |
| `var -= expr` | Decrementar                                  |
| `var *= expr` | Multiplicar y asignar                        |
| `var /= expr` | Dividir entera y asignar                     |
| `Mn(i) = expr`| Asignación de elemento de arreglo            |

```
10 A=5                            ;  6
20 B+=1                           ;  7
30 C=A*2+B                        ; 10
40 M0(3)=A+B                      ; 13
50 M1(I)=M0(I)*2                  ; 17
```

Operadores: `+ - * / %` (entero), `< <= > >= = <>` (comparación),
`Y` (and lógico), `O` (or lógico), `NO` (not lógico).

Variables especiales reservadas:

| Nombre | Significado                                     |
|--------|-------------------------------------------------|
| `VID`  | Vidas del jugador                               |
| `PUN`  | Puntos                                          |
| `NIV`  | Nivel actual                                    |
| `CUA`  | Contador global de cuadros (read-only)          |
| `LIN`  | Línea actual durante `LINEA` (read-only)        |

---

## 5. Dibujo directo

### `BOR c`
Borra la pantalla pintándola con el color `c`.

```
10 BOR 0                          ;  8
```

### `PIN x,y,c`
Pinta un pixel.

```
20 PIN 50,100,3                   ; 14
```

### `LIN x1,y1,x2,y2,c`
Dibuja una línea (Bresenham).

```
30 LIN 0,0,319,199,2              ; 20
```

> **No implementado todavía**: `LIN` quedó deferido. `BOR`, `PIN`, `REC`
> y `TXT` cubren las necesidades de los 5 ejemplos canónicos.

### `REC x,y,w,h,c`
Rectángulo relleno.

```
40 REC 0,190,320,10,4             ; 21
```

### `TXT x,y,"texto"`
Texto en fuente 8×8 incluida. Se imprime con el color de paleta `1`
por defecto.

```
50 TXT 8,8,"Puntos"               ; 18
60 TXT 80,8,"NIVEL 1"             ; 21
```

---

## 6. Sprites y actores

Recordá: 32 slots, cada uno tiene patrón (imagen) y estado (posición,
velocidad, etc.). Por defecto el slot n usa el patrón n.

### `SPR n,x,y[,f]`
Dibujo inmediato del patrón `n` en `(x, y)`. No actualiza estado del
actor. Flag opcional: 1=flipX, 2=flipY, 3=ambos.

```
10 SPR 5,100,50                   ; 14
20 SPR 5,100,50,1                 ; 16
```

### `MOV n,x,y`
Posiciona el actor `n` y lo hace visible.

```
30 MOV 0,160,100                  ; 16
```

### `VEL n,vx,vy`
Setea velocidad por cuadro.

```
40 VEL 0,2,1                      ; 12
```

### `INV n,EJE`
Invierte la velocidad del actor en el eje `X` o `Y`. Útil para rebotes
en una sola línea.

```
50 INV 0,X                        ;  9
60 SI Y(0)>192 ENT INV 0,Y        ; 24
```

### `ANI n,a,b,t`
Hace que el patrón del actor `n` cicle entre `a` y `b` cada `t` cuadros.

```
70 ANI 0,4,7,8                    ; 14
```

### `OCU n,v`
`v=1` oculta el actor, `v=0` lo muestra.

```
80 OCU 3,1                        ; 10
90 OCU 3,0                        ; 10
```

### `PAT n,p`
El actor `n` usa el patrón `p` en lugar de su patrón propio. Esencial
para tener varios actores con la misma imagen.

```
100 PAT 8,3                       ; 11
```

---

## 7. Mapas de tiles

### `MAPA n WxH` (definición)
Bloque de definición; ver §8.5 del plan.

### `MAP n,x,y`
Pinta el mapa `n` una vez en la posición indicada.

```
10 MAP 0,0,0                      ; 12
```

### `FON n`
Establece el mapa `n` como fondo (auto-renderizado cada cuadro).

```
20 FON 0                          ;  8
```

### `SOL m,t1[,t2,...]`
Declara qué tiles del mapa `m` son sólidos para colisión.

```
30 SOL 0,1,2                      ; 12
40 SOL 0,1,2,5,7                  ; 16
```

### `TIL(m,c,f)`
Función. Devuelve el índice de tile en columna `c`, fila `f` del mapa `m`.

```
50 SI TIL(0,5,8)=2 ENT IR 100     ; 29
```

> **No implementado todavía**: la asignación `TIL(0,5,8)=v` queda reservada
> para un hito futuro. La función read sí está disponible.

---

## 8. Paletas

### `PAL n`
Cambia la paleta activa. Toma efecto en el próximo cuadro.

```
10 PAL 1                          ;  8
```

> **No implementado todavía** como statement: el sistema multi-paleta vive
> al nivel del bank (`createPaletteBank`/`setActivePalette`/
> `setScanlinePalette`). El statement `PAL n LINEA|NIVEL` queda reservado.

---

## 9. Sonido

### `SONIDO n` ... `FIN` (definición)
Bloque dentro del archivo. Subcomandos:

| Subcomando      | Significado                                      |
|-----------------|--------------------------------------------------|
| `ONDA TRI/SIE/PUL/SEN` | Forma de onda                             |
| `PUL n`         | Ancho de pulso 0–15 (sólo si `ONDA PUL`)         |
| `ENV a,d,s,r`   | Envolvente ADSR (0–15 cada uno)                  |
| `NOTA <nota> <ticks>` | Toca una nota durante n ticks (1/60 s)     |
| `SIL <ticks>`   | Silencio durante n ticks                         |
| `FIN`           | Cierra la definición                             |

Ejemplo de definición:

```
SONIDO 0
ONDA PUL
PUL 8
ENV 1,2,8,4
NOTA DO5 4
NOTA SOL5 8
FIN
```

### `SON n,c`
Dispara el sonido `n` en el canal `c` (0..3).

```
10 SON 0,1                        ; 10
```

### `RUI n`
Dispara el sonido `n` en el canal de ruido (`R0`).

```
20 RUI 2                          ;  7
```

### `SIL c`
Silencia el canal `c` inmediatamente.

```
30 SIL 1                          ;  7
```

---

## 10. Entrada del jugador

### `BTN(b)`
1 si el botón `b` está presionado, 0 si no.

| Botón | Significado     |
|-------|-----------------|
| 0     | Izquierda       |
| 1     | Derecha         |
| 2     | Arriba          |
| 3     | Abajo           |
| 4     | A               |
| 5     | B               |
| 6     | INICIO          |
| 7     | SELECCIONAR     |

```
10 SI BTN(4) ENT SAL 0,5          ; 24
```

### `TEC(k)`
1 si la tecla con código `k` (ASCII mayúscula) está presionada.

```
20 SI TEC(32) ENT SAL 0,5         ; 25
```

---

## 11. Funciones de consulta de actores

| Función     | Devuelve                                            |
|-------------|-----------------------------------------------------|
| `X(n)`      | Posición x del actor                                |
| `Y(n)`      | Posición y del actor                                |
| `VX(n)`     | Velocidad x                                         |
| `VY(n)`     | Velocidad y                                         |
| `VIS(n)`    | 1 si visible, 0 si oculto                           |
| `PIE(n)`    | 1 si el actor pisa un tile sólido del mapa enlazado |
| `COL(s1,s2)`| 1 si dos actores se solapan (AABB)                  |
| `COLM(s,m)` | 1 si el actor `s` pisa tile sólido del mapa `m`     |
| `DIS(s1,s2)`| Distancia entre centros (entera)                    |

```
10 SI X(0)<0 ENT INV 0,X          ; 24
20 SI COL(0,1) ENT VID-=1         ; 24
30 SI PIE(0) Y BTN(4) ENT SAL 0,5 ; 32
40 A=DIS(0,1)                     ; 12
```

---

## 12. Funciones matemáticas

| Función       | Devuelve                                            |
|---------------|-----------------------------------------------------|
| `ALE(n)`      | Aleatorio en [0, n-1]                               |
| `ABS(x)`      | Valor absoluto                                      |
| `SGN(x)`      | -1, 0 ó 1 según el signo                            |
| `MIN(a,b)`    | Mínimo                                              |
| `MAX(a,b)`    | Máximo                                              |
| `RAI(x)`      | Raíz cuadrada entera                                |
| `SEN(g)`      | Seno de `g` grados, escala 1000                     |
| `COS(g)`      | Coseno de `g` grados, escala 1000                   |

```
10 A=ALE(100)                     ; 11
20 B=ABS(VX(0))                   ; 14
30 C=MIN(A,9)                     ; 12
40 D=SEN(45)                      ; 11
```

> **Nota sobre escala**: `SEN(45)` devuelve `707`, no `0.707`. Multiplicá
> tus magnitudes por `SEN(g)` y dividí por 1000 al final.

> **Determinismo de `ALE`**: el PRNG es xorshift32; el seed forma parte
> del estado del VM y se setea con `createVM(source, { seed })`. Mismo
> seed + misma secuencia de inputs = misma partida, cuadro a cuadro.
> Eso es lo que hace los tests de sistema reproducibles.

---

## 13. Físicas

### `GRA n,m,a`
Aplica gravedad `a` al actor `n` y resuelve colisión con el mapa `m`.
Se invoca una vez (típicamente en `INICIONIVEL`). El VM aplica la
aceleración cada cuadro automáticamente.

```
10 GRA 0,0,2                      ; 11
```

### `SAL n,f`
Aplica fuerza vertical de salto al actor `n`. Sin efecto si el actor no
está pisando suelo (`PIE(n)=0`).

```
20 SI BTN(4) ENT SAL 0,5          ; 24
```

### `LIM n,x1,y1,x2,y2`
Confina al actor `n` dentro del rectángulo `(x1,y1)-(x2,y2)`.

```
30 LIM 0,0,0,319,199              ; 20
```

---

## 14. Estado especial y ayudas

`VID`, `PUN`, `NIV`, `CUA`, `LIN` ya cubiertas en §4.

### `CARNIV n`
Carga el nivel `n` (dispara `CARGANIVEL` y luego `INICIONIVEL`).

```
10 SI PUN>=80 ENT CARNIV NIV+1    ; 29
```

### Comentarios

`;` inicia un comentario hasta el fin de línea. Las líneas que empiezan
con `;` no cuentan para el límite de 32 caracteres.

```
; este es un comentario completo
10 PIN 0,0,1     ; este también
```

---

## Apéndice: notas musicales reconocidas

Las notas se escriben en notación hispana: `DO RE MI FA SOL LA SI`,
seguidas de octava `0..7` y opcionalmente `#` o `b`.

Ejemplos válidos: `DO4`, `LA5`, `FA#3`, `SIb6`.

Reservado para silencios dentro de un sonido: `SIL <ticks>`.

---

## Apéndice: longitudes típicas

Como referencia, los siguientes patrones idiomáticos entran cómodos en
32 caracteres:

| Patrón                                  | Chars |
|-----------------------------------------|-------|
| `EN CUADRO IR 100`                      | 16    |
| `SI BTN(0) ENT VEL 0,-2,VY(0)`          | 29    |
| `SI COL(0,1) ENT LLA 400`               | 23    |
| `PAR I=0 A 31:OCU I,1:SIG`              | 25    |
| `MOV I,(I-7)*32,128`                    | 18    |
| `OCU I,1:PUN+=10:SON 1,3:RET`           | 28    |
| `SI X(0)<0 O X(0)>312 ENT 300`          | 29    |

Si estás luchando para entrar en 32, los recursos típicos son: usar
`+=`, mover lógica a una subrutina con `LLA`, o usar `INV n,EJE` en
lugar de invertir velocidades manualmente.
