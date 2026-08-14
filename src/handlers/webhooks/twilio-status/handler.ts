/**
 * webhooks/twilio-status — STUB para este MVP (prompt §5.5, opcional pero no se omite de la
 * estructura). Solo sirve para reconciliar el estado de la llamada si el webhook post-call de
 * ElevenLabs no llega dentro del timeout (ver docs/bpmn/flujo-2-ejecucion-llamada.mmd, nodo
 * "Reconciliar via GET /v1/convai/conversations/{id}").
 *
 * TODO (siguiente ticket, ver docs/spec.csv): implementar la reconciliacion real —
 * hoy solo valida la firma y registra el evento, no actualiza el FOLLOWUP.
 */

import { verifyTwilioSignature } from '../../../auth/twilio-signature-validator.js';
import { env } from '../../../utils/env.js';
import { logger } from '../../../utils/logger.js';
import { ok, unauthorized } from '../../../utils/responses.js';
import type { ApiResponse } from '../../../utils/responses.js';

export interface TwilioStatusWebhookInput {
  url: string;
  params: Record<string, string>;
  signatureHeader: string | undefined;
}

export async function handleTwilioStatus(input: TwilioStatusWebhookInput): Promise<ApiResponse> {
  const valid = verifyTwilioSignature(
    env.twilioAuthToken,
    input.signatureHeader,
    input.url,
    input.params,
  );
  if (!valid) {
    logger.warn('twilio_status_webhook_signature_invalid', { params: input.params });
    return unauthorized('invalid_twilio_signature');
  }

  logger.info('twilio_status_webhook_received', {
    callSid: input.params.CallSid,
    callStatus: input.params.CallStatus,
  });

  // TODO: reconciliar contra el FOLLOWUP si el webhook de ElevenLabs no llego dentro del
  // timeout de 30 min (ver flujo-2). Fuera de alcance de esta sesion (prompt §5.5).
  return ok({ status: 'acknowledged' });
}
