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

  it('cuenta inscritos por CANTIDAD de registros, no por un campo del API', () => {
    // No existe `enrolled_count` en tablero-api: los inscritos se cuentan (useSenceData.ts:169).
    const records = [
      record({ client_id: 'c1', order_number: '100', sence_connections: 1 }),
      record({ client_id: 'c1', order_number: '100', sence_connections: 0 }),
      record({ client_id: 'c1', order_number: '100', sence_connections: 0 }),
    ];
    const { groups } = groupOrders(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.enrolledCount).toBe(3);
    expect(groups[0]?.totalConnections).toBe(1);
    expect(groups[0]?.pctConexion).toBeCloseTo(33.33, 1);
  });

  it('cuenta sence_connections === 1, nunca > 0 ni una suma', () => {
    // Un valor distinto de 1 no cuenta como conectado — el Semaforo compara `=== 1`.
    const records = [
      record({ client_id: 'c1', order_number: '100', sence_connections: 1 }),
      record({ client_id: 'c1', order_number: '100', sence_connections: 2 }),
      record({ client_id: 'c1', order_number: '100', sence_connections: 0 }),
    ];
    const { groups } = groupOrders(records);
    expect(groups[0]?.enrolledCount).toBe(3);
    expect(groups[0]?.totalConnections).toBe(1);
  });

  it('descarta DEAD_ESTADOS antes de agregar, sin inflar los inscritos', () => {
    // En prod FACTURADA es la mayoria de los registros: si entra, hunde el pct de la OC.
    const records = [
      record({ client_id: 'c1', order_number: '100', sence_connections: 1 }),
      record({ client_id: 'c1', order_number: '100', order_status: 'FACTURADA' }),
      record({ client_id: 'c1', order_number: '100', order_status: 'BAJA' }),
    ];
    const { groups, stats } = groupOrders(records);
    expect(groups[0]?.enrolledCount).toBe(1);
    expect(groups[0]?.pctConexion).toBe(100);
    expect(stats.registrosDescartados.estadoMuerto).toBe(2);
  });

  it('registra alumnos REVISAR en el grupo pero no los cuenta como inscritos', () => {
    const records = [
      record({ client_id: 'c1', order_number: '100', sence_connections: 1 }),
      record({ client_id: 'c1', order_number: '100', order_status: 'REVISAR' }),
    ];
    const { groups, stats } = groupOrders(records);
    expect(groups[0]?.enrolledCount).toBe(1);
    expect(groups[0]?.records).toHaveLength(2);
    expect(stats.registrosDescartados.alumnoInactivo).toBe(1);
  });

  it('excluye OCs internacionales (order_number empieza con INT)', () => {
    const { groups, stats } = groupOrders([record({ order_number: 'INT-500' })]);
    expect(groups).toHaveLength(0);
    expect(stats.registrosDescartados.ocExcluida).toBe(1);
  });

  it('una OC enteramente REVISAR conserva ese estado, no queda con estado vacio', () => {
    // Vaciarlo la haria pasar por "en ejecucion" en el gate de seccion A (estado === '').
    const { groups } = groupOrders([record({ order_status: 'REVISAR', end_course: '2026-01-01' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.enrolledCount).toBe(0);
    expect(groups[0]?.promotedOrderStatus).toBe('REVISAR');
  });

  it('corre promoteOrderStatus antes de agregar, evitando falsos positivos con order_status vacio', () => {
    // order_status vacio + end_course futuro => promovido a NO INICIADA / CURSO EN OPERACION,
    // nunca cae en INACTIVE_STATUSES por error de comparar '' directamente.
    const records = [
      record({ order_status: '', init_course: '2026-09-01', end_course: '2026-10-01' }),
    ];
    const { groups } = groupOrders(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.promotedOrderStatus).toBe('NO INICIADA');
  });

  it('separa distintos client_id + order_number en grupos distintos', () => {
    const records = [
      record({ client_id: 'c1', order_number: '100' }),
      record({ client_id: 'c2', order_number: '100' }),
      record({ client_id: 'c1', order_number: '200' }),
    ];
    expect(groupOrders(records).groups).toHaveLength(3);
  });
});
