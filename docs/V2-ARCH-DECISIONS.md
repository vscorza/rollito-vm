# V2 architectural decisions — RVM-32 antes del silicio

Documento de decisiones arquitecturales pendientes para la ISA RVM-32
y los coprocesadores. El **transpiler v2-A → RVM-32 actual** funciona
end-to-end (9/9 juegos cosim contra el intérprete v2-A), pero varias
operaciones están ruteadas por MMIO como atajo de implementación
JS. Antes de bajar el RTL, hay que decidir cuáles merecen ser
operaciones primitivas del CPU/coprocesadores y cuáles deben quedar
como software o MMIO.

> El criterio para cada decisión: **costo en LUTs/BRAM/DSPs vs
> ganancia en densidad de ROM y perf por cuadro**, asumiendo target
> ECP5 LFE5U-25F (24K LUTs, 56 BRAM 18 Kbit, 28 DSP).

---

## 1. Costo baseline del bus MMIO

Antes de comparar, el costo de "rutear via MMIO" (estado actual):

```
Setup: SW val a MMIO_ARG[i] (i = 0..N-1)
Trigger: SW cmd a MMIO_CMD
Read result (queries): LW MMIO_RESULT
```

Cada `SW MMIO_ARGi, val` requiere:
- Cargar la dirección MMIO en R8: 1-4 instr (LUI + ORI o variantes).
- `SW Rsrc, R8, 0`: 1 instr.

`loadImm32(R8, MMIO_ARG0)` actualmente emite **3 instrucciones** (LUI +
ORI con sign-correction). Con peephole "addr base + offset" sería 1
instrucción (mantener R8 fijo en MMIO_ARG0).

**Costo MMIO típico hoy** (sin peepholes):
- 1 arg: ~5 instr (load addr, SW arg, load CMD addr, load CMD code, SW)
- 3 args: ~13 instr
- 5 args + result: ~20 instr

**Con peephole** (mantener R8 = MMIO_ARG0 en función):
- 1 arg: ~3 instr
- 3 args: ~7 instr
- 5 args + result: ~12 instr

Las decisiones de abajo asumen el costo CON peephole, porque ese es el
target de optimización inmediata. **Las refactorizaciones que reducen
una operación a 1-3 instr nativas representan una ganancia real**.

---

## 2. DIV / MOD

### Estado actual

`Q_DIV` y `Q_MOD` como comandos MMIO. El handler JS hace `(a/b)|0` y
`a%b`. En v2-A bytecode estos opcodes son frecuentes (tetris hace
divisiones para HUD, camaleon para coordenadas, espacial para
posiciones de estrellas).

### Opciones para silicio

**A) Hardware divider en el CPU (RV32M-style).**
- Implementación: divisor non-restoring 32-bit signed/unsigned. ~32
  ciclos por operación, multi-cycle (CPU stalls hasta que termina).
- LUT cost en ECP5: ~1500-2000 LUTs.
- Add 2 opcodes: `DIV rd,rs1,rs2`, `REM rd,rs1,rs2` (más `DIVU`/`REMU`
  para sin signo, opcional).
- Per-call: 1 instrucción + 32 ciclos.

**B) Software helper en libc (RVM-32 ROM).**
- Rutina shift-and-subtract en ASM, ~30 instrucciones.
- LUT cost: 0 (es código).
- ROM cost: ~120 bytes en ROM compartido por todos los juegos.
- Per-call: `JAL` + ~32 ciclos en software.

**C) Mantener via MMIO al divisor del coprocesador GPU/AUX.**
- El "divisor" vive en un coprocesador, accedido por MMIO.
- LUT cost: ~1500 LUTs en el bloque GPU/AUX (mismo que A).
- Per-call: ~10-15 instrucciones (ARG setup + CMD + RESULT).
- **Descartar**: peor en latency y densidad que A, sin beneficio.

### Tradeoffs

| Aspecto             | A: HW divider | B: SW helper |
|---------------------|---------------|--------------|
| LUTs                | +1500         | 0            |
| Per-op (cycles)     | 32            | ~32+overhead |
| ROM por juego       | 0             | 0 (compartido)|
| ROM total libc      | 0             | +120 B       |
| ISA cleanliness     | RV32M familiar| 1 op = JAL   |
| Migrabilidad RV32M  | ✓ si copiamos | -            |

### Recomendación

