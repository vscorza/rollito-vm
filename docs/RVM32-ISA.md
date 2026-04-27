# RVM-32 ISA — RISC interno de RollitoVM

Esta es la spec del **núcleo RISC ficticio** sobre el cual se ejecuta
RollitoVM cuando el bytecode v2-A se transpila a código nativo.
Vive como referencia para futura implementación en silicio (FPGA
ECP5 25F objetivo).

> **Estado**: ISA + intérprete + transpilador parcial implementados en
> JS como golden reference. RTL en Verilog: trabajo posterior. Ver
> [PLAN.md §19](PLAN.md).

---

## 1. Filosofía

RollitoVM v2-A tiene 87 opcodes, muchos de ellos de alto nivel
(`SPR`, `MAP_`, `FON`, `COL`, `SON`, `TXT`...) que internamente llaman
helpers complejos: rasterización, blit de mapas, AABB, audio synth.
Llevar eso directo a silicio sería un chip enorme.

RVM-32 hace lo opuesto: la CPU es un RISC clásico mínimo (~26
opcodes) con todo el "work pesado" delegado a coprocesadores
accesibles por **memory-mapped IO**. Cada opcode v2-A se transpila
a una secuencia de instrucciones RVM-32 + writes a MMIO.

## 2. Encoding

**32 bits fijos** por instrucción. Opcode en el byte bajo (matching
v2-A para facilitar debug/inspección).

```
R-type (3 registros):
   31      20 19  16 15  12 11   8 7    0
   |  func   |  rs2 |  rs1 |  rd  |  op  |

I-type (registro + inmediato 16-bit signed):
   31              16 15  12 11   8 7    0
   |     imm16       |  rs1 |  rd  |  op  |

J-type (jump con inmediato 20-bit signed PC-relative):
   31                  12 11   8 7    0
   |       imm20         |  rd  |  op  |
```

- **rd, rs1, rs2**: 4 bits cada uno → 16 registros (R0..R15).
- **func**: 12 bits para sub-opcode en R-type (no usado en v1).
- **imm16**: signed -32768..32767 (también para `BEQ/BNE/BLT/BGE`,
  con offset en *words* — ver §3).
- **imm20**: signed -524288..524287 (PC-relative offset en words).

> **R0 = zero**: lecturas devuelven 0, escrituras silentemente
> ignoradas. Convención RISC clásica.

> **R15 = link**: lo carga `JAL` con `PC + 4`.

## 3. Modelo de ejecución

- **Memoria byte-addressable de 512 KB**, idéntica al memory map
  v2-A ([PLAN.md §18](PLAN.md)). Mismo layout: CODE, STATE, SPR,
  MAP, PAL, SON, FB, FREE.
- **Magic registers v2-E** ([REFERENCIA §15.7](REFERENCIA.md))
  funcionan igual: `STW $MR_PLAY,val` dispara `playSound`.
- **PC** byte-aligned a 4. Cada instrucción ocupa 4 bytes.
- **Branches**: `nextPc = pc + imm16 * 4`. `imm16=0` es loop a sí
  mismo, `imm16=1` es la siguiente instrucción (no-op), `imm16=2`
  salta una.
- **Jumps**: idéntico, con imm20.

## 4. Set de instrucciones

