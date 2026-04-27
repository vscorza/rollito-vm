import { describe, it, expect } from 'vitest';
import { tokenize, KEYWORDS, BUILTINS, SPECIAL_VARS } from '../../src/parser/lexer.js';

describe('tokenize', () => {
  it('reconoce números', () => {
    expect(tokenize('10 200')).toEqual([
      { type: 'number', value: 10, col: 0 },
      { type: 'number', value: 200, col: 3 },
    ]);
  });

  it('reconoce variables simples y especiales como ident', () => {
    const t = tokenize('A B CUA');
    expect(t[0]).toMatchObject({ type: 'ident', value: 'A' });
    expect(t[1]).toMatchObject({ type: 'ident', value: 'B' });
    expect(t[2]).toMatchObject({ type: 'ident', value: 'CUA' });
  });

  it('reconoce keywords y los normaliza a mayúsculas', () => {
    const t = tokenize('si A>5 ent ir 100');
    expect(t[0]).toMatchObject({ type: 'kw', value: 'SI' });
    expect(t[4]).toMatchObject({ type: 'kw', value: 'ENT' });
    expect(t[5]).toMatchObject({ type: 'kw', value: 'IR' });
  });

  it('reconoce operadores compuestos', () => {
    const t = tokenize('A+=1 B<>2 C<=3');
    expect(t[1]).toMatchObject({ type: 'op', value: '+=' });
    expect(t[4]).toMatchObject({ type: 'op', value: '<>' });
    expect(t[7]).toMatchObject({ type: 'op', value: '<=' });
  });

  it('reconoce strings con comillas', () => {
    const t = tokenize('TXT 8,8,"hola mundo"');
    expect(t[t.length - 1]).toMatchObject({ type: 'string', value: 'hola mundo' });
  });

  it('descarta comentario hasta fin de línea', () => {
    const t = tokenize('A=5 ; esto es comentario');
    expect(t.length).toBe(3);
    expect(t[2]).toMatchObject({ type: 'number', value: 5 });
  });

  it('falla en string sin cerrar', () => {
    expect(() => tokenize('TXT 0,0,"sin cerrar')).toThrow(/sin cerrar/);
  });

  it('falla en carácter inesperado', () => {
    expect(() => tokenize('A=#')).toThrow(/Carácter inesperado/);
  });

  it('CUADRO y EN son keywords; BOR y REC son ident (builtins)', () => {
    const t = tokenize('EN CUADRO IR 100');
    expect(t[0]).toMatchObject({ type: 'kw', value: 'EN' });
    expect(t[1]).toMatchObject({ type: 'kw', value: 'CUADRO' });

    const t2 = tokenize('BOR 0');
    expect(t2[0]).toMatchObject({ type: 'ident', value: 'BOR' });
    expect(BUILTINS.has('BOR')).toBe(true);
  });

  it('exporta sets de keywords/builtins/specials esperados', () => {
    expect(KEYWORDS.has('SI')).toBe(true);
    expect(KEYWORDS.has('ENT')).toBe(true);
    expect(KEYWORDS.has('PAR')).toBe(true);
    expect(BUILTINS.has('REC')).toBe(true);
    expect(SPECIAL_VARS.has('CUA')).toBe(true);
  });
});
