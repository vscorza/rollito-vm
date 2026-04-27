import { describe, it, expect } from 'vitest';
import { parseProgram } from '../../src/parser/parser.js';
import { compile } from '../../src/parser/compiler.js';
import { createState } from '../../src/core/memory.js';
import { createSpriteState } from '../../src/core/sprites.js';
import { createMapState } from '../../src/core/maps.js';
import { createInputState } from '../../src/core/input.js';
import { createSynth, loadSound } from '../../src/audio/synth.js';
import { PIXELS } from '../../src/render/framebuffer.js';

function build(source) {
  const vmRef = {
    fb: new Uint8Array(PIXELS),
    spriteState: createSpriteState(),
    mapState: createMapState(),
    inputState: createInputState(),
    synth: createSynth(null),
  };
  const parsed = parseProgram(source);
  for (const sound of parsed.sounds || []) {
    loadSound(vmRef.synth, sound.index, sound);
  }
  const compiled = compile(parsed, vmRef);
  const state = createState();
  return { ...compiled, state, vmRef, parsed };
}

function run(c, fromLine) {
  let pc = c.lineToIdx[fromLine];
  let budget = 1_000_000;
  while (pc >= 0 && pc < c.program.length) {
    pc = c.program[pc](pc, c.state);
    if (--budget <= 0) throw new Error('budget overrun');
  }
}

describe('SONIDO block parsing', () => {
  it('parsea ONDA, ENV, NOTA, SIL, FIN', () => {
    const c = build(`
SONIDO 0
ONDA PUL
PUL 8
ENV 1,2,8,4
NOTA DO5 4
SIL 2
NOTA SOL5 8
FIN

PROGRAMA
10 RET
`);
    expect(c.parsed.sounds.length).toBe(1);
    const s = c.parsed.sounds[0];
    expect(s.index).toBe(0);
    expect(s.wave).toBe('PUL');
    expect(s.pulseWidth).toBe(8);
    expect(s.env).toEqual({ a: 1, d: 2, s: 8, r: 4 });
    expect(s.steps.length).toBe(3);
    expect(s.steps[0]).toMatchObject({ type: 'note', semitone: 0, octave: 5, ticks: 4 });
    expect(s.steps[1]).toMatchObject({ type: 'silence', ticks: 2 });
    expect(s.steps[2]).toMatchObject({ type: 'note', semitone: 7, octave: 5, ticks: 8 });
  });

  it('rechaza nota inválida', () => {
    expect(() => build(`
SONIDO 0
ONDA PUL
NOTA XX5 4
FIN

PROGRAMA
10 RET
`)).toThrow(/nota inválida/);
  });

  it('rechaza falta de FIN', () => {
    expect(() => build(`
SONIDO 0
ONDA PUL
NOTA DO5 4

PROGRAMA
10 RET
`)).toThrow(/inválido en SONIDO 0|falta FIN/);
  });
});

describe('SON / RUI / SIL statements', () => {
  it('SON dispara el sonido en el canal indicado', () => {
    const c = build(`
SONIDO 0
ONDA PUL
NOTA DO5 4
FIN

PROGRAMA
10 SON 0,1
20 RET
`);
    run(c, 10);
    expect(c.vmRef.synth.channels[1].isPlaying).toBe(true);
  });

  it('SIL silencia un canal específico', () => {
    const c = build(`
SONIDO 0
ONDA PUL
NOTA DO5 30
FIN

PROGRAMA
10 SON 0,1
20 SIL 1
30 RET
`);
    run(c, 10);
    expect(c.vmRef.synth.channels[1].isPlaying).toBe(false);
  });

  it('RUI dispara en el canal de ruido', () => {
    const c = build(`
SONIDO 0
ONDA PUL
NOTA DO5 4
FIN

PROGRAMA
10 RUI 0
20 RET
`);
    run(c, 10);
    expect(c.vmRef.synth.channels[4].isPlaying).toBe(true);
  });
});

describe('Eventos EN CANAL c IR n y EN SILENCIO IR n', () => {
  it('hoistea handlers de CANAL y SILENCIO', () => {
    const c = build(`PROGRAMA
10 EN CUADRO IR 100
20 EN CANAL 0 IR 200
30 EN CANAL 2 IR 300
40 EN SILENCIO IR 400
100 RET
200 RET
300 RET
400 RET
`);
    expect(c.handlers.CUADRO).toBeDefined();
    expect(c.handlers.CANAL[0]).toBeDefined();
    expect(c.handlers.CANAL[2]).toBeDefined();
    expect(c.handlers.CANAL[1]).toBeUndefined();
    expect(c.handlers.SILENCIO).toBeDefined();
  });

  it('rechaza CANAL fuera de rango', () => {
    expect(() => build(`PROGRAMA
10 EN CANAL 9 IR 100
100 RET
`)).toThrow(/canal fuera de rango/);
  });
});