**A: HW divider**. Razones:
- 1500 LUTs es ~6% del budget de ECP5 25F. Vale la pena.
- DIV/MOD aparecen en hot paths (HUD, coords). Reducir 30+ instr a 1
  instr ahorra mucha densidad de ROM.
- Mantenerlo CPU-side significa que el dispatch MMIO es opcional.
- RV32M es familiar para devs RISC-V. Facilita futura migración.

Encoding: agregar opcodes 0x29 (`DIV`), 0x2A (`REM`) tipo R. Operands
señalados; unsigned se difiere a v2.

---

## 3. CALL / RET

### Estado actual

```
CALL target:
  ADDI R14, R14, -4
  SW R15, R14, 0
  JAL R15, target
  LW R15, R14, 0
  ADDI R14, R14, 4
RET:
  JR R15
```

5 instrucciones por CALL, 1 por RET. **El caller** guarda el link
register en stack antes del JAL. Razón: callee podría hacer otro JAL
que clobbearía R15.

### Opciones

**A) Mantener "caller-saves-link" actual.**
- 5 instr/CALL, 1 instr/RET.
- Cualquier callee puede ser hoja o recursivo sin cambios.

**B) Convención RISC estándar "callee-saves-link".**
- CALL emite sólo `JAL R15, target` (1 instr).
- RET emite `JR R15` (1 instr).
- **El callee** guarda R15 en stack al entry SI hace algún CALL anidado.
  Hojas (no-call leaves) no pagan nada.
- Densidad: 1 instr/CALL × N caller-sites + 2 instr (push+pop R15) × M
  callee-functions-que-llaman ≪ 5N en cualquier programa real.
- **Cambio**: el transpiler emite la secuencia push/pop al **entry de
  la función**, no en cada call-site. Necesita identificar funciones
  con calls anidados.

**C) Hardware return-address stack (RAS).**
- Stack interno de 16 entries en hardware.
- CALL pushea PC+4 al RAS. RET popea.
- LUT cost: ~150 LUTs.
- Per-call: 1 instr / 1 instr.
- **Pero**: complicación con interrupts (¿qué pasa con el RAS si
  llega un interrupt?).

### Tradeoffs

| Aspecto           | A: caller-saves | B: callee-saves | C: HW RAS    |
|-------------------|-----------------|-----------------|--------------|
| Instr/CALL        | 5               | 1               | 1            |
| Instr/RET         | 1               | 1 (+pop entry)  | 1            |
| Análisis transp.  | trivial         | requiere CFG    | trivial      |
| LUTs              | 0               | 0               | +150         |
| ROM density tetris| baseline        | -3% (~50 instr) | -3%          |
| Compatible RV32   | semi-           | ✓               | extensión    |

Para tetris (~5800 RVM-32 words actual), pasar a B reduce el binario
en ~3% por la cantidad de LLA que tiene. Para programas con más
calls (saltarin, mario-mini) sería ~5%.

### Recomendación

**B: callee-saves-link**. Razones:
- Misma convención que RV32. Devs no se sorprenden.
- Densidad clara (3-5% en juegos reales).
- No requiere LUT extra.
- El transpiler debe hacer un análisis simple: "esta función contiene
  un CALL? entonces emitir push R15 al entry y pop al exit". O sea,
  marcar cada handler/función como `is_leaf` durante emit.

Costo de implementación: ~50 líneas en `v2a-to-rvm32.js`.

---

## 4. PARINIT / PARSIG

### Estado actual

`PARINIT` ~9 instr nativas, `PARSIG` ~12 instr. Loop frame de 16
bytes en FREE+0x30000. R6 = loop SP. JAL+ADDI computa body PC.

Para un loop apretado de 10 iteraciones con cuerpo de 5 instr:
- Setup (PARINIT): 9 instr × 1 = 9
- Cuerpo: 5 instr × 10 = 50
- SIG (PARSIG): 12 instr × 10 = 120
- **Total: 179 instr** para un loop trivial.

Por comparación, un loop equivalente en RV32 sin hardware loop:
- Setup: 2-3 instr (cargar bound, var)
- Cuerpo: 5 instr
- Final (BNE): 1 instr
- **Total: ~85 instr** para 10 iters.

Estamos pagando ~2× por PAR/SIG.

### Opciones

**A) Mantener implementación actual.**
- Sin cambios HW.
- Loops "caros" pero implementados.

