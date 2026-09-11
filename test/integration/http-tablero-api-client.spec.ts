/**
 * Contrato real de tablero-api. Estos tests corren contra un snapshot ANONIMIZADO de una
 * respuesta de produccion (`test/fixtures/tablero_search_real_anonymized.json`, capturado el
 * 2026-09-09 con `scripts/capture-real-sample.ts`), no contra datos inventados.
 *
 * Existen porque el fixture sintetico probaba la clasificacion pero no el CONTRATO, y por ahi
 * se colaron cuatro incompatibilidades que ningun test veia: el sobre `items` leido como `data`,
 * la paginacion ignorada, un campo `enrolled_count` inexistente y la falta de los gates de
 * seccion. Ver docs/SEMAFORO_INTEGRACION.md §9.
 *
 * Nunca hay red: `fetch` se inyecta.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTableroApiClient, MAX_PAGES } from '../../src/services/tablero-api-client.http.js';
import { groupOrders } from '../../src/services/order-status-promoter.js';
import { readSemaforo } from '../../src/services/course-lookup.js';
import type { TableroApiClient } from '../../src/services/tablero-api-client.js';
import type { TableroRecord } from '../../src/domain/candidate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Snapshot {
  captured_at: string;
  pages: Array<{
    items: TableroRecord[];
    total: number;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
}

const snapshot = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'tablero_search_real_anonymized.json'),
    'utf-8',
  ),
) as Snapshot;

const TODOS_LOS_ITEMS = snapshot.pages.flatMap((p) => p.items);

/** Sirve el snapshot pagina por pagina, siguiendo el mismo protocolo de cursor que el API. */
function fakeFetchPaginado(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const porCursor = new Map<string | null, (typeof snapshot.pages)[number]>();
  let cursorPrevio: string | null = null;
  for (const page of snapshot.pages) {
    porCursor.set(cursorPrevio, page);
    cursorPrevio = page.nextCursor;
  }
  // La ultima pagina capturada dice hasMore:true (el dataset real sigue); se corta aca.
  const ultima = snapshot.pages[snapshot.pages.length - 1];
  porCursor.set(ultima?.nextCursor ?? null, {
    items: [],
    total: 0,
    nextCursor: null,
    hasMore: false,
  });

  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const cursor = url.searchParams.get('cursor');
    const page = porCursor.get(cursor) ?? { items: [], total: 0, nextCursor: null, hasMore: false };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetch: impl, urls };
}

describe('HttpTableroApiClient — contrato real', () => {
  it('lee `items` (no `data`) y devuelve todos los registros de todas las paginas', async () => {
    const { fetch: fakeFetch } = fakeFetchPaginado();
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);

    const { records, paginas, truncado } = await client.search({});

    expect(records).toHaveLength(TODOS_LOS_ITEMS.length);
    expect(records.length).toBeGreaterThan(700); // 801 en el snapshot
    expect(paginas).toBe(snapshot.pages.length + 1); // +1: la pagina final vacia que cierra
    expect(truncado).toBe(false);
  });

  it('sigue nextCursor en cada pagina y manda el limit configurado', async () => {
    const { fetch: fakeFetch, urls } = fakeFetchPaginado();
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);
    await client.search({});

    expect(urls[0]).toContain('limit=200');
    expect(urls[0]).not.toContain('cursor=');
    expect(urls[1]).toContain(`cursor=${snapshot.pages[0]?.nextCursor}`);
    expect(urls[2]).toContain(`cursor=${snapshot.pages[1]?.nextCursor}`);
  });

  it('NO manda `seccion`: el API no conoce ese parametro', async () => {
    const { fetch: fakeFetch, urls } = fakeFetchPaginado();
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);
    await client.search({ seccion: 'A_RIESGO_CONEXION' });
    expect(urls.every((u) => !u.includes('seccion'))).toBe(true);
  });

  it('falla ruidosamente si el sobre no trae `items`, en vez de devolver vacio', async () => {
    // Este es exactamente el modo de falla que tenia el cliente: leer `payload.data` sobre una
    // respuesta `{items}` daba `[]` sin error, indistinguible de "no hay candidatos hoy".
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: [{ order_number: '1' }], nextCursor: null }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);

    await expect(client.search({})).rejects.toThrow(/no devolvio 'items'/);
  });

  it('corta y marca truncado si el cursor no avanza, en vez de girar para siempre', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ items: [], total: 0, nextCursor: 'mismo', hasMore: true }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);

    const { paginas, truncado } = await client.search({});
    expect(truncado).toBe(true);
    expect(paginas).toBeLessThan(MAX_PAGES);
  });

  it('propaga el error si el API responde != 2xx', async () => {
    const fakeFetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);
    await expect(client.search({})).rejects.toThrow(/respondio 500/);
  });
});

