/**
 * course-lookup — un solo lugar donde se hace la cadena
 * `tablero.search() -> groupOrders() -> getCourseWeek() -> clasificarConexion()`.
 *
 * Existe para que el dispatcher (revalidacion antes de llamar), el disparo manual y
 * `GET /api/tablero` compartan exactamente la misma lectura del Semaforo. No agrega ninguna
 * regla nueva: solo compone los modulos que ya existen (ver CLAUDE.md — la logica de urgencia
 * vive unicamente en `urgency-classifier.ts` y la de promocion/agregacion en
 * `order-status-promoter.ts`).
 */

import { groupOrders, type OrderGroup } from './order-status-promoter.js';
import { clasificarConexion, getCourseWeek } from './urgency-classifier.js';
import type { TableroApiClient } from './tablero-api-client.js';
import type { CourseWeek, UrgencyLevel } from '../domain/candidate.js';

export interface CourseEvaluation {
  group: OrderGroup;
  semana: CourseWeek;
  nivel: UrgencyLevel;
  /** Dias que le quedan al curso (negativo si ya termino). */
  diasRestantes: number;
  /** Contacto del curso — dato SINTETICO del fixture, no existe en tablero-api (UV-024). */
  contactoNombre: string | null;
}

/** Dias hasta `endCourse`, contra la medianoche UTC de hoy. */
export function diasRestantes(endCourse: string, now: Date = new Date()): number {
  const end = new Date(`${endCourse}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(end)) return 0;
  const hoy = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - hoy) / (24 * 60 * 60 * 1000));
}

function evaluate(group: OrderGroup): CourseEvaluation {
  const semana = getCourseWeek(group.initCourse, group.endCourse);
  return {
    group,
    semana,
    nivel: clasificarConexion(semana, group.pctConexion),
    diasRestantes: diasRestantes(group.endCourse),
    contactoNombre: group.records[0]?.contacto_nombre ?? null,
  };
}

/** Todos los cursos de la seccion A del Semaforo, ya agrupados y clasificados. */
export async function listCourseEvaluations(client: TableroApiClient): Promise<CourseEvaluation[]> {
  const records = await client.search({ seccion: 'A_RIESGO_CONEXION' });
  return groupOrders(records).map(evaluate);
}

/** Un curso puntual (`client_id` + `order_number`), o `null` si ya no aparece en el Semaforo. */
export async function findCourseEvaluation(
  client: TableroApiClient,
  clientId: string,
  orderNumber: string,
): Promise<CourseEvaluation | null> {
  const evaluations = await listCourseEvaluations(client);
  return (
    evaluations.find((e) => e.group.clientId === clientId && e.group.orderNumber === orderNumber) ??
    null
  );
}
