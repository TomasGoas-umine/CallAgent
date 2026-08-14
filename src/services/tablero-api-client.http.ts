/**
 * HttpTableroApiClient — implementacion real, apuntando a GET {TABLERO_API_BASE_URL}/tablero/search.
 *
 * NO se activa por defecto (TABLERO_API_MODE debe ser 'http' explicitamente). Motivos, ya
 * auditados y resumidos en docs/context/PROJECT_CONTEXT.md:
 *   - No hay campo de telefono en el dato real: a quien llamar y con que numero sigue sin
 *     decision de negocio confirmada (prompt §9).
 *   - La API "pagina" con nextCursor siempre null y limite hardcodeado en 15000; puede fallar
 *     con Function.ResponseSizeTooLarge si la respuesta supera ~6MB. Esta clase detecta y
 *     loguea esa condicion como metrica — nunca falla en silencio.
 *   - Autenticacion debil (solo valida presencia de Bearer token, no la firma). Se trata como
 *     fuente de solo lectura; este cliente nunca escribe a tablero-api.
 */

import type { TableroApiClient } from './tablero-api-client.js';
import type { TableroRecord, TableroSearchFilters } from '../domain/candidate.js';
import { logger } from '../utils/logger.js';

// Limite real observado en la auditoria de tablero-api (StatusCursosPage / tablero-api).
const KNOWN_HARDCODED_LIMIT = 15000;
// Umbral aproximado (~19.087 registros reales) donde la respuesta puede superar ~6MB y
// disparar Function.ResponseSizeTooLarge en el Lambda real de tablero-api.
const RESPONSE_SIZE_RISK_RECORD_COUNT = 19000;

export class HttpTableroApiClient implements TableroApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
  ) {
    if (!baseUrl) {
      throw new Error(
        'HttpTableroApiClient requiere TABLERO_API_BASE_URL — no actives TABLERO_API_MODE=http sin configurarla.',
      );
    }
  }

  async search(filters: TableroSearchFilters): Promise<TableroRecord[]> {
    const url = new URL('/tablero/search', this.baseUrl);
    if (filters.seccion) url.searchParams.set('seccion', filters.seccion);
    if (filters.order_status) url.searchParams.set('order_status', filters.order_status);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.bearerToken}` },
    });

    if (!response.ok) {
      logger.error('tablero_api_error', { status: response.status, url: url.toString() });
      throw new Error(`tablero-api respondio ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: TableroRecord[];
      nextCursor?: string | null;
    };
    const data = payload.data ?? [];

    // No se debe confiar en nextCursor: el endpoint real siempre lo devuelve null,
    // no implementa paginacion verdadera. Se registra como metrica, nunca se falla en silencio.
    if (payload.nextCursor) {
      logger.warn('tablero_api_unexpected_pagination', { nextCursor: payload.nextCursor });
    }
    if (data.length >= KNOWN_HARDCODED_LIMIT) {
      logger.warn('tablero_api_hit_hardcoded_limit', { count: data.length, limit: KNOWN_HARDCODED_LIMIT });
    }
    if (data.length >= RESPONSE_SIZE_RISK_RECORD_COUNT) {
      logger.warn('tablero_api_response_size_risk', {
        count: data.length,
        note: 'cerca del umbral historico de Function.ResponseSizeTooLarge (~6MB)',
      });
    }

    return data;
  }
}
