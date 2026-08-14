/**
 * Logger minimo (JSON lines a stdout, compatible con CloudWatch Logs sin configuracion extra).
 *
 * Reglas de seguridad (no negociables, ver prompt §1 y auditoria de patrones de Umine):
 *  - Nunca loguear secretos (tokens, API keys, auth tokens de Twilio/ElevenLabs).
 *  - Nunca loguear transcripciones completas — solo un resumen corto o el largo en caracteres.
 *  - Enmascarar siempre numeros de telefono (dejar solo los ultimos 4 digitos visibles).
 */

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authtoken',
  'auth_token',
  'token',
  'secret',
  'webhooksecret',
  'webhook_secret',
  'authorization',
  'signature',
]);

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '(sin_telefono)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max_depth]';
  if (typeof value === 'string') {
    // Trunca cualquier texto largo (candidato a transcripcion) a un preview corto.
    return value.length > 200 ? `${value.slice(0, 200)}…[truncated ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) {
        out[k] = '[redacted]';
      } else if (lower.includes('phone') || lower === 'destinatario' || lower === 'telefono') {
        out[k] = typeof v === 'string' ? maskPhone(v) : v;
      } else if (lower === 'transcript' || lower === 'transcript_summary') {
        out[k] = '[transcript omitted from logs — see S3]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
