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

/**
 * Clave de dia habil en la zona horaria del negocio (`TIMEZONE`), formato `YYYY-MM-DD`.
 * La cuota diaria es una cuota de DIA DE NEGOCIO, no de dia UTC: si se usara UTC, la cuota
 * se reiniciaria a las 20:00/21:00 de Santiago, en mitad de la ventana horaria de llamada.
 */
export function businessDateKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
