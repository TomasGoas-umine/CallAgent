import { describe, expect, it, afterEach, vi } from 'vitest';
import { FixtureTableroApiClient } from '../../src/services/tablero-api-client.fixture.js';
import { groupOrders } from '../../src/services/order-status-promoter.js';
import { getCourseWeek, clasificarConexion } from '../../src/services/urgency-classifier.js';
import { FIXTURE_REFERENCE_NOW } from '../fixtures/reference-time.js';

describe('FixtureTableroApiClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carga el fixture y devuelve registros con la forma de TableroRecord', async () => {
    const client = new FixtureTableroApiClient();
    const records = await client.search({ seccion: 'A_RIESGO_CONEXION' });
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toHaveProperty('client_id');
    expect(records[0]).toHaveProperty('order_number');
  });

  it('incluye al menos un candidato con phone_test_only y otro sin telefono', async () => {
    const client = new FixtureTableroApiClient();
    const records = await client.search({});
    expect(records.some((r) => r.phone_test_only)).toBe(true);
    expect(records.some((r) => !r.phone_test_only)).toBe(true);
  });

  it('al agrupar y clasificar, reproduce los niveles NORMAL/ALERTA/CRITICO esperados por grupo', async () => {
    // Las fechas de los grupos SINTETICOS del fixture fueron disenadas alrededor de
    // FIXTURE_REFERENCE_NOW con bandas de 21 dias de margen (ver scripts que generaron el
    // fixture). Se pinea el reloj a esa referencia para que el test sea determinista sin
    // importar cuando se ejecute en el futuro — igual que se documenta en test/fixtures/README.md.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));

    const client = new FixtureTableroApiClient();
    const records = await client.search({});
    const groups = groupOrders(records);
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      const semana = getCourseWeek(group.initCourse, group.endCourse);
      const nivel = clasificarConexion(semana, group.pctConexion);
      const sample = group.records[0] as unknown as { _fixture_esperado_nivel?: string };
      if (sample?._fixture_esperado_nivel) {
        expect(nivel).toBe(sample._fixture_esperado_nivel);
      }
    }
  });
});
