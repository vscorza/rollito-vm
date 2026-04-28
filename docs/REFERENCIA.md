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

> **Convención**: cada handler (`CUADRO`, `INICIONIVEL`, etc.) y cada
> subrutina llamada con `LLA` **debe terminar con `RET` explícito**.
> El intérprete v2-A tolera fall-through al siguiente bloque por
> compatibilidad histórica, pero la transpilación a RVM-32 requiere
> RET explícito y los reference games del repo siguen esa convención.

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

### `SPRR n,x,y,ang,esc`
Dibujo del patrón `n` en `(x, y)` con **rotación** (`ang` 0..255 mapea
0..360°) y **escala** (`esc` 0..255, donde 64 = 1.0×). Nearest-neighbor
sampling — sin bilineal. El sprite rota alrededor del centro del bbox
destino.

- `ang=0` y `esc=64` equivale a `SPR n,x,y` (sin flip).
- Para una versión con HW affine, este opcode mapea a `BLIT_SPR_AFFINE`
  + 7 args MMIO (ver `docs/RVM32-ISA.md`).

```
10 SPRR 5,100,50,64,64            ; 90° escala 1x (20)
20 SPRR 5,100,50,0,128             ; sin rot, escala 2x (21)
30 SPRR 5,100,50,A,64              ; ang variable (19)
```

### `SPRA n,x,y,a`
Dibujo del patrón `n` en `(x, y)` con **alpha**. `a` es 0..15:
- `a = 0`: equivalente a `SPR n,x,y` (escribe directo, color 0
  transparente).
- `a > 0`: cada pixel no-transparente del patrón se mezcla con el FB
  vía `BLEND_TABLE[(src<<4)|dst]` (256 bytes en `vmRef.blendTable`,
  default = `(src+dst)/2`).

Útil para sombras, glow, fade y efectos retro. La tabla puede
sobreescribirse vía un MMIO futuro o cargada por el juego.

```
10 SPRA 5,100,50,0                ; sin blend (16)
20 SPRA 5,100,50,1                ; blend default (16)
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

### `MAP n,x,y[,a]`
Pinta el mapa `n` una vez en la posición indicada. El 4to argumento
opcional `a` (0..15) habilita alpha-blend sobre los tiles no-transparentes
usando la misma `BLEND_TABLE` que `SPRA` (default = `(src+dst)/2`).
`a=0` o ausente = pintado directo (sin blend).

```
10 MAP 0,0,0                      ; 12
20 MAP 1,T,16,4                   ; 14  ; parallax con fade
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
Cambia la paleta activa al banco `n` (0..3). Toma efecto en el próximo
blit. Las paletas se declaran en el header con `PALETA n` (§1) — `PAL`
sólo selecciona cuál está activa.

```
10 PAL 1                          ;  8
```

`n` fuera de [0,3] es ignorado silenciosamente (no rompe el juego).

> **Multi-banco scanline**: la variante `PAL n LINEA|NIVEL` (override
> por scanline) sigue reservada. El motor tiene `setScanlinePalette`
> en JS pero no hay statement v2-A todavía.

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

## 15. Acceso a memoria

RollitoVM expone su estado interno como un espacio plano de **512 KB**.
Las primitivas de esta sección permiten leer y escribir bytes en
cualquier región (sprites, mapas, paletas, framebuffer, scratch space).
Detalles del mapa completo en `PLAN.md` §18.

### 15.1. Mapa de regiones

| Offset    | Región    | Contenido                                          |
|-----------|-----------|----------------------------------------------------|
| `0x00000` | **CODE**  | Programa compilado (read-only en v1)               |
| `0x08000` | **STATE** | Vars, arrays M0..M7, actores, input                |
| `0x10000` | **SPR**   | 32 patrones × 1 KB stride                          |
| `0x18000` | **MAP**   | 4 mapas × 4 KB stride                              |
| `0x1C000` | **PAL**   | 4 paletas × 1 KB stride                            |
| `0x1D000` | **SON**   | 16 sonidos × 768 B stride (read-only en v1)        |
| `0x20000` | **FB**    | Framebuffer indexado (320×200)                     |
| `0x30000` | **FREE**  | 320 KB de scratch para tu juego                    |

