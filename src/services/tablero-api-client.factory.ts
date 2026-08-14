/**
 * Factory que elige la implementacion de TableroApiClient segun TABLERO_API_MODE
 * (prompt §6 — default 'fixture', 'http' requiere activacion explicita).
 */

import { env } from '../utils/env.js';
import type { TableroApiClient } from './tablero-api-client.js';
import { FixtureTableroApiClient } from './tablero-api-client.fixture.js';
import { HttpTableroApiClient } from './tablero-api-client.http.js';

export function buildTableroApiClient(): TableroApiClient {
  if (env.tableroApiMode === 'http') {
    return new HttpTableroApiClient(env.tableroApiBaseUrl, env.tableroApiToken);
  }
  return new FixtureTableroApiClient();
}