**B) Inline opcoding mejor en transpiler.**
- En vez de loop-frame en memoria, mantener loop var/bound/body_pc en
  registros (R10 = bound actual, R9 = body PC actual).
- Hace falta saber profundidad max al compilar (max 8 frames anidados).
- **Densidad**: PARINIT ~5 instr, PARSIG ~6 instr. Loops "casi" tan
  rápidos como mano.
- **Limitación**: si se permiten anidamientos arbitrarios, hace falta
  spill a stack. Pero v2-A limita a 8.

**C) Hardware loop unit.**
- Registro de "loop" con (var_idx, bound, body_pc, depth).
- Instrucciones `LOOP_INIT rd, body_addr, count` y `LOOP_END`.
- LUT cost: ~600 LUTs.
- Loops con cuerpo pequeño se ejecutan en cuerpo + 0 cycles overhead
  (zero-overhead loop).
- **Pero**: complejidad arquitectónica grande para v1.

### Tradeoffs

| Aspecto           | A: actual | B: inline regs | C: HW loop unit |
|-------------------|-----------|----------------|-----------------|
| Instr/PARINIT     | 9         | 5              | 1               |
| Instr/PARSIG      | 12        | 6              | 0 (zero-overhead)|
| Memoria loop stack| 128 B FREE| en regs        | en HW state     |
| LUTs              | 0         | 0              | +600            |
| Profundidad max   | 8         | 8 (regs disponibles) | 4-8 (HW)|
| Densidad ROM      | baseline  | -50% del overhead | -90%        |

### Recomendación

**B: inline en registros**. Razones:
- Mitad del overhead sin costo HW.
- Mantiene profundidad 8 (suficiente para todos los juegos del repo).
- HW loop unit (C) es mejor pero complejo; lo dejamos para v3.

Implementación: usar R8..R10 para top-of-stack del loop frame. Spill
los frames más viejos a memoria sólo cuando profundidad > 1. La
mayoría de los loops son no-anidados.

Costo de implementación: ~80 líneas en `v2a-to-rvm32.js`.

---

## 5. LDR / STR (region+slot+offset)

### Estado actual

`LDR(region, slot, offset)` y `STR(region, slot, offset, val)` ruteados
por MMIO. El dispatch JS llama `readByteIndexed`/`writeByteIndexed`
que hacen el switch por región (PAL/SPR/MAP/SON) y calculan la
dirección.

### Opciones

**A) Mantener via MMIO.**
- Per-call: ~10-15 instr (3-4 args + CMD + opt RESULT).
- Side-effects (PAL LUT recompute, MAP dirty, SON dirty) ya manejados
  por los helpers.

**B) Compilar a LB/SB nativo precomputando dirección.**
- En transpiler: `addr = base[region] + slot * stride[region] + offset`.
- Necesita una pequeña tabla de bases/strides en ROM (32 bytes).
- ~5 instr para computar addr + 1 LB/SB = 6 instr.
- **Pero**: side-effects (dirty flags, LUT recompute) deberían
  dispararse en el HW (la GPU detecta writes a SPR/MAP/PAL y marca
  dirty). Eso ya está en el plan de la GPU.

**C) Compilar la región como literal cuando es constante.**
- `STR $RSPR, 1, 9, 4` con region constante 1 → emit directamente
  `addr = SPR_BASE + 1*1024 + 9 = 0x10009`, después `SB R1, addr`.
- **El 95% de los `STR/LDR` en los juegos del repo usan region como
  literal** (constante simbólica `$RSPR`/`$RMAP`/...). Optimización
  trivial en peephole.
- Per-call (region constante): ~3 instr.
- Per-call (region dinámica): fallback a B o A.

### Tradeoffs

| Aspecto              | A: MMIO | B: SW addr | C: peephole + B |
|----------------------|---------|------------|-----------------|
| Instr/LDR (region const) | 12   | 6          | 3               |
| Instr/STR (region const) | 13   | 7          | 4               |
| LUTs                 | 0       | 0          | 0               |
| Side-effect handling | en JS   | en HW (GPU) | en HW          |
| Ortogonalidad ISA    | -       | ✓          | ✓               |

### Recomendación

**C: peephole con literal de región + B como fallback**. Razones:
- 95% de los usos son literales — caso común optimizado.
- HW maneja side-effects (cualquier write a SPR address marca dirty
  el sprite si la GPU está conectada al bus correctamente).
