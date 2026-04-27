# RTL plan — RollitoVM en silicio (FPGA ECP5 25F)

Plan para llevar la ISA RVM-32 ([RVM32-ISA.md](RVM32-ISA.md)) +
coprocesadores GPU/audio/MMIO a una FPGA real. Pensado para que un
solo dev pueda construir, simular y testear todo localmente con
toolchain open-source, sin licencias propietarias y reproducible vía
Docker.

> **Estado**: este es un plan, no implementación. El intérprete JS de
> RVM-32 ([src/asm/interpreter.js](../src/asm/interpreter.js)) y el
> transpiler v2-A → RVM-32 ([src/asm/v2a-to-rvm32.js](../src/asm/v2a-to-rvm32.js))
> son la **golden reference** contra la que se valida el RTL.
> 9 juegos del repo se cosimulan exitosamente vars+fb byte-a-byte
> ([tests/integration/rvm32-games.test.js](../tests/integration/rvm32-games.test.js)).

---

## 1. Toolchain target (FPGA ECP5)

100% open source:

| Herramienta            | Rol                                                    |
|------------------------|--------------------------------------------------------|
| **Yosys**              | Síntesis Verilog → netlist                             |
| **nextpnr-ecp5**       | Place & route para Lattice ECP5                        |
| **Project Trellis**    | Backend bitstream para ECP5                            |
| **ecppack** (Trellis)  | Empaquetado a `.bit`                                   |
| **openFPGALoader**     | Programar el FPGA via JTAG/USB                         |
| **Verilator**          | Simulación rápida (C++ compilado del Verilog)          |
| **Icarus Verilog**     | Simulación de fallback (interpretado)                  |
| **GTKWave**            | Visor de waveforms                                     |
| **cocotb** (opcional)  | Testbench en Python contra Verilog                     |

Todo está en repos Linux (`apt`/`pacman`/Homebrew) o se compila desde
fuente. **No** hay dependencias en herramientas Lattice Diamond,
Xilinx Vivado o Quartus.

---

## 2. Container reproducible

[hw/Dockerfile](../hw/Dockerfile) define una imagen con todo el
toolchain pre-instalado. Esto permite:
- Builds reproducibles (mismo bitstream byte-a-byte ante mismo input).
- CI en GitHub Actions sin instalar 1 GB de toolchain en cada runner.
- Onboarding de devs en un solo comando.

```bash
# Build una vez (~1 GB, ~20 min):
docker build -t rollitovm-rtl hw/

# Smoke test del toolchain:
docker run --rm rollitovm-rtl yosys -V
docker run --rm rollitovm-rtl nextpnr-ecp5 --version
docker run --rm rollitovm-rtl verilator --version

# Sintetizar el RTL (cuando exista):
docker run --rm -v "$PWD:/work" -w /work rollitovm-rtl \
  bash -c "cd hw/cpu && make synth"

# Simular con Verilator:
docker run --rm -v "$PWD:/work" -w /work rollitovm-rtl \
  bash -c "cd hw/sim && make verilate && ./obj_dir/Vrvm32_top"

# Programar la FPGA (requiere --device para el USB del programador):
docker run --rm --device=/dev/bus/usb -v "$PWD:/work" -w /work \
  rollitovm-rtl openFPGALoader -b colorlight-i5 hw/build/rvm32.bit
```

---

## 3. Estructura de carpetas

```
hw/
  Dockerfile                Toolchain image (Yosys/nextpnr/Verilator)
  Makefile                  Top-level: synth, sim, prog, clean
  cpu/
    rvm32_core.v            CPU pipeline (5-stage, in-order)
    rvm32_decoder.v         Decode 32-bit word → control signals
    rvm32_alu.v             ALU + shifter
    rvm32_regfile.v         16-reg banco
    rvm32_top.v             Wrapper + bus arbiter
    rvm32_test.cpp          Verilator harness para cosim
  gpu/
    gpu_top.v               Sprite blitter + REC/PIN/BOR + scan-out
    gpu_blit_simple.v       SPR clásico (no rotación)
    gpu_blit_affine.v       SPRR rotación + escala (DSP×2)
    gpu_blend.v             SPRA alpha lookup table
    gpu_scanout.v           FB → HDMI/VGA timing
  synth/
    synth_top.v             4 osc tonal + 1 ruido + ADSR + I2S out
    synth_voice.v
    synth_lfsr.v
    synth_i2s.v
  pkg/
    rvm32_pkg.v             Constantes (opcodes, MMIO addrs)
    mem_map_pkg.v           Memory map (igual a memory.js)
  ecp5/
    rvm32.lpf               Pin constraints para Colorlight 5A-75B
    rvm32_top_ecp5.v        Wrapper específico ECP5 (PLL, IO buffers)
  sim/
    Vrvm32_top.cpp          Verilator C++ wrapper
    cosim_runner.cpp        Carga binario RVM-32, ejecuta, dumpea state
  tests/
    test_alu.v              Smoke tests por bloque (cocotb)
    test_branches.v
    test_mmio.v
  build/                    Output dir (gitignored)
```

