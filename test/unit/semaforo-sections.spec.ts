import { describe, expect, it } from 'vitest';
import {
  diasDesdeElCierre,
  diasEsperandoAlOtic,
  gateSeccionA,
  gateSeccionB,
  gateSeccionC,
} from '../../src/services/semaforo-sections.js';
import type { OrderGroup } from '../../src/services/order-status-promoter.js';

const AHORA = Date.UTC(2026, 8, 9); // 2026-09-09

function group(overrides: Partial<OrderGroup> = {}): OrderGroup {
  return {
    clientId: 'c1',
    clientName: 'CLIENTE A1',
    orderNumber: '2109700',
    courseName: 'Curso Ejemplo',
    otic: 'OTIC EJEMPLO',
    initCourse: '2026-09-01',
    endCourse: '2026-09-30',
    promotedOrderStatus: 'CURSO EN OPERACIÓN',
    enrolledCount: 10,
    totalConnections: 2,
    pctConexion: 20,
    djCount: 0,
    lastUpdatedAt: '2026-09-08T00:00:00.000Z',
    records: [],
    ...overrides,
  };
}

describe('gateSeccionA', () => {
  it('incluye una OC en operacion, no terminada y con conexion incompleta', () => {
    expect(gateSeccionA(group(), AHORA)).toEqual({ incluido: true });
  });

  it('acepta EJECUCION ademas de OPERACION', () => {
    expect(gateSeccionA(group({ promotedOrderStatus: 'EN EJECUCION' }), AHORA).incluido).toBe(true);
  });

  it('acepta el estado vacio (el Semaforo prefiere mostrar antes que esconder)', () => {
    expect(gateSeccionA(group({ promotedOrderStatus: '' }), AHORA).incluido).toBe(true);
  });

  it('descarta una OC que no esta en ejecucion', () => {
    expect(gateSeccionA(group({ promotedOrderStatus: 'OBTENIENDO DJ' }), AHORA)).toEqual({
      incluido: false,
      motivo: 'no_en_ejecucion',
    });
    expect(gateSeccionA(group({ promotedOrderStatus: 'NO INICIADA' }), AHORA).incluido).toBe(false);
    expect(gateSeccionA(group({ promotedOrderStatus: 'REVISAR' }), AHORA).incluido).toBe(false);
  });

  it('descarta un curso ya terminado — ese caso vive en la seccion B (Riesgo DJ)', () => {
    // Es el gate que faltaba: sin el, un curso cerrado con conexion baja se clasifica CRITICO
    // por semana 4 y se convierte en candidato a llamada.
    expect(
      gateSeccionA(group({ endCourse: '2026-08-01', promotedOrderStatus: '' }), AHORA),
    ).toEqual({ incluido: false, motivo: 'curso_terminado' });
  });

  it('descarta una OC con conexion completa', () => {
    expect(gateSeccionA(group({ pctConexion: 100 }), AHORA)).toEqual({
      incluido: false,
      motivo: 'conexion_completa',
    });
  });

  it('considera NO terminado un curso sin fecha de termino', () => {
    expect(gateSeccionA(group({ endCourse: '' }), AHORA).incluido).toBe(true);
  });
});

/**
 * Seccion B - Riesgo DJ (`StatusCursosPage.tsx:582-596` + el filtro de `L619`). Nada que ver con
 * la conexion: aca la pregunta es cuanto lleva el curso CERRADO sin que llegue la DJ.
 */
