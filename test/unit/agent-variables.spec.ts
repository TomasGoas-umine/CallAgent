import { describe, expect, it } from 'vitest';
import { buildAgentDynamicVariables } from '../../src/services/agent-variables.js';
import { courseDaysRemaining } from '../../src/utils/dates.js';

const input = {
  clientName: 'Empresa',
  courseName: 'Excel',
  orderNumber: 'OC-1',
  motivo: 'riesgo_conexion_critico',
};

describe('datos conversacionales', () => {
  it.each([
    [3, 'aún figura pendiente la ejecución del curso Excel y quedan 3 días de curso.'],
    [1, 'aún figura pendiente la ejecución del curso Excel y queda un día de curso.'],
    [0, 'aún figura pendiente la ejecución del curso Excel y el curso termina hoy.'],
    [-2, 'el curso Excel terminó y aún figura pendiente su ejecución.'],
    [undefined, 'aún figura pendiente la ejecución del curso Excel.'],
    [NaN, 'aún figura pendiente la ejecución del curso Excel.'],
    [Infinity, 'aún figura pendiente la ejecución del curso Excel.'],
    [1.5, 'aún figura pendiente la ejecución del curso Excel.'],
  ])('la apertura de conexión expresa el plazo %s sin inventar fechas', (days, expected) => {
    expect(
      buildAgentDynamicVariables({ ...input, pctConexion: 12.5, diasRestantes: days })
        .resumen_seguimiento,
    ).toBe(expected);
  });

  it('anuncia declaraciones pendientes aunque las conexiones estén completas', () => {
    expect(
      buildAgentDynamicVariables({
        ...input,
        motivo: 'riesgo_dj_critico',
        diasRestantes: -10,
        pctConexion: 100,
        djPendientes: 6,
      }).resumen_seguimiento,
    ).toBe('aún figura pendiente hacer la declaración jurada del curso Excel, que ya terminó.');
  });

  it.each([
    { courseName: '' },
    { courseName: 'NO_DISPONIBLE' },
    { courseName: '{{curso}}' },
    { motivo: 'otro_motivo' },
    { pctConexion: 100 },
    { pctConexion: 101 },
    { pctConexion: -1 },
    { pctConexion: NaN },
    { pctConexion: undefined },
    { motivo: 'riesgo_dj_critico', diasRestantes: 0, djPendientes: 6 },
    { motivo: 'riesgo_dj_critico', diasRestantes: 3, djPendientes: 6 },
    { motivo: 'riesgo_dj_critico', diasRestantes: undefined, djPendientes: 6 },
    { motivo: 'riesgo_dj_critico', diasRestantes: -10, djPendientes: 0 },
    { motivo: 'riesgo_dj_critico', diasRestantes: -10, djPendientes: undefined },
    { motivo: 'riesgo_dj_critico', diasRestantes: -10, djPendientes: 1.5 },
  ])('usa una apertura neutra ante contexto insuficiente o inconsistente: %j', (overrides) => {
    expect(
      buildAgentDynamicVariables({ ...input, pctConexion: 12.5, diasRestantes: 3, ...overrides })
        .resumen_seguimiento,
    ).toBe('estamos dando seguimiento a tu curso.');
  });

  it.each([
    [12.5, '12.5%'],
    [55.00000000000001, '55%'],
    [99.6, '99.6%'],
    [99.9999999, '99.999999%'],
    [100, '100%'],
    [0, '0%'],
  ])('conserva el porcentaje %s sin simular conexión completa', (value, expected) => {
    expect(
      buildAgentDynamicVariables({ ...input, pctConexion: value as number }).pct_conexion,
    ).toBe(expected);
  });
  it('los datos faltantes no se transforman en fecha de hoy ni números inválidos', () => {
    expect(
      buildAgentDynamicVariables({
        ...input,
        contactoNombre: ' ',
        diasRestantes: courseDaysRemaining(''),
        pctConexion: NaN,
      }),
    ).toMatchObject({
      nombre_interlocutor: 'responsable de capacitación',
      dias_restantes: '',
      pct_conexion: '',
    });
    const now = new Date('2026-09-10T16:00:00Z');
    expect(courseDaysRemaining('2026-09-10', now)).toBe(0);
    expect(courseDaysRemaining('2026-09-09', now)).toBe(-1);
    expect(courseDaysRemaining('2026-09-13', now)).toBe(3);
  });
});