- LDR/STR via MMIO se vuelve un fallback raro.

Costo de implementación: ~100 líneas en transpiler (peephole para
region constante).

---

## 6. MEMCPY / MEMSET

### Estado actual

`MEMCPY src,dst,n` y `MEMSET dst,val,n` via MMIO. El handler JS hace
el bucle.

### Opciones

**A) Software loop (RVM-32 helper).**
- ~10 instr setup + 3 instr/byte (LB+SB+ADDI loop) = ~3n+10 ciclos.
- ROM: ~30 instr en libc.
- Per-call: JAL + bucle.

**B) DMA engine en el bus.**
- Bloque dedicado: lee src, escribe dst, decrementa n.
- LUT cost: ~500 LUTs.
- 1 byte/ciclo (o más si ancho del bus permite burst).
- Per-call: 3 SW (src, dst, n) + 1 SW DMA_GO + 1 LW DMA_DONE = 5 SW + 1 LW.
- **Bonus**: la CPU puede seguir trabajando mientras DMA corre (si la
  cola de comandos lo permite).

**C) MMIO actual.**
- Mismo modelo que B pero handler en JS. En silicio, el "handler"
  sería el DMA engine.

### Tradeoffs

| Aspecto              | A: SW loop | B: DMA HW | C: MMIO actual |
|----------------------|------------|-----------|----------------|
| LUTs                 | 0          | +500      | (= B en HW)    |
| Per-byte cycles      | 3          | 1         | 1              |
| Per-call overhead    | ~10 instr  | ~7 instr  | ~7 instr       |
| Concurrencia CPU     | bloqueada  | libre     | libre          |
| Tetris row clear (240 B) | 730 cycles | 240 cycles | 240 cycles |

### Recomendación

**B: DMA engine + MMIO** (lo que ya está, pero con engine HW real).

Razones:
- Tetris/camaleon hacen MEMCPY/MEMSET en cada line clear / cada
  reset de mapa. 240 bytes × 60 fps = 14400 bytes/s. Con SW loop
  son ~44K ciclos/segundo. Con DMA, 14K ciclos/s. Cycles
  ahorrados aplican a otra cosa.
- 500 LUTs es 2% del budget. Buen ROI.
- La MMIO API actual es exactamente la que va a usar el DMA: setup
  ARGn + GPU_CMD = MEMCPY. Cero cambios en transpiler.

**No-cambio para v1**: el plan ya cubre esto. Lo notamos para que sea
explícito que el RTL de la "GPU" incluye un DMA simple.

---

## 7. Queries de actor (X, Y, VX, VY, VIS)

### Estado actual

Todas via MMIO. Per-query: ~5 instr (1 SW arg + 1 SW CMD + 1 LW
RESULT, con ~2 instr de loadImm para direcciones).

### Análisis

Los actores viven en STATE BRAM en `STATE_BASE + 0x2080 + n*32`
(32 bytes/actor = 16 fields × 2 bytes Int16). Los offsets de cada
field son constantes:
- F_X = 0, F_Y = 1, F_VX = 2, F_VY = 3, F_FLAGS = 4 (en *words de 16
  bits*).

Una query como `X(n)` se puede emitir como:
```
LW R3, R12, ACTORS_BASE_OFFSET   ; R3 = STATE_BASE + 0x2080 (constante)
SHL R1, R1, 5                    ; R1 = n*32 (32 bytes/actor)
ADD R3, R3, R1                   ; R3 = base del actor n
LB R4, R3, 0                     ; R4 = byte 0 = F_X low byte
LB R5, R3, 1                     ; R5 = F_X high byte
... combinar
```

Hmm, F_X es Int16. Necesita lectura de 2 bytes con sign-extend. Eso
es 2 instr (LBU + LB con shift, o LH si lo agregamos).

### Opciones

**A) Mantener via MMIO.**
- 5 instr/query. Hot path.

**B) Emit LH/LHU en transpiler (necesita LH/LHU como opcodes nuevos).**
- Agregar `LH rd, rs, imm` (load halfword signed) y `LHU` (unsigned).
- Per-query (con base preconfigurada en R10): ~3 instr.
- LUT cost: trivial (multiplexor de 2 bytes en datapath).

