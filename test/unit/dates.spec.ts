import { describe, expect, it } from 'vitest';
import { normalizeCourseDate, normalizeTimestamp, toEpochMs } from '../../src/utils/dates.js';

/**
 * Los casos con numero real salen del snapshot anonimizado de prod
 * (test/fixtures/tablero_search_real_anonymized.json): ahi `updated_at` llega como ISO en 534
 * registros y como epoch en milisegundos en 267. Sin normalizar, `new Date(1778687999271)`
 * funciona pero `new Date('1778687999271')` da Invalid Date.
 */
describe('toEpochMs', () => {
  it('acepta epoch en milisegundos como number', () => {
    expect(toEpochMs(1778687999271)).toBe(1778687999271);
  });

  it('acepta epoch en milisegundos venido como string numerico', () => {
    expect(toEpochMs('1778687999271')).toBe(1778687999271);
  });

  it('interpreta un epoch de 10 digitos como segundos', () => {
    expect(toEpochMs(1778687999)).toBe(1778687999000);
  });

  it('acepta ISO 8601 completo', () => {
    expect(toEpochMs('2026-09-09T14:13:47.175Z')).toBe(Date.parse('2026-09-09T14:13:47.175Z'));
  });

  it('ancla YYYY-MM-DD a medianoche UTC, sin depender del huso del proceso', () => {
    expect(toEpochMs('2026-08-06')).toBe(Date.UTC(2026, 7, 6));
  });

  it('devuelve null (nunca NaN) ante basura', () => {
    for (const v of ['', '  ', 'bad', null, undefined, {}, [], NaN, Infinity]) {
      expect(toEpochMs(v)).toBeNull();
    }
  });

  it('rechaza fechas fuera de rango plausible en vez de propagarlas', () => {
    expect(toEpochMs(1)).toBeNull(); // 1970 en segundos
    expect(toEpochMs('3999-01-01T00:00:00.000Z')).toBeNull();
  });
});

describe('normalizeCourseDate', () => {
  it('deja YYYY-MM-DD tal cual', () => {
    expect(normalizeCourseDate('2026-08-06')).toBe('2026-08-06');
  });

  it('recorta un ISO con hora al dia', () => {
    expect(normalizeCourseDate('2026-08-06T23:30:00.000Z')).toBe('2026-08-06');
  });

  it('convierte epoch a dia', () => {
    expect(normalizeCourseDate(Date.UTC(2026, 7, 6))).toBe('2026-08-06');
  });

  it('devuelve cadena vacia ante basura — el mismo valor que usa el Semaforo', () => {
    // useSenceData.ts:146 pone '' cuando el campo falta; getCourseWeek entonces cae en semana 1.
    expect(normalizeCourseDate('bad')).toBe('');
    expect(normalizeCourseDate(null)).toBe('');
  });
});

describe('normalizeTimestamp', () => {
  it('normaliza epoch numerico a ISO', () => {
    expect(normalizeTimestamp(1778687999271)).toBe(new Date(1778687999271).toISOString());
  });

  it('deja un ISO valido en ISO', () => {
    expect(normalizeTimestamp('2026-09-09T14:13:47.175Z')).toBe('2026-09-09T14:13:47.175Z');
  });

  it('devuelve null ante basura', () => {
    expect(normalizeTimestamp('bad')).toBeNull();
  });
});
