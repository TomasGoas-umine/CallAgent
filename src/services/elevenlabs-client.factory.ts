/**
 * Factory de ElevenLabsClient. Aplica la regla no negociable del prompt §1:
 * nunca se activa el cliente real por omision. Requiere MOCK_PROVIDERS=false explicito
 * Y una allowlist de numeros no vacia.
 */

import { env } from '../utils/env.js';
import {
  MockElevenLabsClient,
  RealElevenLabsClient,
  type ElevenLabsClient,
  type MockOutboundCallScenario,
} from './elevenlabs-client.js';

export function buildElevenLabsClient(
  forcedMockScenario?: MockOutboundCallScenario,
): ElevenLabsClient {
  if (env.mockProviders) {
    return new MockElevenLabsClient(forcedMockScenario);
  }

  // A partir de aca se gastan minutos reales. Todo lo que falte se reporta JUNTO y antes de
  // tocar la red: si falta el agent_id la API responde un 422 generico que no dice cual es el
  // problema, y para entonces ya se consumio un slot de cuota.
  const faltantes: string[] = [];
  if (env.allowlistNumbers.length === 0) faltantes.push('ALLOWLIST_NUMBERS');
  if (!env.elevenlabsApiKey) faltantes.push('ELEVENLABS_API_KEY');
  if (!env.elevenlabsAgentId) faltantes.push('ELEVENLABS_AGENT_ID');
  if (!env.elevenlabsAgentPhoneNumberId) faltantes.push('ELEVENLABS_AGENT_PHONE_NUMBER_ID');
  if (!env.elevenlabsWebhookSecret) faltantes.push('ELEVENLABS_WEBHOOK_SECRET');

  if (faltantes.length > 0) {
    throw new Error(
      `MOCK_PROVIDERS=false requiere ${faltantes.join(', ')}. ` +
        'Corre `npm run providers:check` para validar la configuracion sin gastar una llamada. ' +
        'Nunca se activan llamadas reales por omision.',
    );
  }

  return new RealElevenLabsClient(env.elevenlabsApiKey);
}