**C) Memory-mapped actor "shadow" registers.**
- Bloque MMIO con 32 actors × 5 fields-de-uso-frecuente = 160 registros
  de lectura directa.
- Per-query: 1 LW + 1 ADDI loadImm = 2 instr.
- LUT cost: ~300 LUTs (shadow latch + dispatch).

**D) Direct LW + cargo bit-extraction.**
- Las queries son por ACTOR_FIELDS (Int16). El word de 32 bits
  contiene 2 fields. Leer LW del par y extraer es 1 LW + 1 SHR/AND.
- Per-query: ~3 instr.
- Sin cambios HW (todos los opcodes necesarios ya existen).

### Tradeoffs

| Aspecto           | A: MMIO | B: LH opcodes | C: shadow regs | D: LW + extract |
|-------------------|---------|---------------|----------------|-----------------|
| Instr/query       | 5       | 3             | 2              | 3               |
| LUTs              | 0       | +50           | +300           | 0               |
| Sin nuevos opcodes| ✓       | -             | ✓              | ✓               |
| Casos cubiertos   | todos   | todos         | sólo "hot"     | todos           |

### Recomendación

**D: LW + bit-extract**. Razones:
- Mismas instrucciones existentes (LW + SHR + AND + sign-extend).
- 3 instr/query, ~40% mejor que MMIO.
- Sin cambios HW.
- Aplica a TODAS las queries que leen state direct, no sólo X/Y.

Costo de implementación: ~80 líneas en transpiler. Tabla de offsets
por field name.

---

## 8. MIN / MAX / ABS / SGN / NEG

### Estado actual

Las primeras 4 via MMIO Q_MIN/Q_MAX/Q_ABS/Q_SGN. NEG via opcode
RVM-32 nativo (SUB R, R0, R).

Per-query: ~5 instr.

### Análisis

Equivalentes RISC nativos (sin nuevos opcodes):

```
ABS x:    SAR R2, R1, 31      ; R2 = sign bit (0 or -1)
          XOR R1, R1, R2      ; R1 = x ^ sign
          SUB R1, R1, R2      ; R1 = abs(x)
          → 3 instr.

SGN x:    SAR R2, R1, 31      ; R2 = -1 si negative, 0 si zero/positive
          BEQ R1, R0, +2      ; si zero, R1=0
          ORI R1, R0, 1       ; default 1
          OR R1, R1, R2       ; si negative, OR -1 = -1
          → ~5 instr (con branch).

MIN(a,b): BLT a, b, +2        ; si a<b, salta
          ADD R1, R0, b       ; else b
          ADD R1, R0, a       ; (en target, salta acá)
          → 3 instr (con branch).

MAX:      similar.
```

Todos ≤ 5 instr nativos sin nuevos opcodes. Igual o mejor que MMIO.

### Opciones

**A) Mantener via MMIO.** 5 instr/op.
**B) Emit la secuencia nativa inline.** 3-5 instr/op.

### Tradeoffs

Casi idénticos. B es marginalmente mejor (3 instr para ABS y MIN/MAX),
sin LUT cost. Y elimina dependencia del bus MMIO para math básica.

### Recomendación

**B: emit nativo inline**. Razones:
- Densidad ligeramente mejor.
- Independiente de la GPU/MMIO.
- Más legible en el binario disassembled.

Costo de implementación: ~40 líneas en transpiler.

---

## 9. SEN / COS / RAI

### Estado actual

Via MMIO con `Math.sin/cos/sqrt` JS. Per-call: ~5 instr + JS Math.

### Análisis

`SEN(x)` retorna `sin(x*PI/180)*1000` redondeado a int. RVM-32 puro
necesitaría:
- LUT en ROM (256 entradas × Int16 = 512 bytes) indexada por ángulo
  0..255.
- `RAI(x)` (sqrt) similar pero con tabla más chica + interpolación.

Las LUTs caben en una BRAM (1 BRAM = 2 KB). El acceso es 1 LH
indexado.

### Opciones

**A) Mantener via MMIO.** Math nativo del JS, costo trivial en JS.
**B) ROM LUT en memoria + helper en libc.**
- LUT bake-time. Per-call: `LUI R, lut_base` + `ADD R, R, x` + `LH R, R`.
- ~3 instr.
- ROM: 1 KB compartido (SEN+COS comparten LUT).

**C) HW trig unit con CORDIC.**
- Bloque dedicado, multi-cycle.
- LUT cost: ~1000 LUTs.
- **Overkill** para v1. SEN/COS no son hot path en juegos.

