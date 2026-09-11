/**
 * urgency-classifier — portado 1:1 desde el Semaforo real (StatusCursosPage.tsx:52-76,
 * auditado linea por linea contra useSenceData.ts). NO reinterpretar los umbrales ni el
 * calculo de semana: cualquier cambio de negocio debe venir acompanado de la actualizacion
 * equivalente en el repo del Semaforo, o se reintroduce la duplicacion que el prompt pide evitar
 * (ver prompt §1.4).
 *
 * Este es el UNICO lugar del proyecto donde vive esta logica.
 *
 * Contiene las TRES escalas del Semaforo, una por seccion, y no comparten nada entre si
 * (docs/SEMAFORO_INTEGRACION.md §3):
 *
 *   - Seccion A - Riesgo Conexion: `getCourseWeek` + `WEEK_THRESHOLDS` + `clasificarConexion`.
 *   - Seccion B - Riesgo DJ: `clasificarDj`, por DIAS desde el cierre del curso.
 *   - Seccion C - Rectificacion: `clasificarRectificacion`, por DIAS esperando al OTIC.
 *
 * Solo la seccion A puede terminar en una llamada. B y C se muestran y se editan en el Tablero
 * Mock, pero no alimentan ninguna regla de llamada (ver `call-rules.ts` y ADR-011).
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

// ---------------------------------------------------------------------------
// Seccion B - Riesgo DJ  (`StatusCursosPage.tsx:83-87`, `criticidadDj`)
// ---------------------------------------------------------------------------
//
// Otra pregunta y otra escala: ya no es "que tan atrasada va la conexion para la semana del
// curso", es "cuanto lleva este curso CERRADO sin que llegue la Declaracion Jurada". No
// comparte nada con `WEEK_THRESHOLDS` — no hay semanas ni porcentajes, solo dias desde el
// cierre. Mezclar las dos escalas fue el error que este archivo existe para evitar.
//
// El Semaforo rotula estos tres niveles CRITICO / EN RIESGO / PENDIENTE. Aca se devuelven como
// `UrgencyLevel` (CRITICO / ALERTA / NORMAL) para no inventar un segundo vocabulario de niveles
// en la UI: son los mismos tres escalones, con los mismos cortes.

export const DJ_THRESHOLDS = {
  /** `> 7` dias desde el cierre: CRITICO (el Semaforo lo pinta rojo). */
  criticoDias: 7,
  /** `> 3` dias: ALERTA ("EN RIESGO" en el Semaforo). Por debajo, NORMAL ("PENDIENTE"). */
  alertaDias: 3,
} as const;

export function clasificarDj(diasDesdeCierre: number): UrgencyLevel {
  if (diasDesdeCierre > DJ_THRESHOLDS.criticoDias) return 'CRITICO';
  if (diasDesdeCierre > DJ_THRESHOLDS.alertaDias) return 'ALERTA';
  return 'NORMAL';
}

// ---------------------------------------------------------------------------
// Seccion C - Rectificacion  (`StatusCursosPage.tsx:1245` y `:1258`)
// ---------------------------------------------------------------------------
//
// Tercera escala, tambien en dias, tambien sin relacion con las otras dos: cuanto lleva la OC
// esperando la OC Final del OTIC. En el Semaforo no hay una funcion `criticidadRectificacion`:
// los cortes estan en el color de la celda de "Dias Pendiente" (`> 30` rojo, `> 15` amarillo).
// Se portan aca, con nombre, para que sean una regla y no un estilo.

export const RECTIFICACION_THRESHOLDS = {
  /** `> 30` dias esperando al OTIC: CRITICO. */
  criticoDias: 30,
  /** `> 15` dias: ALERTA. Por debajo, NORMAL. */
  alertaDias: 15,
} as const;

export function clasificarRectificacion(diasPendiente: number): UrgencyLevel {
  if (diasPendiente > RECTIFICACION_THRESHOLDS.criticoDias) return 'CRITICO';
  if (diasPendiente > RECTIFICACION_THRESHOLDS.alertaDias) return 'ALERTA';
  return 'NORMAL';
}
