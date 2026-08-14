/**
 * Validador de la firma HMAC de ElevenLabs para el webhook post-call (prompt §5.4).
 *
 * Header: `ElevenLabs-Signature: t=<unix_ts>,v0=<hex hmac-sha256>`
 * Firma = HMAC-SHA256(secret, `${t}.${rawBody}`), comparada en tiempo constante.
 * Tolerancia de timestamp: 30 minutos (protege contra replay de webhooks viejos).
 *
 * IMPORTANTE: se valida contra el `rawBody` (string exacto recibido), nunca contra el
 * objeto ya parseado — cualquier re-serializacion (JSON.stringify) puede cambiar el
 * resultado del HMAC por diferencias de espaciado/orden de llaves.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_MS = 30 * 60 * 1000;

export interface SignatureValidationResult {
  valid: boolean;
  reason?: 'missing_header' | 'malformed_header' | 'timestamp_out_of_tolerance' | 'signature_mismatch';
}

export function parseSignatureHeader(header: string): { t: number; v0: string } | null {
  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const [key, value] = segment.split('=');
    if (key && value) parts[key.trim()] = value.trim();
  }
  const t = Number(parts.t);
  const v0 = parts.v0;
  if (!Number.isFinite(t) || !v0) return null;
  return { t, v0 };
}

export function computeElevenLabsSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyElevenLabsSignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  now: number = Date.now(),
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): SignatureValidationResult {
  if (!header) return { valid: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const timestampMs = parsed.t * 1000;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = computeElevenLabsSignature(secret, parsed.t, rawBody);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(parsed.v0, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true };
}

/**
 * Generador de firmas de prueba (prompt §5.4) — SOLO para tests, para poder simular
 * webhooks validos e invalidos sin depender de un webhook real de ElevenLabs.
 */
export function generateTestSignatureHeader(
  secret: string,
  rawBody: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const signature = computeElevenLabsSignature(secret, timestamp, rawBody);
  return `t=${timestamp},v0=${signature}`;
}
