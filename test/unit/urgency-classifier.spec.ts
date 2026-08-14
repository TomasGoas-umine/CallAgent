import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  getCourseWeek,
  clasificarConexion,
  WEEK_THRESHOLDS,
} from '../../src/services/urgency-classifier.js';

// "now" fijo para poder construir fechas de inicio/termino con un progreso exacto conocido.
const FIXED_NOW = new Date('2026-08-13T12:00:00.000Z');

function datesForProgress(progress: number, totalDays = 28): { init: string; end: string } {
  const totalMs = totalDays * 24 * 60 * 60 * 1000;
  const startMs = FIXED_NOW.getTime() - progress * totalMs;
  const endMs = startMs + totalMs;
  return { init: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

describe('getCourseWeek', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('devuelve semana 1 cuando el progreso es < 25%', () => {
    const { init, end } = datesForProgress(0.1);
    expect(getCourseWeek(init, end)).toBe(1);
  });

  it('devuelve semana 2 cuando el progreso esta entre 25% y 50%', () => {
    const { init, end } = datesForProgress(0.3);
    expect(getCourseWeek(init, end)).toBe(2);
  });

  it('devuelve semana 3 cuando el progreso esta entre 50% y 75%', () => {
    const { init, end } = datesForProgress(0.6);
    expect(getCourseWeek(init, end)).toBe(3);
  });

  it('devuelve semana 4 cuando el progreso es >= 75%', () => {
    const { init, end } = datesForProgress(0.9);
    expect(getCourseWeek(init, end)).toBe(4);
  });

  it('devuelve semana 1 si las fechas son invalidas o end <= start', () => {
    expect(getCourseWeek('not-a-date', '2026-08-13')).toBe(1);
    expect(getCourseWeek('2026-08-13', '2026-08-01')).toBe(1);
  });
});

describe('clasificarConexion — umbrales exactos de la hoja de ruta', () => {
  it('Semana 1: expected 20%, nunca CRITICO (criticoBelow=-1)', () => {
    expect(WEEK_THRESHOLDS[1].expected).toBe(20);
    expect(clasificarConexion(1, 25)).toBe('NORMAL');
    expect(clasificarConexion(1, 20)).toBe('NORMAL');
    expect(clasificarConexion(1, 0)).toBe('ALERTA');
    expect(clasificarConexion(1, 19.9)).toBe('ALERTA');
  });

  it('Semana 2: expected 60%, umbral critico 55%', () => {
    expect(WEEK_THRESHOLDS[2].expected).toBe(60);
    expect(WEEK_THRESHOLDS[2].criticoBelow).toBe(55);
    expect(clasificarConexion(2, 70)).toBe('NORMAL');
    expect(clasificarConexion(2, 60)).toBe('NORMAL');
    expect(clasificarConexion(2, 57)).toBe('ALERTA');
    expect(clasificarConexion(2, 55)).toBe('ALERTA');
    expect(clasificarConexion(2, 40)).toBe('CRITICO');
    expect(clasificarConexion(2, 54.9)).toBe('CRITICO');
  });

  it('Semana 3: expected 90%, umbral critico 80%', () => {
    expect(WEEK_THRESHOLDS[3].expected).toBe(90);
    expect(WEEK_THRESHOLDS[3].criticoBelow).toBe(80);
    expect(clasificarConexion(3, 95)).toBe('NORMAL');
    expect(clasificarConexion(3, 85)).toBe('ALERTA');
    expect(clasificarConexion(3, 70)).toBe('CRITICO');
    expect(clasificarConexion(3, 0)).toBe('CRITICO');
  });

  it('Semana 4: expected 98%, umbral critico 90%', () => {
    expect(WEEK_THRESHOLDS[4].expected).toBe(98);
    expect(WEEK_THRESHOLDS[4].criticoBelow).toBe(90);
    expect(clasificarConexion(4, 99)).toBe('NORMAL');
    expect(clasificarConexion(4, 93)).toBe('ALERTA');
    expect(clasificarConexion(4, 80)).toBe('CRITICO');
  });

  it('cae a la semana 4 (fallback) para valores de semana fuera de rango', () => {
    // @ts-expect-error — probar el fallback `?? WEEK_THRESHOLDS[4]` deliberadamente con valor invalido
    expect(clasificarConexion(5, 99)).toBe('NORMAL');
  });
});