---

## 4. Estrategia de verificación (cosim)

La VM RollitoVM se valida vía **co-simulación** contra el intérprete JS
RVM-32 (golden reference). Para cada combinación (programa transpilado,
state inicial), corremos:

1. Intérprete JS → state1, fb1.
2. RTL via Verilator → state2, fb2.
3. Diff. Falla si no coinciden.

### 4.1 Smoke tests por bloque

Cada bloque del RTL tiene su propio testbench. Estilo cocotb (Python +
Verilog):

- **CPU core**: ejecutar 100 programas RVM-32 cortos (ALU, branches,
  loads/stores) y comparar regs[] al final.
- **GPU blit**: cargar pattern + ARGn, disparar GPU_CMD, comparar el
  framebuffer contra `drawPattern` de
  [src/core/sprites.js](../src/core/sprites.js).
- **Synth**: cargar sound def en SON region, disparar PLAY, capturar
  16 ms de samples I2S, comparar contra
  [src/audio/synth.js](../src/audio/synth.js) modo headless.
- **MMIO bus**: tests de orden (write a CMD después de ARGs) y
  conflict resolution (CPU vs GPU access a SPR/MAP/FB BRAMs).

### 4.2 Cosim de juegos completos

Tomar los 9 juegos del repo, transpilarlos a RVM-32, correrlos en:
- JS interpreter v2-A
- JS interpreter RVM-32 (transpilado)
- Verilator del RTL completo

Y comparar los 64 KB del FB byte-a-byte después de N frames. Mismo seed
de PRNG. Cualquier divergencia es bug.

Este nivel de cosim ya está implementado en JS:
[tests/integration/rvm32-games.test.js](../tests/integration/rvm32-games.test.js).
Faltaría el adaptador C++ que llama Verilator y compara contra los
mismos juegos.

### 4.3 CI con Docker

`.github/workflows/rtl.yml`:
```yaml
on: [push, pull_request]
jobs:
  rtl:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t rollitovm-rtl hw/
      - run: docker run --rm -v $PWD:/work -w /work rollitovm-rtl
              make -C hw verilate test-cosim
```

---

## 5. Roadmap de implementación

Cada paso entrega artefactos verificables. **No** se intenta el bring-up
en placa hasta que el RTL pase 100% de cosim en Verilator.

### Fase 1 — CPU core (sin coprocesadores)
- Implementar pipeline 5-stage de RVM-32 (sin caches, sin branch predict).
- DSP block para MUL.
- Bus simple read/write a una BRAM (32 KB).
- **Test**: ejecutar todos los programas de
  [tests/unit/rvm32-interp.test.js](../tests/unit/rvm32-interp.test.js)
  en Verilator. Comparar PC + regs[] cada ciclo.
- **Métrica**: ~2500 LUTs, fmax ≥ 50 MHz en ECP5 25F.

### Fase 2 — Memory map + MMIO bus
- Bus arbiter entre CPU/GPU/scan-out con prioridades.
- BRAM para STATE (16 KB), SPR (32 KB), MAP (16 KB), PAL (1 KB), SON (12 KB), FB (32 KB packed 4-bit).
- Magic registers v2-E (`$MR_PLAY`, etc.) routeados al synth (stub).
- **Test**: cosim con un programa que sólo hace SW/LW a regiones distintas.

### Fase 3 — GPU clásico (SPR + REC + PIN + BOR + MAP_)
- Sprite blitter: lee pattern de SPR BRAM, escribe a FB BRAM.
- 1-pixel-per-cycle throughput.
- Comando dispatcher para GPU_CMD.
- **Test**: cosim de pelota.retro, pong.retro (FB byte-a-byte).

### Fase 4 — GPU affine + alpha (SPRR + SPRA)
- 2 DSP blocks para multiplicaciones de matriz inversa.
- BLEND_TABLE 256-byte lookup.
- **Test**: cosim de programas que usan SPRR/SPRA.

