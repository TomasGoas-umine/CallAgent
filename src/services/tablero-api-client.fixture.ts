/**
 * FixtureTableroApiClient — lee de test/fixtures/tablero_search_sample.json.
 *
 * El fixture fue generado a partir del mismo patron de datos que semaforo_test_samples.csv
 * (documento de la auditoria previa), con un campo `phone_test_only` agregado explicitamente
 * como dato SINTETICO — tablero-api real NO expone telefono en ningun punto de la cadena
 * po -> pod -> execution-sence -> tablero-api (ver PROJECT_CONTEXT.md).
 *
 * Fechas relativas (ver DECISIONS.md ADR-009): las fechas del fixture NO se leen tal cual del
 * JSON. Cada registro lleva `_fixture_offset_init_days` / `_fixture_offset_end_days` /
 * `_fixture_offset_updated_days` y aca se reescriben `init_course` / `end_course` /
 * `updated_at` relativos a "hoy". Sin esto el fixture envejece: los cursos avanzan de semana
 * de curso con el reloj real y los grupos se reclasifican solos (fue exactamente lo que rompio
 * `npm run local:demo`, ver docs/status/INVENTARIO-2026-09-03.md). Los tests que pinean el
 * reloj con `vi.setSystemTime` siguen siendo deterministas: los offsets se resuelven contra el
 * reloj pineado.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TableroApiClient, TableroSearchResult } from './tablero-api-client.js';
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

/** Campos `_fixture_*` que solo existen en el fixture, nunca en la respuesta real de tablero-api. */
interface FixtureRecord extends TableroRecord {
  _fixture_offset_init_days?: number;
  _fixture_offset_end_days?: number;
  _fixture_offset_updated_days?: number;
  /** Slot de ALLOWLIST_NUMBERS a resolver en `phone_test_only` (solo cursos CRITICO). */
  _fixture_allowlist_slot?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function midnightUtcToday(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Reescribe las fechas relativas al dia de hoy y resuelve el telefono de los cursos que
 * declaran un slot de allowlist. Devuelve una copia — nunca muta el objeto parseado.
 */
export function resolveFixtureRecord(
  record: FixtureRecord,
  options: { now?: Date; allowlistNumbers?: string[] } = {},
): TableroRecord {
  const now = options.now ?? new Date();
  const today = midnightUtcToday(now);
  const resolved: FixtureRecord = { ...record };

  if (record._fixture_offset_init_days !== undefined) {
    resolved.init_course = isoDate(today + record._fixture_offset_init_days * MS_PER_DAY);
  }
  if (record._fixture_offset_end_days !== undefined) {
    resolved.end_course = isoDate(today + record._fixture_offset_end_days * MS_PER_DAY);
  }
  if (record._fixture_offset_updated_days !== undefined) {
    resolved.updated_at = new Date(
      today + record._fixture_offset_updated_days * MS_PER_DAY,
    ).toISOString();
  }

  // Los cursos CRITICO del fixture declaran un slot de ALLOWLIST_NUMBERS para que el
  // micrositio muestre un numero REALMENTE llamable (el del operador) en vez de uno inventado.
  // Si el slot no existe en la allowlist configurada, se deja el telefono sintetico autorado:
  // el guardrail de allowlist lo va a rechazar igual, con su motivo visible.
  const slot = record._fixture_allowlist_slot;
  if (slot !== undefined) {
    const fromAllowlist = options.allowlistNumbers?.[slot];
    if (fromAllowlist) resolved.phone_test_only = fromAllowlist;
  }

  return resolved;
}

export class FixtureTableroApiClient implements TableroApiClient {
  constructor(
    private readonly fixturePath: string = DEFAULT_FIXTURE_PATH,
    /** Inyectable para tests; por defecto se lee de env en cada `search()`. */
    private readonly allowlistNumbers?: string[],
  ) {}

  async search(_filters: TableroSearchFilters): Promise<TableroSearchResult> {
    const raw = await readFile(this.fixturePath, 'utf-8');
    const records = JSON.parse(raw) as FixtureRecord[];
    const allowlistNumbers = this.allowlistNumbers ?? (await currentAllowlist());
    return {
      records: records.map((record) => resolveFixtureRecord(record, { allowlistNumbers })),
      // El fixture es un archivo: no hay paginacion que seguir.
      paginas: 1,
      truncado: false,
    };
  }
}

/**
 * `env` se congela al importar el modulo; el fixture client se instancia una vez por proceso,
 * asi que la allowlist se lee via import dinamico para respetar los tests que reescriben
 * `process.env` + `vi.resetModules()` entre casos.
 */
async function currentAllowlist(): Promise<string[]> {
  const { env } = await import('../utils/env.js');
  return env.allowlistNumbers;
}
