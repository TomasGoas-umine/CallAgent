/**
 * urgency-classifier — portado 1:1 desde el Semaforo real (StatusCursosPage.tsx:52-76,
 * auditado linea por linea contra useSenceData.ts). NO reinterpretar los umbrales ni el
 * calculo de semana: cualquier cambio de negocio debe venir acompanado de la actualizacion
 * equivalente en el repo del Semaforo, o se reintroduce la duplicacion que el prompt pide evitar
 * (ver prompt §1.4).
 *
 * Este es el UNICO lugar del proyecto donde vive esta logica.
 */

import type { CourseWeek, UrgencyLevel } from '../domain/candidate.js';

export function getCourseWeek(fechaInicio: string, fechaTermino: string): CourseWeek {
  const start = new Date(fechaInicio).getTime();
  const end = new Date(fechaTermino).getTime();
  const now = Date.now();
  if (!start || !end || end <= start) return 1;
  const progress = (now - start) / (end - start);
  if (progress < 0.25) return 1;
  if (progress < 0.5) return 2;
  if (progress < 0.75) return 3;
  return 4;
}

export const WEEK_THRESHOLDS = {
  1: { expected: 20, alertaMin: 20, criticoBelow: -1 },
  2: { expected: 60, alertaMin: 55, criticoBelow: 55 },
  3: { expected: 90, alertaMin: 80, criticoBelow: 80 },
  4: { expected: 98, alertaMin: 90, criticoBelow: 90 },
} as const;

export function clasificarConexion(semana: CourseWeek, pctConexion: number): UrgencyLevel {
  const t = WEEK_THRESHOLDS[semana] ?? WEEK_THRESHOLDS[4];
  if (pctConexion >= t.expected) return 'NORMAL';
  if (t.criticoBelow >= 0 && pctConexion < t.criticoBelow) return 'CRITICO';
  return 'ALERTA';
}