describe('pipeline completo sobre la respuesta real anonimizada', () => {
  beforeEach(() => {
    // El snapshot es un congelado: se pinea el reloj a su fecha de captura para que la promocion
    // de estado y la semana de curso den lo mismo hoy que dentro de un ano.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(snapshot.captured_at));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ningun registro real trae enrolled_count — por eso se cuentan los inscritos', () => {
    expect(TODOS_LOS_ITEMS.some((r) => 'enrolled_count' in r)).toBe(false);
  });

  it('el snapshot real trae updated_at con tipos mezclados (ISO y epoch)', () => {
    const tipos = new Set(TODOS_LOS_ITEMS.map((r) => typeof r.updated_at));
    expect(tipos.has('string')).toBe(true);
    expect(tipos.has('number')).toBe(true);
  });

  it('agrupa por OC sin NaN y descartando los DEAD_ESTADOS', () => {
    const { groups, stats } = groupOrders(TODOS_LOS_ITEMS);

    expect(stats.registrosRecibidos).toBe(TODOS_LOS_ITEMS.length);
    // FACTURADA/BAJA son mayoria en el dato real: tienen que caer antes de agregar.
    expect(stats.registrosDescartados.estadoMuerto).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(0);

    for (const g of groups) {
      expect(Number.isNaN(g.pctConexion)).toBe(false);
      expect(g.pctConexion).toBeGreaterThanOrEqual(0);
      expect(g.pctConexion).toBeLessThanOrEqual(100);
      expect(g.totalConnections).toBeLessThanOrEqual(g.enrolledCount);
    }
  });

  it('readSemaforo aplica los gates de seccion A y expone los contadores', async () => {
    const { fetch: fakeFetch } = fakeFetchPaginado();
    const client: TableroApiClient = new HttpTableroApiClient(
      'https://api.ejemplo',
      'token',
      200,
      fakeFetch,
    );

    const { evaluaciones, stats } = await readSemaforo(client);

    expect(stats.paginas).toBeGreaterThan(1);
    expect(stats.registrosRecibidos).toBe(TODOS_LOS_ITEMS.length);
    expect(stats.ocsAgrupadas).toBeGreaterThan(0);
    expect(stats.ocsSeccionA).toBe(evaluaciones.length);
    // Con dato real hay OCs fuera de la seccion A (terminadas, no iniciadas, ya al 100%).
    const fuera = Object.values(stats.ocsFueraDeSeccionA).reduce((a, b) => a + b, 0);
    expect(fuera).toBeGreaterThan(0);
    expect(stats.ocsAgrupadas).toBe(stats.ocsSeccionA + fuera);

    // Toda OC que sobrevive el gate cumple las tres condiciones de la seccion A.
    for (const e of evaluaciones) {
      const estado = e.group.promotedOrderStatus.toUpperCase();
      expect(estado === '' || estado.includes('OPERACI') || estado.includes('EJECUCI')).toBe(true);
      expect(e.group.pctConexion).toBeLessThan(100);
      if (e.group.endCourse) {
        expect(new Date(e.group.endCourse).getTime()).toBeGreaterThan(Date.now());
      }
    }
  });

  it('con dato real no hay candidato a llamada: el Semaforo no expone telefono', async () => {
    const { fetch: fakeFetch } = fakeFetchPaginado();
    const client = new HttpTableroApiClient('https://api.ejemplo', 'token', 200, fakeFetch);
    const { evaluaciones } = await readSemaforo(client);

    // Puede haber CRITICOs; ninguno es llamable, porque `phone_test_only` solo existe en el
    // fixture sintetico. Es el bloqueante de negocio UV-023, no un bug.
    expect(evaluaciones.every((e) => e.group.records.every((r) => !r.phone_test_only))).toBe(true);
  });
});
