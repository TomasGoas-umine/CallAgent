/**
 * Helpers de reagendamiento compartidos entre candidate-evaluator, call-dispatcher y el
 * webhook post-call — evita reimplementar la misma cuenta de "manana a primera hora habil"
 * o el backoff de reintento en cada handler (prompt §1.4, no duplicar logica de negocio).
 */

import { env } from './env.js';

/** Proxima ventana habil (aproximacion: manana a la hora de inicio configurada, UTC-4 fijo
 *  para America/Santiago sin horario de verano desde 2019 — no maneja feriados chilenos,
 *  limitacion conocida documentada en DECISIONS.md). */
export function tomorrowAtBusinessHoursStart(from: Date = new Date()): string {
  const [h, m] = env.businessHoursStart.split(':').map(Number);
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours((h ?? 9) + 4, m ?? 0, 0, 0);
  return d.toISOString();
}

/** Backoff de reintento — 24h en produccion; configurable a segundos en tests
 *  (RETRY_BACKOFF_SECONDS_OVERRIDE, prompt §5.3 "en test, backoff configurable a segundos"). */
export function retryBackoffMs(): number {
  if (env.retryBackoffSecondsOverride !== null) return env.retryBackoffSecondsOverride * 1000;
  return 24 * 60 * 60 * 1000;
}
