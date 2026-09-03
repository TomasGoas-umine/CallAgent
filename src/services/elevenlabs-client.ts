/**
 * ElevenLabsClient — dispara la llamada saliente (integracion nativa ElevenLabs<->Twilio,
 * Opcion A, ver docs/architecture/DECISIONS.md ADR-003). El audio viaja Twilio<->ElevenLabs
 * directo; nuestro backend solo dispara y despues recibe el webhook post-call.
 *
 * RealElevenLabsClient: POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call.
 * MockElevenLabsClient: default en local (MOCK_PROVIDERS=true, prompt §1 — nunca se llama
 * de verdad a ElevenLabs/Twilio en esta sesion).
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface StartOutboundCallParams {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  dynamicVariables: Record<string, string>;
  /**
   * Grabacion de la llamada. Decision de negocio ABIERTA (UV-026, ADR-006): el piloto asume
   * `false`. Se manda SIEMPRE explicito en la request en vez de dejar que el agente decida por
   * su configuracion, para que la decision quede en el codigo y no en un panel.
   */
  callRecordingEnabled?: boolean;
}

export interface StartOutboundCallResult {
  success: boolean;
  conversationId?: string;
  callSid?: string;
  error?: string;
}

export interface ElevenLabsClient {
  startOutboundCall(params: StartOutboundCallParams): Promise<StartOutboundCallResult>;
}

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1/convai';
const OUTBOUND_CALL_PATH = '/twilio/outbound-call';

/** La API responde rapido (solo encola la llamada). Sin timeout, un cuelgue bloquea el dispatch. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Forma de la respuesta de POST /v1/convai/twilio/outbound-call.
 * OJO con `callSid`: la API lo devuelve en camelCase (no snake_case como el resto).
 */
interface OutboundCallResponseBody {
  success?: boolean;
  message?: string;
  conversation_id?: string;
  callSid?: string;
  call_sid?: string;
  detail?: unknown;
}

export class RealElevenLabsClient implements ElevenLabsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ELEVENLABS_API_BASE,
  ) {
    if (!apiKey) {
      throw new Error(
        'RealElevenLabsClient requiere ELEVENLABS_API_KEY — no lo uses sin MOCK_PROVIDERS=false + credencial real.',
      );
    }
  }

  async startOutboundCall(params: StartOutboundCallParams): Promise<StartOutboundCallResult> {
    // Se loguea ANTES de llamar: si el proceso muere en el medio, queda rastro de que se
    // intento gastar un minuto real. El telefono lo enmascara el logger.
    logger.info('elevenlabs_outbound_call_attempt', {
      agentId: params.agentId,
      toNumber: params.toNumber,
      callRecordingEnabled: params.callRecordingEnabled ?? false,
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${OUTBOUND_CALL_PATH}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: params.agentId,
          agent_phone_number_id: params.agentPhoneNumberId,
          to_number: params.toNumber,
          conversation_initiation_client_data: {
            dynamic_variables: params.dynamicVariables,
          },
          call_recording_enabled: params.callRecordingEnabled ?? false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout o fallo de red. NO se sabe si la llamada se origino o no: se reporta como
      // fallo (el dispatcher va a reintentar segun MAX_ATTEMPTS) y queda el log de arriba.
      const error = err instanceof Error ? err.message : String(err);
      logger.error('elevenlabs_outbound_call_network_error', { error });
      return { success: false, error: `red/timeout: ${error}` };
    }

    const raw = await response.text();
    let body: OutboundCallResponseBody = {};
    try {
      body = raw ? (JSON.parse(raw) as OutboundCallResponseBody) : {};
    } catch {
      // Respuesta no-JSON (ej. un HTML de error de gateway): se preserva un extracto.
      body = { message: raw.slice(0, 200) };
    }

    if (!response.ok) {
      logger.error('elevenlabs_outbound_call_failed', {
        status: response.status,
        message: body.message ?? body.detail,
      });
      return {
        success: false,
        error: `HTTP ${response.status}: ${describeError(body)}`,
      };
    }

    // 200 con `success: false` es un caso real (ej. el numero no es valido para el proveedor).
    // Sin este chequeo el followup quedaria en DIALING esperando un webhook que no va a llegar.
    if (body.success === false) {
      logger.error('elevenlabs_outbound_call_rejected', { message: body.message });
      return { success: false, error: `proveedor rechazo la llamada: ${describeError(body)}` };
    }

    const conversationId = body.conversation_id;
    if (!conversationId) {
      // Sin conversation_id no se puede correlacionar el webhook post-call con el FOLLOWUP:
      // la llamada podria estar en curso y su resultado se perderia. Se trata como fallo
      // ruidoso en vez de dejar el followup colgado en silencio.
      logger.error('elevenlabs_outbound_call_sin_conversation_id', { status: response.status });
      return { success: false, error: 'la respuesta no trajo conversation_id' };
    }

    return {
      success: true,
      conversationId,
      callSid: body.callSid ?? body.call_sid,
    };
  }
}

function describeError(body: OutboundCallResponseBody): string {
  if (body.message) return body.message;
  if (body.detail !== undefined) return JSON.stringify(body.detail).slice(0, 200);
  return 'sin detalle';
}

export type MockOutboundCallScenario = 'success' | 'no_answer' | 'busy' | 'error';

/**
 * Mock — default en local. `success`/`no_answer`/`busy` representan que Twilio SI logro
 * originar la llamada (ElevenLabs responde 200 y da conversation_id/callSid); el resultado
 * real de si contestaron llega despues via el webhook post-call, no en esta respuesta —
 * el escenario forzado aqui solo sirve para que los tests/demo sepan que payload de webhook
 * construir a continuacion (ver test/fixtures y scripts/local-demo.ts).
 * `error` simula que la propia llamada a la API de ElevenLabs fallo (proveedor caido, rate
 * limit, numero invalido, etc.) — nunca se dispara ninguna llamada de verdad.
 */
export class MockElevenLabsClient implements ElevenLabsClient {
  constructor(private readonly forcedScenario: MockOutboundCallScenario = 'success') {}

  async startOutboundCall(params: StartOutboundCallParams): Promise<StartOutboundCallResult> {
    logger.info('mock_elevenlabs_outbound_call', {
      scenario: this.forcedScenario,
      toNumber: params.toNumber,
    });

    if (this.forcedScenario === 'error') {
      return { success: false, error: 'mock_provider_error' };
    }

    return {
      success: true,
      conversationId: `conv_mock_${randomUUID()}`,
      callSid: `CA_mock_${randomUUID().replace(/-/g, '')}`,
    };
  }
}