| Mnemónico        | Tipo | Op   | Semántica                                |
|------------------|------|------|------------------------------------------|
| `NOP`            | -    | 0x00 | No-op                                    |
| `HLT`            | -    | 0x01 | Detiene CPU                              |
| `LB rd,rs1,imm`  | I    | 0x10 | rd ← sext(mem8[rs1+imm])                  |
| `LBU rd,rs1,imm` | I    | 0x11 | rd ← zext(mem8[rs1+imm])                  |
| `LW rd,rs1,imm`  | I    | 0x12 | rd ← mem32[rs1+imm]                       |
| `SB rd,rs1,imm`  | I    | 0x13 | mem8[rs1+imm] ← rd[7:0]                   |
| `SW rd,rs1,imm`  | I    | 0x14 | mem32[rs1+imm] ← rd                       |
| `LH rd,rs1,imm`  | I    | 0x15 | rd ← sext(mem16[rs1+imm])                 |
| `LHU rd,rs1,imm` | I    | 0x16 | rd ← zext(mem16[rs1+imm])                 |
| `SH rd,rs1,imm`  | I    | 0x17 | mem16[rs1+imm] ← rd[15:0]                 |
| `ADD rd,rs1,rs2` | R    | 0x20 | rd ← rs1+rs2                              |
| `SUB rd,rs1,rs2` | R    | 0x21 | rd ← rs1-rs2                              |
| `AND rd,rs1,rs2` | R    | 0x22 | rd ← rs1&rs2                              |
| `OR rd,rs1,rs2`  | R    | 0x23 | rd ← rs1\|rs2                             |
| `XOR rd,rs1,rs2` | R    | 0x24 | rd ← rs1^rs2                              |
| `SHL rd,rs1,rs2` | R    | 0x25 | rd ← rs1 << (rs2 & 31)                    |
| `SHR rd,rs1,rs2` | R    | 0x26 | rd ← rs1 >>> (rs2 & 31)  (logical)        |
| `SAR rd,rs1,rs2` | R    | 0x27 | rd ← rs1 >> (rs2 & 31)   (arithmetic)     |
| `MUL rd,rs1,rs2` | R    | 0x28 | rd ← (rs1 * rs2) low 32 bits              |
| `DIV rd,rs1,rs2` | R    | 0x29 | rd ← (rs1/rs2)\|0 signed; div0 → 0        |
| `REM rd,rs1,rs2` | R    | 0x2A | rd ← rs1%rs2 signed; rs2==0 → 0           |
| `DIVU rd,rs1,rs2`| R    | 0x2B | rd ← unsigned div; div0 → 0               |
| `REMU rd,rs1,rs2`| R    | 0x2C | rd ← unsigned rem; rs2==0 → 0             |
| `ADDI rd,rs1,imm`| I    | 0x30 | rd ← rs1 + imm16                          |
| `ANDI rd,rs1,imm`| I    | 0x31 | rd ← rs1 & imm16                          |
| `ORI rd,rs1,imm` | I    | 0x32 | rd ← rs1 \| imm16                         |
| `XORI rd,rs1,imm`| I    | 0x33 | rd ← rs1 ^ imm16                          |
| `LUI rd,imm`     | I    | 0x34 | rd ← imm16 << 16                          |
| `BEQ rd,rs1,off` | I    | 0x40 | si rd==rs1 → pc += off*4                   |
| `BNE rd,rs1,off` | I    | 0x41 | si rd!=rs1 → pc += off*4                   |
| `BLT rd,rs1,off` | I    | 0x42 | si rd<rs1 → pc += off*4 (signed)           |
| `BGE rd,rs1,off` | I    | 0x43 | si rd>=rs1 → pc += off*4 (signed)          |
| `JMP off`        | J    | 0x50 | pc += off*4                               |
| `JAL rd,off`     | J    | 0x51 | rd ← pc+4; pc += off*4                    |
| `JR rs1`         | R    | 0x52 | pc ← rs1                                  |

**33 opcodes**. 220+ codepoints disponibles para extensión (FPU,
atómicas, vector, etc.).

> **Operaciones no nativas**:
> - Branches unsigned (`BLTU`/`BGEU`) → BLT/BGE con XOR del bit signo.
> - `MULH` (high 32 bits de mul 64) → no implementado.
> - `RAI` (sqrt entera) → vía MMIO query helper en libc.

## 5. ABI / Convenciones

| Registro | Rol convencional                       |
|----------|----------------------------------------|
| R0       | Zero (hardwired)                       |
| R1..R3   | Scratch / argumentos                   |
| R7       | SP del eval stack del transpiler v2-A  |
| R11      | Base de arrays Mn (`STATE_BASE+0x80`)  |
| R12      | Base de variables (`STATE_BASE`)       |
| R13      | Frame pointer (opcional)               |
| R14      | Stack pointer (call/locals)            |
| R15      | Link register (lo escribe `JAL`)       |

