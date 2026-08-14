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
  if (env.allowlistNumbers.length === 0) {
    throw new Error(
      'MOCK_PROVIDERS=false requiere ALLOWLIST_NUMBERS no vacia — nunca se activan llamadas reales por omision (prompt §1).',
    );
  }
  return new RealElevenLabsClient(env.elevenlabsApiKey);
}