### Tradeoffs

| Aspecto       | A: MMIO+JS | B: LUT+SW | C: CORDIC HW |
|---------------|------------|-----------|--------------|
| Instr/call    | 5          | 3         | 1            |
| LUTs          | 0          | 0         | +1000        |
| BRAM          | 0          | 1         | 0            |
| ROM           | 0          | 1 KB      | 0            |
| RTL portable  | -          | ✓         | ✓            |

### Recomendación

**B: LUT en ROM**. Razones:
- 1 BRAM no es mucho del budget.
- Independiente del coprocesador GPU.
- 3 instr es densidad RISC clásica.

Para `RAI` (sqrt): similar, LUT de 256 entradas con interpolación
opcional. O directamente formula iterativa Newton-Raphson en SW
(~10 instr).

Costo de implementación: 50 líneas transpiler + tabla precomputada
en runtime/libc.

---

## 10. ALE (RNG)

### Estado actual

Via MMIO Q_ALE. Llama `nextRandom(state)` que avanza state.seed con
xorshift32 y devuelve `seed % n`.

Per-call: ~5 instr.

### Opciones

**A) Mantener via MMIO.**
**B) Hardware RNG register.**
- Registro `$RNG` en MMIO 0x0B300 (ya documentado en RVM32-ISA.md §6).
- Cada `LW $RNG` retorna el siguiente valor xorshift32 y avanza el
  seed interno.
- Per-call: 2 instr (LW + opcional MOD por n).
- LUT cost: ~80 LUTs (registro de 32 bits + 3 XOR shifts del xorshift32).

**C) Software helper en libc.**
- Mantener seed en variable de la STATE region; emitir helper en libc
  que avanza.
- Per-call: JAL + ~4 instr en libc.
- ROM: ~30 instr.

### Tradeoffs

| Aspecto            | A: MMIO | B: HW reg | C: SW |
|--------------------|---------|-----------|-------|
| Instr/call         | 5       | 2         | 4-5   |
| LUTs               | 0       | +80       | 0     |
| Reproducibilidad   | ✓       | ✓ con seed | ✓    |
| Determinismo cosim | ✓       | ✓         | ✓     |

### Recomendación

**B: HW register**. Razones:
- 80 LUTs es nada.
- 2 instr/call es casi free.
- Hace explícito que el RNG es un periférico (mejor para debugging).
- `STW $RNG_SEED, val` para seed determinístico en tests.

Costo de implementación: 30 líneas transpiler + RTL del registro
xorshift32.

---

## 11. BTN / TEC

### Estado actual

Via MMIO Q_BTN/Q_TEC. Per-call: ~5 instr.

### Análisis

Los buttons (`vmRef.inputState.buttons`) viven en STATE region a
offset 0x2560. Las keys (`vmRef.inputState.keys`) en 0x2568. Cada
button es 1 byte (0/1), cada key igual.

`BTN(b)` se puede emitir como:
```
LBU R1, R12, BTN_BASE_OFFSET + b   ; R12 = STATE_BASE; offset constante si b es literal
```
1 instrucción si `b` es literal. ~3 si es variable (load b, ADD,
LBU).

### Opciones

**A) MMIO.** 5 instr.
**B) Emit LBU directo.** 1-3 instr.

### Recomendación

**B: LBU directo**. La mejora es trivial. ~30 líneas en transpiler.

---

## 12. Resumen de decisiones + roadmap

| Ítem                | Decisión                                     | Estado              | Implementación      |
|---------------------|----------------------------------------------|---------------------|---------------------|
| DIV/MOD             | Opcodes nativos `DIV`/`REM` + `DIVU`/`REMU`  | ✅ implementado     | ISA + interpreter + transpiler |
| CALL/RET            | Callee-saves-link estándar                   | ✅ implementado     | CFG analysis en transpiler |
| PARINIT/PARSIG      | Inline en regs (top frame en R8..R10)        | ⏸ deferido a v3     | mantiene memory-based |
| LDR/STR             | Peephole con region literal                  | ⏸ deferido (tracking de stack) | usa MMIO actual |
| MEMCPY/MEMSET       | DMA engine en el bus (HW)                    | ⏸ futuro RTL        | usa MMIO actual     |
| Queries actor       | LW + bit-extract directo                     | ✅ implementado     | peephole con LDI literal |
| MIN/MAX/ABS/SGN     | Inline nativo                                | ✅ implementado     | transpiler emite secuencia RISC |
| SEN/COS/RAI         | LUT en ROM + helper en libc                  | ✅ SEN/COS via LUT  | trigLut en STATE+0x2700; RAI via MMIO todavía |
| ALE                 | HW RNG register `$RNG`                       | ✅ implementado     | LW $RNG (0xB300) + REMU |
| BTN/TEC             | LBU directo                                  | ✅ implementado     | peephole con LDI literal |

