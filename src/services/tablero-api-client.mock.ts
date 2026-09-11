/**
 * MockTableroApiClient — sirve el Tablero Mock EDITABLE (`mock-tablero-store.ts`) con la misma
 * interfaz que el cliente HTTP real.
 *
 * Reemplaza a `FixtureTableroApiClient` como implementacion de `TABLERO_API_MODE=fixture`, y es
 * importante que asi sea: `originateManualCall` y `dispatchFollowup` revalidan el curso contra
 * `buildTableroApiClient()` justo antes de llamar. Si esa revalidacion leyera el JSON del
 * fixture en vez del store editado, una OC recien editada a critica seria rechazada con
 * `curso_no_critico` y el disparo del Mock no funcionaria nunca.
 *
 * `FixtureTableroApiClient` sigue existiendo y se usa directamente en los tests, donde interesa
 * el JSON congelado (con su variedad de telefonos y su caso `do_not_call`) y no el store mutable.
 */

import type { TableroApiClient, TableroSearchResult } from './tablero-api-client.js';
import type { TableroSearchFilters } from '../domain/candidate.js';
import { getCallRules, toTableroRecords } from './mock-tablero-store.js';

export class MockTableroApiClient implements TableroApiClient {
  getTestCallRules() {
    return getCallRules();
  }
  async search(_filters: TableroSearchFilters): Promise<TableroSearchResult> {
    return { records: toTableroRecords(), paginas: 1, truncado: false };
  }
}
