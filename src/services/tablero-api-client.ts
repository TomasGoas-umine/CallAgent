/**
 * Interfaz del cliente de tablero-api (el "Semaforo"). Ver docs/context/PROJECT_CONTEXT.md
 * para los hechos de la auditoria (paginacion rota, auth debil, sin campo de telefono).
 *
 * Dos implementaciones:
 *  - FixtureTableroApiClient (tablero-api-client.fixture.ts): usa test/fixtures/tablero_search_sample.json.
 *    Es la implementacion DEFAULT en esta sesion (TABLERO_API_MODE=fixture).
 *  - HttpTableroApiClient (tablero-api-client.http.ts): pega a la URL real configurada por .env.
 *    Construida y lista, pero NO se activa por defecto (requiere TABLERO_API_MODE=http +
 *    decision de negocio confirmada sobre a quien llamar, ver docs/architecture/DECISIONS.md).
 */

import type { TableroRecord, TableroSearchFilters } from '../domain/candidate.js';

export interface TableroApiClient {
  search(filters: TableroSearchFilters): Promise<TableroRecord[]>;
}
