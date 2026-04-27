import { describe, it, expect } from 'vitest';
import { createVM } from '../../src/core/vm.js';
import { MEM, REGION_PAL, REGION_SPR, REGION_MAP, REGION_SON } from '../../src/core/memory.js';
import { VAR_INDEX } from '../../src/core/memory.js';

function step(vm) { vm.runFrame(); }

// =====================================================================

describe('memory map: regiones y tamaños', () => {
  it('total = 512 KB y regiones bien alineadas', () => {
    expect(MEM.CODE.base).toBe(0x00000);
    expect(MEM.STATE.base).toBe(0x08000);
    expect(MEM.SPR.base).toBe(0x10000);
    expect(MEM.MAP.base).toBe(0x18000);
    expect(MEM.PAL.base).toBe(0x1C000);
    expect(MEM.SON.base).toBe(0x1D000);
    expect(MEM.FB.base).toBe(0x20000);
    expect(MEM.FREE.base).toBe(0x30000);
    expect(MEM.FREE.base + MEM.FREE.size).toBe(0x80000);
  });
});

describe('LDR / STR (acceso indexado)', () => {
  it('SPR (region 1): round-trip de un byte', () => {
    const vm = createVM(`
SPRITE 1 8x8
00111100
01111110
11111111
11111111
11111111
11111111
01111110
00111100
PROGRAMA
10 EN CUADRO IR 105
105 A=LDR(1,1,9)
110 STR 1,1,9,4
115 B=LDR(1,1,9)
120 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(4);
    expect(vm.spriteState.patterns[1].pixels[9]).toBe(4);
  });

  it('MAP (region 2): STR marca m.dirty=true', () => {
    const vm = createVM(`
MAPA 0 4x4
0000
0000
0000
0000
PROGRAMA
10 EN CUADRO IR 105
105 STR 2,0,5,3
110 RET
`);
    step(vm);
    expect(vm.mapState.maps[0].cells[5]).toBe(3);
    expect(vm.mapState.maps[0].dirty).toBe(true);
  });

  it('PAL (region 0): STR actualiza la LUT', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STR 0,0,0,255
110 STR 0,0,1,128
120 RET
`);
    step(vm);
    const lut0 = vm.bank.luts[0] >>> 0;
    expect(lut0 & 0xff).toBe(255);
    expect((lut0 >>> 8) & 0xff).toBe(128);
  });

  it('SON (region 3): LDR retorna el wave byte (read-only)', () => {
    const vm = createVM(`
SONIDO 0
ONDA SEN
ENV 0,1,12,2
NOTA DO5 4
FIN
PROGRAMA
10 EN CUADRO IR 105
105 A=LDR(3,0,0)
110 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(3);
  });

  it('SON: STR escribe el byte y marca el slot dirty (v2-C)', () => {
    const vm = createVM(`
SONIDO 0
ONDA TRI
ENV 0,1,12,2
NOTA DO5 4
FIN
PROGRAMA
10 EN CUADRO IR 105
105 STR 3,0,0,99
110 A=LDR(3,0,0)
115 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(99);
    expect(vm.synth.dirtySounds[0]).toBe(1);
  });

  it('region/slot/offset fuera de rango son no-op silentes', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STR 99,0,0,42
110 STR 1,99,0,42
115 STR 1,0,9999,42
120 A=LDR(99,0,0)
125 B=LDR(1,99,0)
130 RET
`);
    expect(() => step(vm)).not.toThrow();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(0);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(0);
  });
});

describe('LDM / STM (acceso por dirección absoluta)', () => {
  it('LDM lee primeros bytes de SPR slot 0', () => {
    const vm = createVM(`
SPRITE 0 8x8
0F0F0F0F
00000000
00000000
00000000
00000000
00000000
00000000
00000000
PROGRAMA
10 EN CUADRO IR 105
105 A=LDM(0x10000)
110 B=LDM(0x10001)
115 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(0);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(0x0F);
  });

  it('STM en SPR escribe el byte y persiste en pattern.pixels', () => {
    const vm = createVM(`
SPRITE 0 8x8
00000000
00000000
00000000
00000000
00000000
00000000
00000000
00000000
PROGRAMA
10 EN CUADRO IR 105
105 STM 0x10000,7
110 STM 0x10001,11
115 RET
`);
    step(vm);
    expect(vm.spriteState.patterns[0].pixels[0]).toBe(7);
    expect(vm.spriteState.patterns[0].pixels[1]).toBe(11);
  });

  it('STM en FB pinta un byte del framebuffer', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STM 0x20000,9
110 STM 0x20001,9
115 STM 0x20140,9
120 RET
`);
    step(vm);
    expect(vm.fb[0]).toBe(9);
    expect(vm.fb[1]).toBe(9);
    expect(vm.fb[320]).toBe(9);
  });

  it('STM/LDM en FREE round-trip', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STM 0x30000,42
110 STM 0x30001,200
115 A=LDM(0x30000)
120 B=LDM(0x30001)
125 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(42);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(200);
  });

  it('LDM en CODE devuelve los bytes del bytecode emitido (v2-A)', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 A=LDM(0)
110 RET
`);
    step(vm);
    // El primer word emitido empieza con LDI (0x10) — el primer arg
    // que se empuja al stack para LDM(0) en la línea 105. v2-A garantiza
    // que codeMem refleja palabras de 32 bits del programa compilado.
    expect(vm.state.vars[VAR_INDEX.A]).toBe(0x10);
  });

  it('STATE: LDM lee bytes de las variables', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 A=42
110 B=LDM(0x8000)
115 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(42);
  });
});

