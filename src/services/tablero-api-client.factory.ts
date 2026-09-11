/**
 * Factory del cliente que usan los caminos que PUEDEN LLAMAR (evaluador, disparo manual,
 * dispatcher). Default `fixture` → el Tablero Mock editable.
 *
 * ⚠️ El Tablero Original NO pasa por aca. Construye su `HttpTableroApiClient` por su cuenta en
 * `api-routes.ts` y ese cliente no toca ningun camino de originacion. Es lo que garantiza que
 * los dos modos no se mezclen: el dato real solo se lee para mostrarlo, nunca para llamar.
 */

import { env } from '../utils/env.js';
import type { TableroApiClient } from './tablero-api-client.js';
import { MockTableroApiClient } from './tablero-api-client.mock.js';
import { HttpTableroApiClient } from './tablero-api-client.http.js';

export function buildTableroApiClient(): TableroApiClient {
  if (env.tableroApiMode === 'http') {
    return new HttpTableroApiClient(env.tableroApiBaseUrl, env.tableroApiToken);
  }
  // Store editable en memoria, sembrado del fixture. Debe ser el mismo que ve la revalidacion
  // previa a llamar, o una OC recien editada seria rechazada como `curso_no_critico`.
  return new MockTableroApiClient();
}
