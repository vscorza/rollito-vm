import { describe, it, expect } from 'vitest';
import { parseProgram, parseStatement } from '../../src/parser/parser.js';

describe('parseStatement', () => {
  it('parsea asignación simple', () => {
    expect(parseStatement('A=5')).toEqual({
      type: 'assign', op: '=', target: 'A',
      expr: { type: 'num', value: 5 },
    });
  });

  it('parsea asignaciones compuestas', () => {
    expect(parseStatement('B+=1').op).toBe('+=');
    expect(parseStatement('B-=1').op).toBe('-=');
    expect(parseStatement('B*=2').op).toBe('*=');
    expect(parseStatement('B/=2').op).toBe('/=');
  });

  it('parsea expresiones aritméticas con precedencia', () => {
    const ast = parseStatement('A=2+3*4');
    expect(ast.expr).toEqual({
      type: 'binop', op: '+',
      l: { type: 'num', value: 2 },
      r: {
        type: 'binop', op: '*',
        l: { type: 'num', value: 3 },
        r: { type: 'num', value: 4 },
      },
    });
  });

  it('parsea paréntesis y comparaciones', () => {
    const ast = parseStatement('SI (A+1)>5 ENT IR 100');
    expect(ast.type).toBe('if');
    expect(ast.cond.op).toBe('>');
    expect(ast.cond.l.op).toBe('+');
  });

  it('parsea SI/ENT/SINO con números como atajo de IR', () => {
    const ast = parseStatement('SI A=0 ENT 50 SINO 60');
    expect(ast.then).toEqual({ type: 'goto', line: 50 });
    expect(ast.else).toEqual({ type: 'goto', line: 60 });
  });

  it('parsea PAR con expresiones', () => {
    const ast = parseStatement('PAR I=1 A 10');
    expect(ast).toEqual({
      type: 'for', var: 'I',
      from: { type: 'num', value: 1 },
      to: { type: 'num', value: 10 },
    });
  });

  it('parsea SIG, IR, LLA, RET, FIN, PAUSA', () => {
    expect(parseStatement('SIG').type).toBe('next');
    expect(parseStatement('IR 50').type).toBe('goto');
    expect(parseStatement('LLA 200')).toEqual({ type: 'gosub', line: 200 });
    expect(parseStatement('RET').type).toBe('ret');
    expect(parseStatement('FIN').type).toBe('fin');
    expect(parseStatement('PAUSA').type).toBe('pausa');
  });

  it('parsea EN CUADRO IR n', () => {
    const ast = parseStatement('EN CUADRO IR 100');
    expect(ast).toEqual({ type: 'event', event: 'CUADRO', line: 100 });
  });

  it('rechaza eventos no soportados', () => {
    // EN LINEA queda fuera de Hito 7 (requiere dispatch por scanline).
    expect(() => parseStatement('EN LINEA IR 50')).toThrow(/no soportado/);
  });

  it('parsea calls a builtins con N argumentos', () => {
    expect(parseStatement('BOR 0')).toEqual({
      type: 'call', name: 'BOR',
      args: [{ type: 'num', value: 0 }],
    });
    const rec = parseStatement('REC A,90,40,20,8');
    expect(rec.type).toBe('call');
    expect(rec.name).toBe('REC');
    expect(rec.args.length).toBe(5);
  });

  it('parsea cadenas con ":"', () => {
    const ast = parseStatement('A=5:B=A*2');
    expect(ast.type).toBe('seq');
    expect(ast.stmts.length).toBe(2);
    expect(ast.stmts[0].type).toBe('assign');
    expect(ast.stmts[1].type).toBe('assign');
  });

  it('parsea operadores lógicos Y/O/NO', () => {
    const ast = parseStatement('SI A>0 Y B<10 ENT 100');
    expect(ast.cond.op).toBe('Y');
    const ast2 = parseStatement('SI NO A=0 ENT 50');
    expect(ast2.cond).toEqual({
      type: 'unop', op: 'NO',
      x: { type: 'binop', op: '=',
           l: { type: 'var', name: 'A' },
           r: { type: 'num', value: 0 } },
    });
  });
});

