/**
 * Cliente HTTP del micrositio.
 *
 * Todas las rutas se resuelven contra `API_BASE`, que por defecto es la ruta RELATIVA `api`
 * (nunca `/api` absoluta): al embeberse en un core de Umine bajo un path desconocido, una ruta
 * absoluta se rompe. En desarrollo el proxy de Vite manda `/api` al server Fastify local.
 *
 * Se puede sobreescribir de dos formas, sin recompilar:
 *  - `window.__UMINE_VOICE_API_BASE__` (lo mas comodo para embeber)
 *  - `VITE_API_BASE` en tiempo de build
 */

import type {
  CallDetalleResponse,
  CallsResponse,
  CallRules,
  DisparoResponse,
  Health,
  MockOrderPatch,
  MockTableroResponse,
  SyncResponse,
  TableroOriginalResponse,
  TableroResponse,
} from './types';

declare global {
  interface Window {
    __UMINE_VOICE_API_BASE__?: string;
  }
}

function resolveApiBase(): string {
  const fromWindow = typeof window !== 'undefined' ? window.__UMINE_VOICE_API_BASE__ : undefined;
  const base = fromWindow ?? import.meta.env.VITE_API_BASE ?? '/api';
  return base.replace(/\/+$/, '');
}

export const API_BASE = resolveApiBase();

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly payload: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 404) {
      // Un 404 en una ruta propia casi nunca es "no hay datos": es que el server local no
      // conoce ese endpoint. La causa habitual es que `npm run local:server` quedo corriendo
      // codigo viejo — tsx NO recarga al cambiar archivos. Decirlo explicitamente ahorra
      // buscar el problema en el lado equivocado (paso de verdad).
      throw new ApiError(
        404,
        payload,
        `El server local no expone ${path} (404). Suele ser que quedo corriendo codigo viejo: ` +
          'para y volve a levantar `npm run local:server`.',
      );
    }
    const detalle =
      (payload as { detalle?: string; error?: string } | null)?.detalle ??
      (payload as { error?: string } | null)?.error ??
      `HTTP ${response.status}`;
    throw new ApiError(response.status, payload, detalle);
  }
  return payload as T;
}

export const api = {
  health: () => request<Health>('/health'),
  tablero: () => request<TableroResponse>('/tablero'),

  // --- Tablero Mock (editable; el unico camino automatico que puede llamar) ---
  tableroMock: () => request<MockTableroResponse>('/tablero/mock'),
  editarOrdenMock: (clientId: string, orderNumber: string, patch: MockOrderPatch) =>
    request<MockTableroResponse>(
      `/tablero/mock/orders/${encodeURIComponent(clientId)}/${encodeURIComponent(orderNumber)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  resetMock: () => request<MockTableroResponse>('/tablero/mock/reset', { method: 'POST' }),
  setCallRules: (rules: CallRules) =>
    request<MockTableroResponse>('/tablero/mock/call-rules', {
      method: 'PUT',
      body: JSON.stringify(rules),
    }),
  resetCallRules: () =>
    request<MockTableroResponse>('/tablero/mock/call-rules/reset', { method: 'POST' }),
  setAutoCall: (enabled: boolean) =>
    request<MockTableroResponse>('/tablero/mock/auto-call', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  // --- Tablero Original (dato real, estrictamente de lectura) ---
  /** `refrescar` saltea la cache del backend (lo usa el boton Recargar). */
  tableroOriginal: (refrescar = false) =>
    request<TableroOriginalResponse>(`/tablero/original${refrescar ? '?refresh=1' : ''}`),
  calls: () => request<CallsResponse>('/calls'),
  call: (followupId: string) =>
    request<CallDetalleResponse>(`/calls/${encodeURIComponent(followupId)}`),

  /**
   * Trae los resultados de llamada desde la API de ElevenLabs. NO origina ninguna llamada: el
   * backend solo hace GET contra el proveedor. Es idempotente, se puede apretar las veces que
   * haga falta.
   */
  sincronizar: () => request<SyncResponse>('/calls/sync', { method: 'POST', body: '{}' }),

  /**
   * Dispara UNA llamada. La idempotency key va en el header y es obligatoria: la genera el
   * componente ANTES de abrir el modal de confirmacion, para que un doble click (o un reintento
   * del operador sobre el mismo modal) no origine dos llamadas.
   */
  async disparar(body: {
    clientId: string;
    orderNumber: string;
    phone: string;
    requestedBy?: string;
    idempotencyKey: string;
  }): Promise<{ httpStatus: number; data: DisparoResponse }> {
    const response = await fetch(`${API_BASE}/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': body.idempotencyKey },
      body: JSON.stringify({
        clientId: body.clientId,
        orderNumber: body.orderNumber,
        phone: body.phone,
        requestedBy: body.requestedBy,
      }),
    });
    const text = await response.text();
    return {
      httpStatus: response.status,
      data: text ? (JSON.parse(text) as DisparoResponse) : { status: 'sin_cuerpo' },
    };
  },
};

/** `crypto.randomUUID` no existe en contextos no seguros (http en LAN): fallback simple. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