describe('LDW / STW (32-bit word access)', () => {
  it('LDW lee 4 bytes little-endian', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STM 0x30000,1
110 STM 0x30001,2
115 STM 0x30002,3
120 STM 0x30003,4
125 A=LDW(0x30000)
130 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A] >>> 0).toBe(0x04030201);
  });

  it('STW escribe 4 bytes little-endian', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STW 0x30000,0xCAFEBABE
110 A=LDM(0x30000)
115 B=LDM(0x30001)
120 C=LDM(0x30002)
125 D=LDM(0x30003)
130 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(0xBE);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(0xBA);
    expect(vm.state.vars[VAR_INDEX.C]).toBe(0xFE);
    expect(vm.state.vars[VAR_INDEX.D]).toBe(0xCA);
  });
});

describe('MEMCPY / MEMSET (direcciones absolutas)', () => {
  it('MEMSET llena n bytes con val', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 MEMSET 0x30000,42,8
110 A=LDM(0x30000)
115 B=LDM(0x30007)
120 C=LDM(0x30008)
125 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(42);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(42);
    expect(vm.state.vars[VAR_INDEX.C]).toBe(0);
  });

  it('MEMCPY copia rango src→dst', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 MEMSET 0x30000,77,4
110 MEMCPY 0x30000,0x30100,4
115 A=LDM(0x30100)
120 B=LDM(0x30103)
125 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(77);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(77);
  });

  it('MEMCPY con solapamiento (dst > src) preserva contenido', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 STM 0x30000,1:STM 0x30001,2:STM 0x30002,3:STM 0x30003,4
110 MEMCPY 0x30000,0x30001,3
115 A=LDM(0x30000):B=LDM(0x30001):C=LDM(0x30002):D=LDM(0x30003)
120 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.C]).toBe(2);
    expect(vm.state.vars[VAR_INDEX.D]).toBe(3);
  });

  it('MEMSET sobre FB pinta una franja del framebuffer', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 MEMSET 0x20000,5,320
110 RET
`);
    step(vm);
    for (let i = 0; i < 320; i++) {
      expect(vm.fb[i]).toBe(5);
    }
    expect(vm.fb[320]).toBe(0);
  });
});

describe('Region constants exportados', () => {
  it('REGION_PAL=0, REGION_SPR=1, REGION_MAP=2, REGION_SON=3', () => {
    expect(REGION_PAL).toBe(0);
    expect(REGION_SPR).toBe(1);
    expect(REGION_MAP).toBe(2);
    expect(REGION_SON).toBe(3);
  });
});

describe('Hex literals en el lexer', () => {
  it('parsea 0x prefix correctamente', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 105
105 A=0xFF:B=0x100:C=0xCAFE
110 RET
`);
    step(vm);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(255);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(256);
    expect(vm.state.vars[VAR_INDEX.C]).toBe(0xCAFE);
  });
});

describe('v2-C: STR(SON,...) + SON n,c re-deserializa', () => {
  it('cambiar el byte 0 (wave) afecta el sonido reproducido', () => {
    const vm = createVM(`
SONIDO 0
ONDA TRI
ENV 0,1,12,2
NOTA DO5 4
FIN
PROGRAMA
10 EN CUADRO IR 105
105 STR $RSON,0,0,3
110 SON 0,0
115 RET
`);
    step(vm);
    expect(vm.synth.sounds[0].wave).toBe('SEN');
    expect(vm.synth.dirtySounds[0]).toBe(0);
  });

  it('cambiar el ticks de un step ajusta totalTicks', () => {
    const vm = createVM(`
SONIDO 0
ONDA SEN
ENV 0,1,12,2
NOTA DO5 4
NOTA SOL5 6
FIN
PROGRAMA
10 EN CUADRO IR 105
105 STR $RSON,0,10,12
110 SON 0,0
115 RET
`);
    step(vm);
    expect(vm.synth.sounds[0].steps[0].ticks).toBe(12);
    expect(vm.synth.sounds[0].totalTicks).toBe(12 + 6);
  });

  it('STR fuera del slotMax es no-op silente', () => {
    const vm = createVM(`
SONIDO 0
ONDA PUL
ENV 0,1,12,2
NOTA DO5 4
FIN
PROGRAMA
10 EN CUADRO IR 105
105 STR $RSON,0,9999,42
110 SON 0,0
115 RET
`);
    expect(() => step(vm)).not.toThrow();
    expect(vm.synth.sounds[0].wave).toBe('PUL');
  });
});
