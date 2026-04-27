import { describe, it, expect } from 'vitest';
import { createVM } from '../../src/core/vm.js';
import { VAR_INDEX } from '../../src/core/memory.js';

function counterProgram(eventName, target = 100, slot = 'A') {
  return `PROGRAMA
10 EN ${eventName} IR ${target}
${target} ${slot}+=1
${target + 5} RET
`;
}

describe('Lifecycle: orden de eventos al primer cuadro', () => {
  it('INICIOMOTOR e INICIOJUEGO disparan una sola vez', () => {
    const vm = createVM(`PROGRAMA
10 EN INICIOMOTOR IR 200
20 EN INICIOJUEGO IR 300
30 EN CUADRO IR 100
100 RET
200 A+=1
210 RET
300 B+=1
310 RET
`);
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(1);
    vm.runFrame();
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(1);
  });

  it('CARGANIVEL y INICIONIVEL disparan al primer cuadro', () => {
    const vm = createVM(`PROGRAMA
10 EN CARGANIVEL IR 200
20 EN INICIONIVEL IR 300
30 EN CUADRO IR 100
100 RET
200 A+=1
210 RET
300 B+=1
310 RET
`);
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(1);
  });

  it('FINCUADRO dispara después de CUADRO en el mismo cuadro', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
20 EN FINCUADRO IR 200
100 A+=1:RET
200 B=A
210 RET
`);
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(1);
  });
});

describe('CARNIV: dispara CARGANIVEL→INICIONIVEL al próximo cuadro', () => {
  it('NIV se actualiza y los handlers re-ejecutan', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
20 EN CARGANIVEL IR 200
30 EN INICIONIVEL IR 300
100 SI CUA=2 ENT CARNIV 5
110 RET
200 A+=1:RET
300 B+=1:RET
`);
    vm.runFrame();  // CUA=0 inicial: CARGANIVEL/INICIONIVEL una vez (A=1, B=1)
    vm.runFrame();  // CUA=1: nada
    vm.runFrame();  // CUA=2 → CARNIV 5; al próximo cuadro disparará handlers
    vm.runFrame();  // dispara CARGANIVEL/INICIONIVEL otra vez
    expect(vm.state.vars[VAR_INDEX.NIV]).toBe(5);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(2);
    expect(vm.state.vars[VAR_INDEX.B]).toBe(2);
  });
});

describe('PAUSA / REANUDA', () => {
  it('PAUSA statement detiene CUADRO, dispara handler PAUSA al cuadro siguiente', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
20 EN PAUSA IR 200
30 EN REANUDA IR 300
100 A+=1
110 SI A=2 ENT PAUSA
120 RET
200 P+=1:RET
300 R+=1:RET
`);
    vm.runFrame();  // CUA=0: A=1
    vm.runFrame();  // CUA=1: A=2 → PAUSA → halt; A es 2
    expect(vm.state.paused).toBe(true);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(2);
    vm.runFrame();  // dispara handler PAUSA, luego return early
    expect(vm.state.vars[VAR_INDEX.P]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(2);  // CUADRO no corre
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(2);  // sigue pausado
    expect(vm.state.vars[VAR_INDEX.P]).toBe(1);  // PAUSA no se redispara

    vm.resume();
    vm.runFrame();  // dispara REANUDA, luego corre CUADRO
    expect(vm.state.vars[VAR_INDEX.R]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(3);
  });

  it('vm.pause() programático también dispara PAUSA', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
20 EN PAUSA IR 200
100 A+=1:RET
200 P+=1:RET
`);
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
    vm.pause();
    vm.runFrame();
    expect(vm.state.vars[VAR_INDEX.P]).toBe(1);
    expect(vm.state.vars[VAR_INDEX.A]).toBe(1);
  });
});

describe('PRNG ALE seedeable', () => {
  it('mismo seed → misma secuencia', () => {
    const a = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=ALE(1000):B=ALE(1000):C=ALE(1000)
110 RET
`, { seed: 42 });
    const b = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=ALE(1000):B=ALE(1000):C=ALE(1000)
110 RET
`, { seed: 42 });
    a.runFrame(); b.runFrame();
    expect(a.state.vars[VAR_INDEX.A]).toBe(b.state.vars[VAR_INDEX.A]);
    expect(a.state.vars[VAR_INDEX.B]).toBe(b.state.vars[VAR_INDEX.B]);
    expect(a.state.vars[VAR_INDEX.C]).toBe(b.state.vars[VAR_INDEX.C]);
  });

  it('seed distinto → secuencia distinta', () => {
    const a = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=ALE(1000)
110 RET
`, { seed: 42 });
    const b = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=ALE(1000)
110 RET
`, { seed: 99 });
    a.runFrame(); b.runFrame();
    expect(a.state.vars[VAR_INDEX.A]).not.toBe(b.state.vars[VAR_INDEX.A]);
  });

  it('ALE(n) siempre devuelve 0..n-1', () => {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=ALE(10)
110 RET
`, { seed: 1 });
    for (let i = 0; i < 200; i++) {
      vm.runFrame();
      const v = vm.state.vars[VAR_INDEX.A];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });
});

describe('Funciones matemáticas', () => {
  function evalExpr(expr) {
    const vm = createVM(`PROGRAMA
10 EN CUADRO IR 100
100 A=${expr}
110 RET
`);
    vm.runFrame();
    return vm.state.vars[VAR_INDEX.A];
  }

  it('ABS', () => {
    expect(evalExpr('ABS(5)')).toBe(5);
    expect(evalExpr('ABS(-7)')).toBe(7);
    expect(evalExpr('ABS(0)')).toBe(0);
  });
  it('SGN', () => {
    expect(evalExpr('SGN(0)')).toBe(0);
    expect(evalExpr('SGN(42)')).toBe(1);
    expect(evalExpr('SGN(-3)')).toBe(-1);
  });
  it('MIN / MAX', () => {
    expect(evalExpr('MIN(3,7)')).toBe(3);
    expect(evalExpr('MAX(3,7)')).toBe(7);
    expect(evalExpr('MIN(-5,-3)')).toBe(-5);
  });
  it('RAI', () => {
    expect(evalExpr('RAI(16)')).toBe(4);
    expect(evalExpr('RAI(15)')).toBe(3);
    expect(evalExpr('RAI(0)')).toBe(0);
    expect(evalExpr('RAI(-5)')).toBe(0);
  });
  it('SEN / COS escala 1000', () => {
    expect(evalExpr('SEN(0)')).toBe(0);
    expect(evalExpr('SEN(90)')).toBe(1000);
    expect(evalExpr('COS(0)')).toBe(1000);
    expect(evalExpr('COS(180)')).toBe(-1000);
    // 707 ± unas unidades por redondeo entero.
    const v = evalExpr('SEN(45)');
    expect(Math.abs(v - 707)).toBeLessThan(2);
  });
});
