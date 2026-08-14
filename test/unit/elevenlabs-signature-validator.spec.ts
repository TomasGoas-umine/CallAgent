import { describe, expect, it } from 'vitest';
import {
  verifyElevenLabsSignature,
  generateTestSignatureHeader,
  computeElevenLabsSignature,
} from '../../src/auth/elevenlabs-signature-validator.js';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({
  type: 'post_call_transcription',
  data: { conversation_id: 'conv-1' },
});

describe('verifyElevenLabsSignature', () => {
  it('acepta una firma valida dentro de la tolerancia', () => {
    const now = Date.now();
    const header = generateTestSignatureHeader(SECRET, BODY, Math.floor(now / 1000));
    const result = verifyElevenLabsSignature(header, BODY, SECRET, now);
    expect(result).toEqual({ valid: true });
  });

  it('rechaza si falta el header', () => {
    const result = verifyElevenLabsSignature(undefined, BODY, SECRET);
    expect(result).toEqual({ valid: false, reason: 'missing_header' });
  });

  it('rechaza un header malformado', () => {
    const result = verifyElevenLabsSignature('esto-no-es-valido', BODY, SECRET);
    expect(result).toEqual({ valid: false, reason: 'malformed_header' });
  });

  it('rechaza si el timestamp esta fuera de la tolerancia de 30 minutos', () => {
    const now = Date.now();
    const oldTimestamp = Math.floor((now - 31 * 60 * 1000) / 1000);
    const header = generateTestSignatureHeader(SECRET, BODY, oldTimestamp);
    const result = verifyElevenLabsSignature(header, BODY, SECRET, now);
    expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('acepta cerca del borde de la tolerancia (29m59s, dentro de los 30 min)', () => {
    const now = Date.now();
    // Un segundo dentro del limite: el timestamp del header se trunca a segundos enteros,
    // asi que se deja margen para no chocar con el redondeo del propio limite (31? -> ver test de arriba).
    const edgeTimestamp = Math.floor((now - (30 * 60 - 1) * 1000) / 1000);
    const header = generateTestSignatureHeader(SECRET, BODY, edgeTimestamp);
    const result = verifyElevenLabsSignature(header, BODY, SECRET, now);
    expect(result.valid).toBe(true);
  });

  it('rechaza si la firma no coincide (secret incorrecto)', () => {
    const now = Date.now();
    const header = generateTestSignatureHeader('otro-secret', BODY, Math.floor(now / 1000));
    const result = verifyElevenLabsSignature(header, BODY, SECRET, now);
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rechaza si el body fue modificado despues de firmar', () => {
    const now = Date.now();
    const header = generateTestSignatureHeader(SECRET, BODY, Math.floor(now / 1000));
    const tamperedBody = JSON.stringify({
      type: 'post_call_transcription',
      data: { conversation_id: 'conv-2' },
    });
    const result = verifyElevenLabsSignature(header, tamperedBody, SECRET, now);
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('computeElevenLabsSignature es determinista', () => {
    const a = computeElevenLabsSignature(SECRET, 1000, BODY);
    const b = computeElevenLabsSignature(SECRET, 1000, BODY);
    expect(a).toBe(b);
  });
});
