/**
 * Diagnostico de errores del cliente HTTP. El caso importante es el 404: cuando el server local
 * quedo corriendo codigo viejo (tsx no recarga solo), las vistas nuevas se ven VACIAS y el
 * mensaje por defecto era "Not Found", que no ayuda a nadie a encontrar la causa.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('cliente de la API', () => {
  it('un 404 explica que el server local puede estar corriendo codigo viejo', async () => {
    stubFetch(404, { message: 'Route GET:/api/tablero/mock not found', error: 'Not Found' });

    await expect(api.tableroMock()).rejects.toThrow(/codigo viejo/);
    await expect(api.tableroMock()).rejects.toThrow(/local:server/);
  });

  it('el 404 nombra la ruta que falto, para saber cual endpoint falta', async () => {
    stubFetch(404, {});
    await expect(api.tableroOriginal()).rejects.toThrow(/\/tablero\/original/);
  });

  it('otros errores conservan el detalle que manda el backend', async () => {
    stubFetch(503, { error: 'tablero_api_no_configurada', detalle: 'Falta TABLERO_API_BASE_URL' });

    await expect(api.tableroOriginal()).rejects.toThrow(/Falta TABLERO_API_BASE_URL/);
    await expect(api.tableroOriginal()).rejects.toBeInstanceOf(ApiError);
  });

  it('una respuesta ok devuelve el cuerpo parseado', async () => {
    stubFetch(200, { ordenes: [], autoCallEnabled: false });
    await expect(api.tableroMock()).resolves.toMatchObject({ autoCallEnabled: false });
  });
});
