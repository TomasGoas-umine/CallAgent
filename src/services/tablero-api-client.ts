/**
 * Interfaz del cliente de tablero-api (el "Semaforo").
 *
 * Contrato real de `GET /tablero/search`, verificado contra prod el 2026-09-09 — ver
 * docs/SEMAFORO_INTEGRACION.md §6. El sobre es `{ items, total, nextCursor, hasMore }`.
 * NO es `{ data }`, y `nextCursor` NO es siempre null: la paginacion existe y hay que
 * seguirla o se pierde la mayor parte del dataset.
 *
 * Dos implementaciones:
 *  - `FixtureTableroApiClient` — `test/fixtures/tablero_search_sample.json`. Es la
 *    implementacion DEFAULT (`TABLERO_API_MODE=fixture`), y la unica que trae telefono
 *    (sintetico).
 *  - `HttpTableroApiClient` — pega al API real. Requiere `TABLERO_API_MODE=http`.
 */

import type { TableroRecord, TableroSearchFilters } from '../domain/candidate.js';
import type { CallRules } from './call-rules.js';

export interface TableroSearchResult {
  records: TableroRecord[];
  /** Paginas efectivamente leidas (el fixture siempre devuelve 1). */
  paginas: number;
  /** `true` si se corto por el tope de paginas y quedo dataset sin leer. */
  truncado: boolean;
}

export interface TableroApiClient {
  /** Disponible solo en el banco Mock editable; nunca en HTTP ni fixtures congelados. */
  getTestCallRules?(): CallRules;
  search(filters: TableroSearchFilters): Promise<TableroSearchResult>;
}
