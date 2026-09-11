/**
 * HttpTableroApiClient — implementacion real contra `GET {TABLERO_API_BASE_URL}/tablero/search`.
 *
 * NO se activa por defecto (`TABLERO_API_MODE` debe ser `http` explicitamente): el dato real no
 * trae telefono, asi que con el API real no hay a quien llamar hasta que se resuelva UV-023.
 * Sirve igual para leer el Semaforo y contar candidatos en seco.
 *
 * Contrato verificado contra prod el 2026-09-09 (no asumido):
 *   - El sobre es `{ items, total, nextCursor, hasMore }`. Leer `payload.data` devuelve
 *     `undefined` y el cliente retorna vacio SIN error — el peor modo de falla posible.
 *   - La paginacion es real. Sin `limit`, una sola llamada devolvio 4.042 de 5.943 registros
 *     con `hasMore: true` y `nextCursor: '651'`: quien no siga el cursor ve ~68% del dataset y
 *     cree que lo vio todo.
 *   - `nextCursor` es un indice de segmento sobre la tabla `po`, no un offset de items: el
 *     numero de items por pagina no coincide con `limit`. Se usa tal cual, sin interpretarlo.
 *   - Sin `limit` la respuesta pesa ~4,5 MB y tarda ~10,7 s. Con paginas chicas el mismo total
 *     baja en varias respuestas cortas y se esquiva el `Function.ResponseSizeTooLarge` (~6 MB)
 *     que el Lambda arrastra desde la auditoria.
 *   - `seccion` NO es un parametro que el API conozca (`handleSearch` solo lee `limit`,
 *     `cursor`, `order_status`, `sence_connections`, `dj` y los filtros de fecha). Mandarlo era
 *     un no-op silencioso, asi que ya no se manda: el filtro de seccion se aplica del lado de
 *     CallAgent, en `semaforo-sections.ts`.
 *
 * Autenticacion: el API hoy responde sin token (`REQUIRE_AUTH` no esta en `true` en prod). El
 * Bearer se manda igual si esta configurado — que el servidor no lo exija no es razon para no
 * mandarlo. Este cliente es de SOLO LECTURA: nunca escribe a tablero-api.
 */

import type { TableroApiClient, TableroSearchResult } from './tablero-api-client.js';
import type { TableroRecord, TableroSearchFilters } from '../domain/candidate.js';
import { logger } from '../utils/logger.js';

/** Items por pagina. Chico a proposito: respuestas cortas y lejos del limite de tamano. */
export const DEFAULT_PAGE_LIMIT = 2000;

/**
 * Tope de paginas por busqueda. Es un cinturon de seguridad, no una regla de negocio: si se
 * alcanza, algo esta mal (cursor que no avanza, dataset que crecio un orden de magnitud) y hay
 * que verlo en los logs, no seguir pidiendo paginas para siempre.
 */
export const MAX_PAGES = 50;

interface SearchPayload {
  items?: TableroRecord[];
  total?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
}

export class HttpTableroApiClient implements TableroApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
    private readonly pageLimit: number = DEFAULT_PAGE_LIMIT,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!baseUrl) {
      throw new Error(
        'HttpTableroApiClient requiere TABLERO_API_BASE_URL — no actives TABLERO_API_MODE=http sin configurarla.',
      );
    }
  }

  async search(filters: TableroSearchFilters): Promise<TableroSearchResult> {
    const records: TableroRecord[] = [];
    const cursoresVistos = new Set<string>();
    let cursor: string | null = null;
    let paginas = 0;
    let truncado = false;

    while (paginas < MAX_PAGES) {
      const url = new URL('/tablero/search', this.baseUrl);
      url.searchParams.set('limit', String(this.pageLimit));
      if (cursor) url.searchParams.set('cursor', cursor);
      // `seccion` no se manda: el API no lo conoce (ver cabecera del archivo).
      if (filters.order_status) url.searchParams.set('order_status', filters.order_status);

      const headers: Record<string, string> = {};
      if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;

      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        logger.error('tablero_api_error', {
          status: response.status,
          pagina: paginas + 1,
          registrosAcumulados: records.length,
        });
        throw new Error(`tablero-api respondio ${response.status}`);
      }

      const payload = (await response.json()) as SearchPayload;
      const items = payload.items ?? [];
      paginas++;

      // Si `items` viene undefined pero el cuerpo trae algo, el contrato cambio: es exactamente
      // el fallo que hacia que este cliente devolviera vacio en silencio. Se grita, no se ignora.
      if (payload.items === undefined) {
        logger.error('tablero_api_contrato_inesperado', {
          pagina: paginas,
          clavesRecibidas: Object.keys(payload as Record<string, unknown>),
          esperado: 'items',
        });
        throw new Error(
          `tablero-api no devolvio 'items' (claves: ${Object.keys(payload as Record<string, unknown>).join(', ') || 'ninguna'})`,
        );
      }

      records.push(...items);
      logger.debug('tablero_api_pagina', {
        pagina: paginas,
        items: items.length,
        acumulado: records.length,
        hasMore: payload.hasMore ?? false,
      });

      const siguiente = payload.nextCursor ?? null;
      if (!payload.hasMore || !siguiente) break;

      // Cursor que no avanza = bucle infinito. Se corta y se reporta.
      if (cursoresVistos.has(siguiente)) {
        logger.error('tablero_api_cursor_repetido', { cursor: siguiente, pagina: paginas });
        truncado = true;
        break;
      }
      cursoresVistos.add(siguiente);
      cursor = siguiente;

      if (paginas >= MAX_PAGES) {
        logger.error('tablero_api_tope_de_paginas', {
          maxPages: MAX_PAGES,
          registrosLeidos: records.length,
        });
        truncado = true;
      }
    }

    logger.info('tablero_api_lectura_completa', {
      paginas,
      registros: records.length,
      truncado,
      pageLimit: this.pageLimit,
    });

    return { records, paginas, truncado };
  }
}