describe('parseProgram', () => {
  it('parsea header + líneas numeradas', () => {
    const src = `JUEGO HitoTres
AUTOR Demo
VERSION 1

PROGRAMA
10 EN CUADRO IR 100
100 BOR 0
110 RET
`;
    const r = parseProgram(src);
    expect(r.header).toEqual({ JUEGO: 'HitoTres', AUTOR: 'Demo', VERSION: '1' });
    expect(r.lines.length).toBe(3);
    expect(r.lines[0].lineNumber).toBe(10);
    expect(r.lines[0].ast.type).toBe('event');
    expect(r.lines[1].ast.type).toBe('call');
    expect(r.lines[2].ast.type).toBe('ret');
  });

  it('ignora comentarios de línea completa y de fin de línea', () => {
    const src = `PROGRAMA
; comentario completo
10 A=5 ; trailing
20 RET
`;
    const r = parseProgram(src);
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].ast.expr.value).toBe(5);
  });

  it('falla si una línea de PROGRAMA no empieza con número', () => {
    const src = `PROGRAMA
asdf
`;
    expect(() => parseProgram(src)).toThrow(/se esperaba número de línea/);
  });

  it('parsea bloque PALETA con 4 filas de 4 colores', () => {
    const src = `JUEGO X
PALETA 0
000000 1D2B53 7E2553 008751
AB5236 5F574F C2C3C7 FFF1E8
FF004D FFA300 FFEC27 00E436
29ADFF 83769C FF77A8 FFCCAA

PROGRAMA
10 RET
`;
    const r = parseProgram(src);
    expect(r.palettes.length).toBe(1);
    expect(r.palettes[0].index).toBe(0);
    expect(r.palettes[0].colors.length).toBe(16);
    expect(r.palettes[0].colors[0]).toBe('000000');
    expect(r.palettes[0].colors[15]).toBe('FFCCAA');
  });

  it('parsea PALETA con 16 colores en una sola línea', () => {
    const src = `PALETA 1
000000 111111 222222 333333 444444 555555 666666 777777 888888 999999 AAAAAA BBBBBB CCCCCC DDDDDD EEEEEE FFFFFF
PROGRAMA
10 RET
`;
    const r = parseProgram(src);
    expect(r.palettes[0].index).toBe(1);
    expect(r.palettes[0].colors[0]).toBe('000000');
    expect(r.palettes[0].colors[15]).toBe('FFFFFF');
  });

  it('PALETA con menos de 16 colores tira error', () => {
    const src = `PALETA 0
000000 111111 222222

PROGRAMA
10 RET
`;
    expect(() => parseProgram(src)).toThrow(/16 colores hex/);
  });

  it('PALETA con slot fuera de rango tira error', () => {
    const src = `PALETA 5
000000 111111 222222 333333
444444 555555 666666 777777
888888 999999 AAAAAA BBBBBB
CCCCCC DDDDDD EEEEEE FFFFFF
PROGRAMA
10 RET
`;
    expect(() => parseProgram(src)).toThrow(/fuera de rango/);
  });

  it('normaliza los colores a uppercase', () => {
    const src = `PALETA 0
ff00ff aabbcc 123abc def012
000000 000000 000000 000000
000000 000000 000000 000000
000000 000000 000000 000000
PROGRAMA
10 RET
`;
    const r = parseProgram(src);
    expect(r.palettes[0].colors[0]).toBe('FF00FF');
    expect(r.palettes[0].colors[1]).toBe('AABBCC');
    expect(r.palettes[0].colors[2]).toBe('123ABC');
    expect(r.palettes[0].colors[3]).toBe('DEF012');
  });
});
