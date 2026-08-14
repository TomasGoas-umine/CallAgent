/**
 * guardrails — un solo lugar para las reglas de seguridad/negocio que aplican TANTO al
 * evaluador (antes de crear el FOLLOWUP) COMO al dispatcher (justo antes de llamar,
 * revalidando — ver prompt §5.1 y §5.3). No se duplica esta logica en los dos handlers.
 *
 * Todos los parametros vienen de env vars (prompt §9): nunca constantes fijas en el codigo.
 */

import { env } from '../utils/env.js';

export interface GuardrailContext {
  now?: Date;
  dailyCountSoFar?: number;
}

export interface GuardrailResult {
  allowed: boolean;
  motivo?:
    | 'kill_switch'
    | 'fuera_de_ventana_horaria'
    | 'cuota_diaria_alcanzada'
    | 'no_en_allowlist'
    | 'do_not_call';
}

/** Kill switch — en AWS real seria un parametro SSM; en local, KILL_SWITCH=true/false. */
export function isKillSwitchActive(): boolean {
  return env.killSwitch;
}

function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

/**
 * Ventana horaria 09:00-19:00 America/Santiago, dias habiles (lunes-viernes).
 * No maneja feriados chilenos en este MVP (fuera de alcance — anotado como limitacion conocida).
 */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: env.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  if (!isWeekday) return false;

  const nowMinutes = hour * 60 + minute;
  const start = parseHm(env.businessHoursStart);
  const end = parseHm(env.businessHoursEnd);
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

/** dev/qa: allowlist obligatoria y no vacia. En prod se relajaria por decision de negocio (§9). */
export function isNumberAllowed(phone: string): boolean {
  if (env.allowlistNumbers.length === 0) return false;
  return env.allowlistNumbers.includes(phone);
}

export function isDailyQuotaExceeded(countSoFar: number): boolean {
  return countSoFar >= env.dailyQuota;
}

/**
 * Corre todos los guardrails en el orden del BPMN (flujo-1 / flujo-2). Se puede llamar
 * tanto desde el evaluador como desde el dispatcher (revalidacion) con el mismo resultado.
 */
export function runGuardrails(phone: string, ctx: GuardrailContext = {}): GuardrailResult {
  if (isKillSwitchActive()) return { allowed: false, motivo: 'kill_switch' };
  if (!isWithinBusinessHours(ctx.now))
    return { allowed: false, motivo: 'fuera_de_ventana_horaria' };
  if (!isNumberAllowed(phone)) return { allowed: false, motivo: 'no_en_allowlist' };
  if (ctx.dailyCountSoFar !== undefined && isDailyQuotaExceeded(ctx.dailyCountSoFar)) {
    return { allowed: false, motivo: 'cuota_diaria_alcanzada' };
  }
  return { allowed: true };
}
