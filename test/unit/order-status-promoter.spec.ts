import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  promoteOrderStatus,
  groupOrders,
  DEAD_ESTADOS,
  MANUAL_ESTADOS,
} from '../../src/services/order-status-promoter.js';
import type { TableroRecord } from '../../src/domain/candidate.js';

const FIXED_TODAY = new Date('2026-08-13T12:00:00.000Z');

function record(overrides: Partial<TableroRecord> = {}): TableroRecord {
  return {
    client_name: 'Empresa Ejemplo SpA',
    client_id: 'cust_ejemplo123',
    course_name: 'Curso Prevencion de Riesgos',
    order_number: '2109700',
    init_course: '2026-07-15',
    end_course: '2026-08-15',
    rut: '12345678-9',
    sence_connections: 0,
    enrolled_count: 3,
    order_status: '',
    student_email: 'alumno@correo.cl',
    first_name: 'Juan',
    last_name: 'Ejemplo',
    updated_at: '2026-08-10T09:30:00.000Z',
    ...overrides,
  };
}

describe('promoteOrderStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('respeta estados muertos sin promover (DEAD_ESTADOS)', () => {
    for (const estado of DEAD_ESTADOS) {
      const r = record({ order_status: estado, end_course: '2026-01-01' });
      expect(promoteOrderStatus(r)).toBe(estado);
    }
  });

  it('respeta estados manuales sin promover (MANUAL_ESTADOS)', () => {
    for (const estado of MANUAL_ESTADOS) {
      const r = record({ order_status: estado, end_course: '2026-01-01' });
      expect(promoteOrderStatus(r)).toBe(estado);
    }
  });

  it('promueve a OBTENIENDO DJ si end_course ya paso', () => {
    const r = record({ order_status: '', end_course: '2026-08-01', init_course: '2026-07-01' });
    expect(promoteOrderStatus(r)).toBe('OBTENIENDO DJ');
  });

  it('promueve a CURSO EN OPERACIÓN si init_course ya paso pero end_course no', () => {
    const r = record({ order_status: '', init_course: '2026-08-01', end_course: '2026-09-01' });
    expect(promoteOrderStatus(r)).toBe('CURSO EN OPERACIÓN');
  });

  it('promueve a NO INICIADA si init_course es futuro', () => {
    const r = record({ order_status: '', init_course: '2026-09-01', end_course: '2026-10-01' });
    expect(promoteOrderStatus(r)).toBe('NO INICIADA');
  });

  it('devuelve el order_status original si las fechas son invalidas', () => {
    const r = record({ order_status: 'ALGO_RARO', init_course: 'bad', end_course: 'bad' });
    expect(promoteOrderStatus(r)).toBe('ALGO_RARO');
  });
});

describe('groupOrders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('agrupa varios alumnos del mismo curso y agrega sence_connections/enrolled_count', () => {
    const records = [
      record({ client_id: 'c1', order_number: '100', enrolled_count: 1, sence_connections: 1 }),
      record({ client_id: 'c1', order_number: '100', enrolled_count: 1, sence_connections: 0 }),
      record({ client_id: 'c1', order_number: '100', enrolled_count: 1, sence_connections: 0 }),
    ];
    const groups = groupOrders(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.enrolledCount).toBe(3);
    expect(groups[0]?.totalConnections).toBe(1);
    expect(groups[0]?.pctConexion).toBeCloseTo(33.33, 1);
  });

  it('excluye OCs internacionales (order_number empieza con INT)', () => {
    const records = [record({ order_number: 'INT-500' })];
    expect(groupOrders(records)).toHaveLength(0);
  });

  it('excluye grupos cuyo order_status promovido esta en INACTIVE_STATUSES', () => {
    const records = [record({ order_status: 'REVISAR', end_course: '2026-01-01' })];
    expect(groupOrders(records)).toHaveLength(0);
  });

  it('corre promoteOrderStatus antes de agregar, evitando falsos positivos con order_status vacio', () => {
    // order_status vacio + end_course futuro => promovido a NO INICIADA / CURSO EN OPERACION,
    // nunca cae en INACTIVE_STATUSES por error de comparar '' directamente.
    const records = [
      record({ order_status: '', init_course: '2026-09-01', end_course: '2026-10-01' }),
    ];
    const groups = groupOrders(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.promotedOrderStatus).toBe('NO INICIADA');
  });

  it('separa distintos client_id + order_number en grupos distintos', () => {
    const records = [
      record({ client_id: 'c1', order_number: '100' }),
      record({ client_id: 'c2', order_number: '100' }),
      record({ client_id: 'c1', order_number: '200' }),
    ];
    expect(groupOrders(records)).toHaveLength(3);
  });
});
