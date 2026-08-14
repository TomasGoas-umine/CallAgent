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

const ELEVENLABS_OUTBOUND_CALL_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';

export class RealElevenLabsClient implements ElevenLabsClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'RealElevenLabsClient requiere ELEVENLABS_API_KEY — no lo uses sin MOCK_PROVIDERS=false + credencial real.',
      );
    }
  }

  async startOutboundCall(params: StartOutboundCallParams): Promise<StartOutboundCallResult> {
    const response = await fetch(ELEVENLABS_OUTBOUND_CALL_URL, {
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
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      conversation_id?: string;
      callSid?: string;
      call_sid?: string;
      message?: string;
    };

    if (!response.ok) {
      logger.error('elevenlabs_outbound_call_failed', { status: response.status });
      return { success: false, error: body.message ?? `HTTP ${response.status}` };
    }

    return {
      success: true,
      conversationId: body.conversation_id,
      callSid: body.callSid ?? body.call_sid,
    };
  }
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