### Fase 5 — Synth audio (4 osc + ruido + ADSR)
- Generador de ondas (TRI/SIE/PUL/SEN) via tabla seno.
- LFSR para ruido.
- ADSR envelope.
- I2S serializer → PCM5102A external DAC.
- **Test**: cosim del synth con `serializeSoundToBytes` JS.

### Fase 6 — Scan-out (FB → HDMI o VGA)
- Timing de 320×200 @ 60 Hz, scanline buffer.
- Palette LUT lookup.
- HDMI: TMDS encoding (necesita PHY externo o resistor-DAC).
- VGA: resistor-DAC (cheap, fits ECP5 sin PHY).
- **Test**: simular 1 frame de scan-out, comparar con `blit` JS
  ([src/render/framebuffer.js](../src/render/framebuffer.js)).

### Fase 7 — Bring-up Colorlight 5A-75B
- Re-pinout (`rvm32.lpf`) para conector Ethernet (re-usado como GPIO
  por hobbystas para LED tile receivers).
- Cargar bitstream via JTAG.
- Conectar buttons + audio + video físicos.
- **Test**: correr pelota en pantalla.

---

## 6. Hardware mínimo de bring-up

Por unidad (~$50-70):

| Item                          | Modelo                  | Costo  |
|-------------------------------|-------------------------|-------:|
| Board ECP5 LFE5U-25F          | Colorlight 5A-75B v8    | $15-25 |
| Audio DAC I2S                 | TI PCM5102A breakout    | $3     |
| HDMI conn + TMDS PHY          | TFP410 breakout         | $5     |
| (alt) VGA: 4 resistors        | -                       | $0.10  |
| MCU input host (USB→UART)     | ATmega328 dev board     | $3     |
| Botones tactile 6mm           | x8                      | $2     |
| 3.5mm audio jack              | -                       | $1     |
| PCB de breakout               | JLCPCB                  | $10    |
| Cables + headers              | -                       | $5     |

Para el primer prototipo no es necesaria PCB custom: el Colorlight ya
viene con ethernet + flash + sdram, sólo hay que tirar wires al PMOD
o a los pines del conector Ethernet (la comunidad open-hw los usa
como GPIO).

---

## 7. Riesgos y mitigaciones

| Riesgo                                              | Mitigación                                       |
|-----------------------------------------------------|--------------------------------------------------|
| Verilator simula lento para un juego completo (60 fps × N s) | Usar prog corto + comparar primer frame a otra cota; full-game cosim solo en local + nightly. |
| Cosim diff entre JS y RTL por orden de operaciones (ALE) | Usar PRNG hw idéntico (xorshift32 con seed compartido); validar ALE en isolation. |
| BRAM de ECP5 25F al límite (~52/56)                 | Si superamos: empacar SPR a 4-bit, o subir a ECP5 45F (108 BRAM, ~$5 más caro). |
| Toolchain open-source rota (changes en Yosys/nextpnr)| Pinning de versiones en Dockerfile; CI ejecuta el build del container cada PR. |
| Pin assignment de Colorlight no estándar            | Comunidad ya documentó: hay `.lpf` files públicos. Listar referencias en el repo. |

---

## 8. Hitos verificables

| Hito                                  | Entregable                              |
|---------------------------------------|-----------------------------------------|
| RTL.0: container + smoke              | `docker run … yosys -V` funciona        |
| RTL.1: CPU core en Verilator          | 11 tests de [rvm32-interp.test.js](../tests/unit/rvm32-interp.test.js) pasan en RTL |
| RTL.2: bus + memory map               | SW/LW round-trip en todas las regiones  |
| RTL.3: GPU básico                     | pelota cosim FB-equal en RTL            |
| RTL.4: GPU affine + alpha             | SPRR/SPRA cosim                         |
| RTL.5: Synth audio                    | sound n cosim contra serializer JS      |
| RTL.6: Scan-out HDMI/VGA              | 1 frame coincide con `blit` JS          |
| RTL.7: 9 juegos completos             | Todos los juegos del repo cosim FB-equal en Verilator |
| RTL.8: Bring-up físico                | pelota corriendo en monitor + buttons    |

Cada hito merece su propio commit + tag en git.

---

## 9. Lo que NO entra en este plan

- **No** se construye RTL en este sprint — sólo el plan + Dockerfile.
- **No** se diseñan ASICs ni se hace tape-out. FPGA only.
- **No** se compite con consolas comerciales — el target es educativo
  y replicable.
- **No** se persigue cycle-accuracy con C64/NES — RollitoVM es su
  propio "hardware ficticio".
