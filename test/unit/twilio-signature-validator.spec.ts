import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { verifyTwilioSignature } from '../../src/auth/twilio-signature-validator.js';

const AUTH_TOKEN = 'test-auth-token';
const URL = 'http://localhost:3000/webhooks/twilio/status';
const PARAMS = { CallSid: 'CA123', CallStatus: 'completed' };

describe('verifyTwilioSignature (usa el helper oficial del SDK de Twilio)', () => {
  it('acepta una firma valida generada con el propio SDK', () => {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    expect(verifyTwilioSignature(AUTH_TOKEN, signature, URL, PARAMS)).toBe(true);
  });

  it('rechaza si falta la firma', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, undefined, URL, PARAMS)).toBe(false);
  });

  it('rechaza una firma incorrecta', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, 'firma-invalida', URL, PARAMS)).toBe(false);
  });

  it('rechaza si los parametros fueron alterados despues de firmar', () => {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    expect(
      verifyTwilioSignature(AUTH_TOKEN, signature, URL, { ...PARAMS, CallStatus: 'failed' }),
    ).toBe(false);
  });
});