Region IDs (para `LDR`/`STR`): `0=PAL, 1=SPR, 2=MAP, 3=SON`.

### 15.2. Acceso por dirección absoluta — `LDM`/`STM`

Las direcciones son enteros de 0 a `0x7FFFF` (19 bits = 512 KB).
Cualquier expresión entera vale; el dispatcher la enmascara y la
mapea a la región correspondiente.

#### `LDM(addr)` → byte
Lee 1 byte. Devuelve `0` para regiones no respaldadas (CODE).
```
20 A=LDM(0x10001)                 ; SPR[0][1] (17)
30 B=LDM(0x30000+I)               ; FREE[I]   (17)
```

#### `STM addr,val`
Escribe 1 byte. `val` se enmascara a 8 bits.
```
40 STM 0x20000,9                  ; FB[0]=9 (15)
```

### 15.3. Acceso por palabra — `LDW`/`STW` (32 bits)

Equivalentes a `LDM`/`STM` pero leen/escriben 4 bytes en
**little-endian**. Útil para sacar Int32 del estado o componer valores
sin shifts manuales.

```
20 STW 0x30000,0xCAFEBABE         ; 4 bytes en FREE (24)
30 A=LDW(0x30000)                 ; A = 0xCAFEBABE (19)
```

### 15.4. Acceso indexado — `LDR`/`STR`

Más cómodo que `LUI`+offset para leer un asset por (region, slot,
offset). No usa `adrHi`.

#### `LDR(region,slot,off)` → byte
```
10 A=LDR(1,2,0)                   ; SPR slot 2 byte 0 (17)
```

#### `STR region,slot,off,val`
Side effects por región:
- `STR 1,n,...` muta `pattern.pixels` del sprite n (recolor inmediato).
- `STR 2,n,...` muta una celda del mapa n y marca `dirty=true` para
  que `FON n` redibuje en el próximo cuadro.
- `STR 0,n,...` actualiza la LUT (offset 0..63 = 16 colores RGBA).
- `STR 3,n,...` muta `sonMem[n]` y marca el slot dirty; el próximo
  `SON n,c` re-deserializa el sonido desde los bytes (layout en
  PLAN.md §18.4).

```
20 STR $RSPR,1,9,4                ; sprite 1 px 9 = color 4 (22)
30 STR $RMAP,0,165,2               ; mapa 0 cell 165 = tile 2 (26)
40 STR $RSON,0,0,3                 ; sonido 0: cambiar onda a SEN (24)
```

### 15.5. Operaciones bulk — `MEMCPY`/`MEMSET`

Trabajan con direcciones absolutas. **No** combinan con `adrHi`.

#### `MEMSET dst,val,n`
Llena `n` bytes a partir de `dst` con `val`.
```
10 MEMSET 0x18000,0,240           ; clear MAPA 0 (24)
```

#### `MEMCPY src,dst,n`
Copia `n` bytes de `src` a `dst`. Maneja solapamiento dst > src.
```
20 MEMCPY 0x20000,0x30000,64000   ; FB → FREE (snapshot, 28)
```

### 15.6. Constantes simbólicas

El lexer resuelve `$NAME` a su literal numérico antes de parsear, así
que escribir `STM $FB_BASE,9` es idéntico a `STM 0x20000,9`. Los
nombres son case-insensitive.