**Calling convention v2-A → RVM-32** (callee-saves-link):
- Args y return value via eval stack en R7 (R7 = SP del eval stack).
- `CALL target` emite `JAL R15, target` (1 instr).
- Función **leaf** (no contiene CALL): RET = `JR R15`.
- Función **non-leaf**: prologue `ADDI R14,-4; SW R15,R14,0`; epilogue
  `LW R15,R14,0; ADDI R14,+4; JR R15`. R14 = stack pointer del callstack.
- **Handlers** (CUADRO, INICIONIVEL, etc.): tratados como leaf-equivalent;
  el JS sentinel los invoca directo y no necesitan prologue.
- **Convención obligatoria del programador**: cada handler debe terminar
  con `RET` explícito. Si fall-through llegaría a otra función, el
  transpiler inserta un RET sintético (preserva semántica v2-A pero
  evita ejecutar el prologue del siguiente ente-point dos veces).

## 6. MMIO map para coprocesadores

Mismo memory map de RollitoVM v2-A + extensiones para GPU/audio
hardware. Los magic registers existentes ([REFERENCIA §15.7](REFERENCIA.md))
se mantienen intactos. La transpilación delega:

- `BOR/PIN/REC/TXT/SPR/SPRR/SPRA/MAP_/FON` → escribir args a
  registros `GPU_ARG*` y luego comando a `GPU_CMD`.
- `SON/RUI/SIL` → `STW $MR_PLAY/$MR_NOISE/$MR_SILENCE,val`.
- `CARNIV` → `STW $MR_CARNIV,val`.
- `COL/COLM/PIE/DIS` → `STW COL_CMD args; LW COL_RESULT`.
- `BTN/TEC` con índice literal → `LBU` directo a `BTN_STATE_BASE+lit`
  (3 instr).
- `X/Y/VX/VY/VIS` con índice de actor literal → `LH/LBU` directo al
  campo del slot de actor (3-4 instr).
- `ALE(n)` con `n` literal → `LW $RNG; REMU R1, R1, n` (4 instr).
- `SEN/COS(deg)` → AND 0xFF, *2, ADD `TRIG_LUT_BASE`, `LH` (5 instr).

Direcciones del MMIO bus implementadas en el intérprete RVM-32:

```
0x0A700  TRIG_LUT         256 × Int16 = sin(i/256 * 2π) * 1000  ✅
                          (cos(deg) = sin(deg + 64))
0x0B100  CMD              comandos GPU/audio/query (ver mmio.js)  ✅
0x0B104  ARG0..ARG7       8 words de args                         ✅
0x0B124  STATUS           bit0 = busy (no usado en JS)
0x0B130  RESULT           valor de retorno de queries             ✅
0x0B300  RNG              LW: lee siguiente xorshift32 + avanza   ✅
0x0B304  RNG_SEED         SW: setea seed del RNG                  ✅
```

`Q_DIV`/`Q_MOD` ya no se emiten — el transpiler usa `DIV`/`REM`/`DIVU`/`REMU`
nativos. Los códigos siguen reservados en `mmio.js` por compat.

## 7. Cobertura del transpilador (estado actual)

