import { describe, expect, it } from 'vitest';
import { computeIdempotencyKey, isoWeekWindow } from '../../src/services/idempotency.js';

describe('computeIdempotencyKey', () => {
  it('es determinista para los mismos inputs en la misma semana', () => {
    const now = new Date('2026-08-13T10:00:00Z');
    const a = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'riesgo_conexion_critico',
      orderNumber: '100',
      now,
    });
    const b = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'riesgo_conexion_critico',
      orderNumber: '100',
      now: new Date('2026-08-14T22:00:00Z'), // misma semana ISO
    });
    expect(a).toBe(b);
  });

  it('cambia si cambia el destinatario, motivo u orderNumber', () => {
    const now = new Date('2026-08-13T10:00:00Z');
    const base = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'riesgo_conexion_critico',
      orderNumber: '100',
      now,
    });
    expect(
      computeIdempotencyKey({
        destinatario: '+56900000002',
        motivo: 'riesgo_conexion_critico',
        orderNumber: '100',
        now,
      }),
    ).not.toBe(base);
    expect(
      computeIdempotencyKey({
        destinatario: '+56900000001',
        motivo: 'otro_motivo',
        orderNumber: '100',
        now,
      }),
    ).not.toBe(base);
    expect(
      computeIdempotencyKey({
        destinatario: '+56900000001',
        motivo: 'riesgo_conexion_critico',
        orderNumber: '200',
        now,
      }),
    ).not.toBe(base);
  });

  it('cambia entre semanas distintas (permite un nuevo intento la semana siguiente)', () => {
    const week1 = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'riesgo_conexion_critico',
      orderNumber: '100',
      now: new Date('2026-08-13T10:00:00Z'),
    });
    const week2 = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'riesgo_conexion_critico',
      orderNumber: '100',
      now: new Date('2026-08-20T10:00:00Z'),
    });
    expect(week1).not.toBe(week2);
  });

  it('produce siempre un hash hex sha256 (64 caracteres)', () => {
    const key = computeIdempotencyKey({
      destinatario: '+56900000001',
      motivo: 'x',
      orderNumber: '1',
      now: new Date(),
    });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('isoWeekWindow', () => {
  it('devuelve el mismo valor para fechas dentro de la misma semana ISO', () => {
    expect(isoWeekWindow(new Date('2026-08-10T00:00:00Z'))).toBe(
      isoWeekWindow(new Date('2026-08-16T23:59:59Z')),
    );
  });
});