| Nombre          | Valor      | Uso                              |
|-----------------|-----------:|----------------------------------|
| `$RPAL`         | `0`        | Region ID para `LDR`/`STR`       |
| `$RSPR`         | `1`        | "                                |
| `$RMAP`         | `2`        | "                                |
| `$RSON`         | `3`        | "                                |
| `$CODE_BASE`    | `0x00000`  | Inicio de CODE                   |
| `$STATE_BASE`   | `0x08000`  | Inicio de STATE                  |
| `$SPR_BASE`     | `0x10000`  | Inicio de SPR                    |
| `$MAP_BASE`     | `0x18000`  | Inicio de MAP                    |
| `$PAL_BASE`     | `0x1C000`  | Inicio de PAL                    |
| `$SON_BASE`     | `0x1D000`  | Inicio de SON                    |
| `$FB_BASE`      | `0x20000`  | Inicio del framebuffer           |
| `$FREE_BASE`    | `0x30000`  | Inicio de FREE                   |
| `$MEM_END`      | `0x80000`  | Tamaño total = 512 KB            |
| `$SPR_STRIDE`   | `0x400`    | Bytes entre slots de SPR         |
| `$MAP_STRIDE`   | `0x1000`   | "                                |
| `$PAL_STRIDE`   | `0x400`    | "                                |
| `$SON_STRIDE`   | `0x300`    | "                                |
| `$SPR_BYTES`    | `256`      | Bytes útiles por slot SPR        |
| `$PAL_BYTES`    | `64`       | Bytes útiles por slot PAL        |
| `$SON_BYTES`    | `768`      | Bytes útiles por slot SON        |
| `$FB_W`         | `320`      | Ancho del framebuffer            |
| `$FB_H`         | `200`      | Alto del framebuffer             |

```
10 STR $RSPR,1,9,4                ; sprite 1 px 9 = color 4 (22)
20 MEMSET $MAP_BASE,0,240         ; clear MAPA 0     (24)
```

### 15.7. Magic registers (memory-mapped IO)

Direcciones dentro de STATE donde un `STW` dispara una acción del
runtime en vez de escribir bytes. Útil para empaquetar comandos como
integers.

| Constante      | Dirección  | Acción al `STW val`                              |
|----------------|-----------:|--------------------------------------------------|
| `$MR_SILENCE`  | `0x0B000`  | Silencia el canal `val & 0xff`                   |
| `$MR_PLAY`     | `0x0B004`  | `playSound(val & 0xf, (val>>4) & 0xf)`           |
| `$MR_NOISE`    | `0x0B008`  | `playNoise(val & 0xf)`                           |
| `$MR_CARNIV`   | `0x0B00C`  | Equivale a `CARNIV val` (cambia NIV)             |
| `$MR_REPAINT`  | `0x0B010`  | Marca el fondo activo dirty                      |

```
10 STW $MR_CARNIV,2               ; saltar a NIV 2 (17)
20 STW $MR_PLAY,16                ; sonido 0 en canal 1 (val=0x10) (19)
30 STW $MR_REPAINT,0              ; refrescar fondo (18)
```

Reglas:
- Sólo `STW` (32 bits) dispara la acción.
- `STM` byte-a-byte en este rango es no-op silente.
- Lectura (`LDM`/`LDW`) en este rango devuelve siempre `0`.

### 15.8. Casos borde

- Region/slot/offset fuera de rango → no-op silente (lecturas devuelven
  `0`).
- Direcciones negativas o ≥ `0x80000` → no-op silente.
- Escribir a CODE: muta los bytes del bytecode emitido (v2-A/v2-B).
- Las paletas ocupan 64 bytes útiles (16 colores × 4 bytes RGBA),
  aunque el stride sea 1024 — escribir más allá del byte 63 dentro de
  un slot no afecta colores.

### 15.9. Ejemplos completos

**Recolorar un sprite por nivel** (de `games/camaleon.retro`):
```
700 PAR I=0 A 63
705 SI LDR($RSPR,1,I)<>9 ENT 715
710 STR $RSPR,1,I,9+NIV
715 SIG
720 RET
```

**Construir un piso completo en el mapa**:
```
750 MEMSET $MAP_BASE,0,240
755 PAR I=0 A 19:STR $RMAP,0,220+I,2:SIG
760 RET
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
