import { describe, expect, it } from 'vitest';
import {
  defaultCallRules,
  evaluarReglaDj,
  evaluarReglaDeLlamada,
  validarCallRules,
} from '../../src/services/call-rules.js';
import { WEEK_THRESHOLDS } from '../../src/services/urgency-classifier.js';

describe('defaultCallRules', () => {
  it('arranca con los umbrales CRITICO del Semaforo, para que llamar == ser critico', () => {
    const r = defaultCallRules();
    expect(r.llamarSiPctMenorA[1]).toBeNull(); // S1 no tiene banda CRITICO en el Semaforo
    expect(r.llamarSiPctMenorA[2]).toBe(WEEK_THRESHOLDS[2].criticoBelow);
    expect(r.llamarSiPctMenorA[3]).toBe(WEEK_THRESHOLDS[3].criticoBelow);
    expect(r.llamarSiPctMenorA[4]).toBe(WEEK_THRESHOLDS[4].criticoBelow);
    expect(r.nivelesQueLlaman).toEqual(['CRITICO']);
  });
});

describe('evaluarReglaDeLlamada', () => {
  const rules = defaultCallRules();

  it('dispara cuando el porcentaje cae bajo el umbral de la semana', () => {
    expect(evaluarReglaDeLlamada(rules, 3, 50, 'CRITICO')).toEqual({
      dispara: true,
      motivo: 'umbral_alcanzado',
      umbral: 80,
    });
  });

  it('no dispara si el porcentaje esta sobre el umbral', () => {
    expect(evaluarReglaDeLlamada(rules, 3, 85, 'CRITICO').dispara).toBe(false);
  });

  it('no dispara en una semana sin umbral', () => {
    expect(evaluarReglaDeLlamada(rules, 1, 0, 'CRITICO')).toMatchObject({
      dispara: false,
      motivo: 'semana_sin_umbral',
    });
  });

  it('no dispara si el nivel no esta habilitado', () => {
    expect(evaluarReglaDeLlamada(rules, 3, 0, 'ALERTA')).toMatchObject({
      dispara: false,
      motivo: 'nivel_no_habilitado',
    });
  });

  it('umbrales editados cambian CUANDO se llama, sin tocar el nivel del Semaforo', () => {
    // El nivel entra como parametro: este modulo no lo calcula ni lo puede alterar.
    const laxas = { ...rules, llamarSiPctMenorA: { ...rules.llamarSiPctMenorA, 3: 95 } };
    expect(evaluarReglaDeLlamada(laxas, 3, 90, 'CRITICO').dispara).toBe(true);
    expect(evaluarReglaDeLlamada(rules, 3, 90, 'CRITICO').dispara).toBe(false);
  });
});

describe('validarCallRules', () => {
  it('acepta un patch parcial y completa el resto con los defaults', () => {
    const r = validarCallRules({ llamarSiPctMenorA: { 2: 70 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rules.llamarSiPctMenorA[2]).toBe(70);
      expect(r.rules.llamarSiPctMenorA[3]).toBe(defaultCallRules().llamarSiPctMenorA[3]);
    }
  });

  it('acepta null como "esta semana nunca llama"', () => {
    const r = validarCallRules({ llamarSiPctMenorA: { 3: null } });
    expect(r.ok && r.rules.llamarSiPctMenorA[3]).toBeNull();
  });

  it('rechaza umbrales fuera de 0-100 y no numericos', () => {
    for (const v of [-1, 101, 'muchos', {}]) {
      expect(validarCallRules({ llamarSiPctMenorA: { 2: v } }).ok).toBe(false);
    }
  });

  it('rechaza niveles invalidos y listas vacias', () => {
    expect(validarCallRules({ nivelesQueLlaman: ['URGENTISIMO'] }).ok).toBe(false);
    expect(validarCallRules({ nivelesQueLlaman: [] }).ok).toBe(false);
  });

  it('rechaza un cuerpo que no es objeto', () => {
    expect(validarCallRules(null).ok).toBe(false);
    expect(validarCallRules('nope').ok).toBe(false);
  });
});

describe('reglas configurables de llamada DJ', () => {
  it('cambia la decisión de llamada para ALERTA sin reclasificarla', () => {
    const config = { llamarSiDiasMayorA: 3, nivelesQueLlaman: ['ALERTA'] as const };
    expect(evaluarReglaDj(true, 'ALERTA', 5).dispara).toBe(false);
    expect(
      evaluarReglaDj(true, 'ALERTA', 5, {
        ...config,
        nivelesQueLlaman: [...config.nivelesQueLlaman],
      }).dispara,
    ).toBe(true);
    expect(
      evaluarReglaDj(true, 'CRITICO', 10, { llamarSiDiasMayorA: 12, nivelesQueLlaman: ['CRITICO'] })
        .dispara,
    ).toBe(false);
  });
  it('respeta el borde estricto, la desactivación y el gate', () => {
    expect(
      evaluarReglaDj(true, 'CRITICO', 12, { llamarSiDiasMayorA: 12, nivelesQueLlaman: ['CRITICO'] })
        .dispara,
    ).toBe(false);
    expect(
      evaluarReglaDj(true, 'CRITICO', 13, { llamarSiDiasMayorA: 12, nivelesQueLlaman: ['CRITICO'] })
        .dispara,
    ).toBe(true);
    expect(
      evaluarReglaDj(true, 'CRITICO', 40, {
        llamarSiDiasMayorA: null,
        nivelesQueLlaman: ['CRITICO'],
      }).dispara,
    ).toBe(false);
    expect(evaluarReglaDj(false, 'CRITICO', 40).dispara).toBe(false);
  });
  it.each([-1, 1.5, NaN, Infinity, '3', {}, []])('rechaza el umbral DJ inválido %s', (v) => {
    expect(validarCallRules({ dj: { llamarSiDiasMayorA: v } }).ok).toBe(false);
  });
  it.each([[], ['OTRO'], 'CRITICO', null])('rechaza niveles DJ inválidos %s', (niveles) => {
    expect(validarCallRules({ dj: { nivelesQueLlaman: niveles } }).ok).toBe(false);
  });
  it('los cambios parciales de B conservan A y permiten restaurar/desactivar B', () => {
    const current = defaultCallRules();
    current.llamarSiPctMenorA[2] = 70;
    const result = validarCallRules({ dj: { llamarSiDiasMayorA: null } }, current);
    expect(result.ok && result.rules.llamarSiPctMenorA[2]).toBe(70);
    expect(result.ok && result.rules.dj.llamarSiDiasMayorA).toBeNull();
    expect(current.dj.llamarSiDiasMayorA).toBe(7);
  });
});