### Density real (post-refactor v1)

| Juego      | Pre-refactor | Post-refactor | Δ      |
|------------|-------------:|---------------:|-------:|
| pelota     | 298          | 230            | -23%   |
| pong       | 1424         | 1208           | -15%   |
| saltarin   | 838          | 738            | -12%   |
| memoria    | 1795         | 1653           | -8%    |
| serpiente  | 1790         | 1623           | -9%    |
| camaleon   | 1496         | 1374           | -8%    |
| mario-mini | 1826         | 1684           | -8%    |
| tetris     | 5859         | 5347           | -9%    |
| espacial   | 2436         | 2164           | -11%   |

Promedio: **-12% ROM density**. La mayor parte del ahorro viene de
CALL/RET callee-saves (1 instr/CALL en vez de 5) y los peepholes de
queries 1-arg.

### Trabajo de v2-A para conformidad de calling convention

`serpiente.retro` se modificó: la línea 99 pasó de `LLA 800` a
`LLA 800:RET` para que el handler INICIOJUEGO termine explícitamente.
Sin esa modificación, INICIOJUEGO caía-fall-through al body de CUADRO,
re-disparando el prologue de CUADRO y desbalanceando el call stack.

La convención fijada: **todo handler v2-A debe terminar con `RET`
explícito**. El compilador v2-A no lo emite automáticamente; los juegos
que dependan de fall-through (legado) hay que migrarlos.

**Impacto total estimado** (juego típico ~5K instr RVM-32):
- ROM density: -15% a -25% (depende del juego).
- LUT cost: +2080 (~9% del budget de ECP5 25F).
- BRAM: +1 (trig LUT).
- DSP: 0 cambios (MUL ya cuenta 1).

**Refactorizaciones obvias** (sólo transpiler, sin HW):
1. CALL/RET callee-saves
2. PAR/SIG inline regs
3. LDR/STR peephole literal
4. Queries actor LW directo
5. MIN/MAX/ABS/SGN inline
6. BTN/TEC LBU directo

Estas 6 son **sólo cambios en `v2a-to-rvm32.js`**, sin cambios HW ni
ISA. Se pueden hacer en este sprint.

**Decisiones HW pendientes** (afectan RTL):
1. HW divider (DIV/REM opcodes)
2. DMA engine
3. Trig LUT en ROM
4. RNG register `$RNG`

Estas requieren decisiones de arquitectura del RTL antes de empezar
a escribir Verilog. Son las que **deberían quedar fijas en este
documento ANTES** del sprint RTL.

---

## 13. Lo que no entra acá

- **Audio coprocessor** (synth: 4 osc + ruido + ADSR + I2S) ya está
  decidido en RTL-PLAN.md §5 fase 5. Sin cambios.
- **GPU** (sprite blitter + maps + REC/PIN/BOR + scan-out) ya decidido.
- **Magic registers v2-E** ya decididos y operando.
- **Memory map de 512 KB** ya decidido.
- **Encoding de instrucción de 32 bits** ya decidido (RVM-32 ISA §2).

---

## 14. Próximos pasos

Si el plan se acepta:

1. **Sprint refactor** (sin HW): aplicar las 6 refactorizaciones obvias.
   - Tests cosim deben seguir pasando con identidad byte-a-byte.
   - Ganancia esperada: -15% ROM density.
2. **Decidir HW divider** (sí/no): dimensiona el chip.
3. **Decidir DMA**: sí/no (probablemente sí).
4. **Decidir trig LUT en ROM**: sí/no (probablemente sí; 1 BRAM).
5. **Decidir RNG register**: sí/no (sí, es trivial).
6. **Actualizar RVM32-ISA.md** con los nuevos opcodes y helpers.
7. **Empezar RTL.1** del plan ya existente.
