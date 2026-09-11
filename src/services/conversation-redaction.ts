import { maskPhone } from '../utils/logger.js';
/** Redact credentials and structured phone fields before exposing provider logs to the UI. */
export function redactConversation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConversation);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (
        /(api.?key|auth.?token|authorization|password|secret|signature|access.?token)/.test(lower)
      )
        return [key, '[redacted]'];
      if (
        typeof item === 'string' &&
        (/(phone|telefono|external_number|agent_number)/.test(lower) ||
          ['from', 'to', 'caller', 'called'].includes(lower) ||
          (lower === 'user_id' && /^\+?\d{8,}$/.test(item)))
      )
        return [key, maskPhone(item)];
      return [key, redactConversation(item)];
    }),
  );
}
