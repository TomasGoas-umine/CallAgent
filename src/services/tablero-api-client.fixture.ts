/**
 * FixtureTableroApiClient — lee de test/fixtures/tablero_search_sample.json.
 *
 * El fixture fue generado a partir del mismo patron de datos que semaforo_test_samples.csv
 * (documento de la auditoria previa), con un campo `phone_test_only` agregado explicitamente
 * como dato SINTETICO — tablero-api real NO expone telefono en ningun punto de la cadena
 * po -> pod -> execution-sence -> tablero-api (ver PROJECT_CONTEXT.md).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TableroApiClient } from './tablero-api-client.js';
import type { TableroRecord, TableroSearchFilters } from '../domain/candidate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'tablero_search_sample.json',
);

export class FixtureTableroApiClient implements TableroApiClient {
  constructor(private readonly fixturePath: string = DEFAULT_FIXTURE_PATH) {}

  async search(_filters: TableroSearchFilters): Promise<TableroRecord[]> {
    const raw = await readFile(this.fixturePath, 'utf-8');
    const records = JSON.parse(raw) as TableroRecord[];
    return records;
  }
}
