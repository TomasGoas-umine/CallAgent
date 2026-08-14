/**
 * Validador de `X-Twilio-Signature`, usando el helper OFICIAL del SDK de Twilio
 * (nunca implementado a mano, prompt §5.5) — twilio.validateRequest.
 *
 * webhooks/twilio-status es opcional/stub en este MVP (solo reconciliacion de respaldo si
 * el webhook de ElevenLabs no llega a tiempo), pero la validacion de firma se construye
 * completa igual, porque cualquier endpoint publico que reciba webhooks de Twilio la necesita.
 */

import twilio from 'twilio';

export function verifyTwilioSignature(
  authToken: string,
  signatureHeader: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signatureHeader) return false;
  return twilio.validateRequest(authToken, signatureHeader, url, params);
}
