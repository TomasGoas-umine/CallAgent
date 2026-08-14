/**
 * Calculo de idempotency_key para candidatos del evaluador (prompt §5.1).
 *
 * idempotency_key = sha256(destinatario + motivo + order_number + ventana_semanal)
 *
 * La "ventana semanal" ancla la key a una semana ISO especifica, para que el mismo caso
 * (mismo destinatario + motivo + OC) no genere un FOLLOWUP nuevo cada vez que corre el
 * evaluador dentro de la misma semana, pero si permita uno nuevo la semana siguiente si
 * la situacion persiste.
 */

import { createHash } from 'node:crypto';

/** Semana ISO (formato "YYYY-Www"), UTC. */
export function isoWeekWindow(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // lunes=0 ... domingo=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // jueves de esa semana ISO
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeIdempotencyKey(params: {
  destinatario: string;
  motivo: string;
  orderNumber: string;
  now?: Date;
}): string {
  const ventanaSemanal = isoWeekWindow(params.now);
  const raw = `${params.destinatario}|${params.motivo}|${params.orderNumber}|${ventanaSemanal}`;
  return createHash('sha256').update(raw).digest('hex');
}