describe('gateSeccionB', () => {
  /** Curso cerrado hace 10 dias, 2 conectados y ninguna DJ: el caso central de la seccion. */
  const cerrado = (overrides: Partial<OrderGroup> = {}) =>
    group({
      endCourse: '2026-08-30',
      promotedOrderStatus: 'OBTENIENDO DJ',
      totalConnections: 2,
      djCount: 0,
      ...overrides,
    });

  it('incluye un curso cerrado hace mas de 3 dias con conectados sin DJ', () => {
    expect(gateSeccionB(cerrado(), AHORA)).toEqual({ incluido: true });
  });

  it('descarta un curso que todavia no termino — ese caso vive en la seccion A', () => {
    expect(gateSeccionB(cerrado({ endCourse: '2026-09-30' }), AHORA)).toEqual({
      incluido: false,
      motivo: 'curso_no_terminado',
    });
    // Sin fecha de termino tampoco hay cierre del que contar dias.
    expect(gateSeccionB(cerrado({ endCourse: '' }), AHORA).incluido).toBe(false);
  });

  it('descarta una OC sin ningun conectado: no hay DJ que reclamar', () => {
    // Sin este gate el porcentaje seria 0/0 y toda OC cerrada y vacia entraria como critica.
    expect(gateSeccionB(cerrado({ totalConnections: 0 }), AHORA)).toEqual({
      incluido: false,
      motivo: 'sin_conectados',
    });
  });

  it('descarta una OC con la DJ completa', () => {
    expect(gateSeccionB(cerrado({ djCount: 2 }), AHORA)).toEqual({
      incluido: false,
      motivo: 'dj_completa',
    });
  });

  it('respeta los 3 dias de gracia desde el cierre', () => {
    // Cerro ayer: la DJ todavia puede estar en camino.
    expect(gateSeccionB(cerrado({ endCourse: '2026-09-08' }), AHORA)).toEqual({
      incluido: false,
      motivo: 'cierre_reciente',
    });
  });

  it('el denominador son los CONECTADOS, no los inscritos', () => {
    // 10 inscritos, 2 conectados, 2 DJ: la DJ esta completa aunque 8 inscritos no tengan ninguna.
    expect(
      gateSeccionB(cerrado({ enrolledCount: 10, totalConnections: 2, djCount: 2 }), AHORA),
    ).toEqual({ incluido: false, motivo: 'dj_completa' });
  });
});

/** Seccion C - Rectificacion (`StatusCursosPage.tsx:626-660`). */
describe('gateSeccionC', () => {
  const esperando = (overrides: Partial<OrderGroup> = {}) =>
    group({
      promotedOrderStatus: 'ESPERA OC FINAL',
      lastUpdatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    });

  it('incluye una OC esperando la OC Final hace mas de 3 dias', () => {
    expect(gateSeccionC(esperando(), AHORA)).toEqual({ incluido: true });
  });

  it('acepta tambien los estados de rectificacion', () => {
    expect(
      gateSeccionC(esperando({ promotedOrderStatus: 'EN RECTIFICACION' }), AHORA).incluido,
    ).toBe(true);
  });

  it('descarta cualquier otro estado', () => {
    expect(gateSeccionC(esperando({ promotedOrderStatus: 'CURSO EN OPERACIÓN' }), AHORA)).toEqual({
      incluido: false,
      motivo: 'estado_no_espera_oc_final',
    });
  });

  it('respeta los 3 dias de gracia para que conteste el OTIC', () => {
    expect(gateSeccionC(esperando({ lastUpdatedAt: '2026-09-08T00:00:00.000Z' }), AHORA)).toEqual({
      incluido: false,
      motivo: 'espera_reciente',
    });
  });

  it('sin fecha de actualizacion no se puede afirmar que lleve esperando: queda fuera', () => {
    expect(gateSeccionC(esperando({ lastUpdatedAt: '' }), AHORA).incluido).toBe(false);
  });
});

describe('dias', () => {
  it('cuenta los dias desde el cierre, negativos si el curso sigue corriendo', () => {
    expect(diasDesdeElCierre('2026-08-30', AHORA)).toBe(10);
    expect(diasDesdeElCierre('2026-09-30', AHORA)).toBe(-21);
    // Sin fecha no se inventa una antiguedad.
    expect(diasDesdeElCierre('', AHORA)).toBe(0);
  });

  it('cuenta los dias esperando al OTIC y nunca devuelve negativos', () => {
    expect(diasEsperandoAlOtic('2026-08-01T00:00:00.000Z', AHORA)).toBe(39);
    // Un `updated_at` en el futuro (reloj desincronizado) no puede dar dias negativos.
    expect(diasEsperandoAlOtic('2026-10-01T00:00:00.000Z', AHORA)).toBe(0);
  });
});
