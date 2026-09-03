/**
 * RealElevenLabsClient — el codigo que gasta minutos de verdad.
 *
 * Nunca toca la red: se intercepta `fetch`. Lo que se verifica es que NINGUN caso ambiguo se
 * reporte como exito, porque un falso exito deja el FOLLOWUP en DIALING esperando un webhook
 * que no va a llegar, y consumido un slot de cuota.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealElevenLabsClient } from '../../src/services/elevenlabs-client.js';
import type { StartOutboundCallParams } from '../../src/services/elevenlabs-client.js';

const PARAMS: StartOutboundCallParams = {
  agentId: 'agent_test',
  agentPhoneNumberId: 'phnum_test',
  toNumber: '+56900100141',
  dynamicVariables: { nombre_cliente: 'ACME', curso: 'Excel' },
};

function respuesta(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RealElevenLabsClient', () => {
  it('exige la API key: sin ella no se puede ni construir', () => {
    expect(() => new RealElevenLabsClient('')).toThrow(/ELEVENLABS_API_KEY/);
  });

  it('manda el payload que documenta ElevenLabs, con la API key en xi-api-key', async () => {
    fetchMock.mockResolvedValue(
      respuesta(200, { success: true, conversation_id: 'conv_1', callSid: 'CA_1' }),
    );
    const client = new RealElevenLabsClient('xi-key-de-test');

    const result = await client.startOutboundCall(PARAMS);

    expect(result).toMatchObject({ success: true, conversationId: 'conv_1', callSid: 'CA_1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key-de-test');

    expect(JSON.parse(init.body as string)).toEqual({
      agent_id: 'agent_test',
      agent_phone_number_id: 'phnum_test',
      to_number: '+56900100141',
      conversation_initiation_client_data: {
        dynamic_variables: { nombre_cliente: 'ACME', curso: 'Excel' },
      },
      // Se manda SIEMPRE explicito, no se deja a la configuracion del agente (UV-026).
      call_recording_enabled: false,
    });
  });

  it('manda call_recording_enabled=true solo si se le pide explicitamente', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { success: true, conversation_id: 'conv_1' }));
    await new RealElevenLabsClient('k').startOutboundCall({
      ...PARAMS,
      callRecordingEnabled: true,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).call_recording_enabled).toBe(true);
  });

  it('acepta callSid en snake_case tambien (call_sid)', async () => {
    fetchMock.mockResolvedValue(
      respuesta(200, { success: true, conversation_id: 'conv_1', call_sid: 'CA_snake' }),
    );
    const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);
    expect(result.callSid).toBe('CA_snake');
  });

  describe('casos que NO son exito', () => {
    it('HTTP 200 con success:false se reporta como fallo, no como llamada en curso', async () => {
      fetchMock.mockResolvedValue(respuesta(200, { success: false, message: 'Invalid to_number' }));
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid to_number');
      expect(result.conversationId).toBeUndefined();
    });

    it('HTTP 200 sin conversation_id se reporta como fallo (no se podria correlacionar el webhook)', async () => {
      fetchMock.mockResolvedValue(respuesta(200, { success: true, callSid: 'CA_1' }));
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('conversation_id');
    });

    it('401 devuelve el status y el mensaje del proveedor', async () => {
      fetchMock.mockResolvedValue(respuesta(401, { detail: { message: 'invalid_api_key' } }));
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 401');
      expect(result.error).toContain('invalid_api_key');
    });

    it('422 (agente o numero mal configurado) devuelve el detalle', async () => {
      fetchMock.mockResolvedValue(
        respuesta(422, { detail: [{ msg: 'agent_phone_number_id not found' }] }),
      );
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 422');
      expect(result.error).toContain('agent_phone_number_id');
    });

    it('una respuesta no-JSON (HTML de gateway) no rompe el cliente', async () => {
      fetchMock.mockResolvedValue(respuesta(502, '<html>Bad Gateway</html>', 'text/html'));
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 502');
    });

    it('un timeout o fallo de red se reporta como fallo, no explota', async () => {
      fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));
      const result = await new RealElevenLabsClient('k').startOutboundCall(PARAMS);

      expect(result.success).toBe(false);
      expect(result.error).toContain('red/timeout');
    });

    it('manda un AbortSignal para no quedarse colgado', async () => {
      fetchMock.mockResolvedValue(respuesta(200, { success: true, conversation_id: 'c' }));
      await new RealElevenLabsClient('k').startOutboundCall(PARAMS);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
