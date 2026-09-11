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
      nombre_interlocutor: 'el encargado de capacitacion',
      dias_restantes: '',
      pct_conexion: '',
    });
    const now = new Date('2026-09-10T16:00:00Z');
    expect(courseDaysRemaining('2026-09-10', now)).toBe(0);
    expect(courseDaysRemaining('2026-09-09', now)).toBe(-1);
    expect(courseDaysRemaining('2026-09-13', now)).toBe(3);
  });
});