| v2-A class                          | Cobertura |
|-------------------------------------|-----------|
| `NOP`, `HALT`                        | ✅ |
| `LDI`, `LDV`, `STV`                  | ✅ |
| `ADDV/SUBV/MULV/DIVV` (compound)     | ✅ |
| `LDA/STA` (Mn arrays)                | ✅ |
| `ADD/SUB/MUL/AND/OR`                 | ✅ |
| `DIV/MOD`                            | ✅ opcodes nativos `DIV`/`REM`/`DIVU`/`REMU` |
| `NEG/ABS/SGN/MIN/MAX`                | ✅ inline native |
| `LT/LE/GT/GE/EQ/NE`                  | ✅ |
| `AND/OR/NOT` lógicos                 | ✅ |
| `JMP/JZ/JNZ`                         | ✅ |
| `CALL/RET`                           | ✅ callee-saves-link + leaf/non-leaf CFG analysis |
| `PARINIT/PARSIG`                     | ✅ frames en memoria (FREE+0x30000) |
| Memoria `LDM/STM/LDW/STW/LDR/STR`    | ✅ via MMIO + base table |
| `MEMCPY/MEMSET`                      | ✅ via MMIO commands |
| Builtins gráficos/audio              | ✅ via MMIO `CMD` bus |
| Queries actor (X/Y/VX/VY/VIS/PIE)    | ✅ peephole `LDI lit; QUERY` → LH directo a STATE |
| Queries `BTN/TEC` literales          | ✅ peephole `LDI lit; BTN` → LBU directo |
| `COL/COLM/DIS`                       | ✅ via MMIO query helper |
| `ALE(n)` literal                     | ✅ peephole → LW $RNG + REMU |
| `SEN/COS`                            | ✅ trig LUT (Int16, 256 entradas en 0x0A700) |
| `RAI`                                | ✅ via MMIO query (Newton-Raphson en libc) |
| `TXT`                                | ✅ via MMIO command |

**Cosim cubierto**: los 9 reference games del repo
([tests/integration/rvm32-games.test.js](tests/integration/rvm32-games.test.js))
corren idénticos byte-a-byte sobre v2-A y RVM-32 (vars + framebuffer).
Espacial tolera ≤256 px de diff por orden de evaluación de `ALE`.

**Convención del programador**: cada handler debe terminar con `RET`
explícito. Si no, el transpiler emite un RET sintético antes del
siguiente function entry para no ejecutar un prologue de más. Ejemplo:
[games/serpiente.retro:99](../games/serpiente.retro#L99) (`LLA 800:RET`).

## 8. Hardware target

**FPGA recomendada**: Lattice ECP5 LFE5U-25F.
- ~10 K LUTs estimados para CPU + GPU (sin affine) + synth.
- 56 BRAM de 18 Kbit (= 1 Mbit) — entran SPR + MAP + PAL + SON +
  STATE + FB packed 4-bit (32 KB) + algunos staging buffers (~52
  bloques usados).
- 4 DSP blocks (1 para CPU MUL, 2 para affine, 1 para audio mixer).
- Toolchain open source: Yosys + nextpnr-ecp5 + Project Trellis.
- Boards económicos: Colorlight 5A-75B v8 (~$15-25 con FPGA + 32 MB
  SDRAM + flash).

**BOM total** prototipo (~$50-70):
- ECP5 board: $15-25
- I2S DAC PCM5102A: $3
- HDMI/VGA PHY: $0-5
- Input MCU (PS/2/USB → UART): $3
- Buttons + jacks + reguladores + PCB: ~$15-25

**Alternativa lite**: iCE40 UP5K (~$5 chip, $25 dev board). Encaja una
versión recortada (FB 256×192, 2 canales audio) — no Tetris/Espacial
completos.

## 9. Verificación

Co-simulación contra el intérprete v2-A es la estrategia principal:
- Mismo bytecode v2-A → transpilar a RVM-32.
- Correr v2-A en `runFromBytecode` (referencia).
- Correr RVM-32 en `runRVM32` (target).
- Comparar `state.vars`, `state.arrays` y eventualmente `vm.fb` byte-a-byte.

Tests:
- [tests/unit/rvm32-isa.test.js](tests/unit/rvm32-isa.test.js) — encoding/decoding.
- [tests/unit/rvm32-interp.test.js](tests/unit/rvm32-interp.test.js) — programas a mano.
- [tests/unit/rvm32-transpile.test.js](tests/unit/rvm32-transpile.test.js) — cosim aritméticos.

Cuando el transpilador cubra todos los opcodes, los smoke tests de
juegos en `tests/integration/games.test.js` deberían validar contra
RVM-32 también.
