/**
 * order-status-promoter — portado 1:1 desde useSenceData.ts:93-113 / InicioBPage.tsx:590-618.
 * En el Semaforo real esta logica esta DUPLICADA en esos dos archivos (bug conocido, ver
 * prompt §1.4) — aqui vive en UN solo modulo.
 *
 * Tambien incluye la agregacion por OC (client_id + order_number) que el Semaforo hace antes
 * de calcular pct_conexion a nivel de curso, porque tablero-api entrega registros por ALUMNO,
 * no agregados (ver docs/context/PROJECT_CONTEXT.md).
 */

import type { TableroRecord } from '../domain/candidate.js';

export const DEAD_ESTADOS = new Set(['BAJA', 'ANULADA', 'ELIMINADA', 'FACTURADA', 'FACTURADO']);

export const MANUAL_ESTADOS = new Set([
  'ESPERA OC FINAL',
  'ESPERA OC FINAL / RECTIFICACIÓN',
  'SOLICITUD OC FINAL ENVIADA',
  'EN RECTIFICACION',
  'EN RECTIFICACIÓN',
  'RECTIFICACION',
  'ENVIADA A FACTURAR',
  'ENVIAR_A_FACTURAR',
  'REVISAR',
  'FACTURADA',
  'BAJA',
  'ANULADA',
]);

/** Estados que excluyen una OC de la agregacion (adicional a DEAD/MANUAL, ver prompt §5.2). */
export const INACTIVE_STATUSES = new Set(['REVISAR', 'BAJA', 'ANULADA']);

export function promoteOrderStatus(record: {
  order_status: string;
  init_course: string;
  end_course: string;
}): string {
  const norm = (record.order_status ?? '').trim().toUpperCase();
  if (DEAD_ESTADOS.has(norm) || MANUAL_ESTADOS.has(norm)) return record.order_status;

  const ft = new Date(record.end_course);
  const fi = new Date(record.init_course);
  const today = new Date();

  if (!isNaN(ft.getTime()) && ft < today) return 'OBTENIENDO DJ';
  if (!isNaN(fi.getTime()) && fi <= today) return 'CURSO EN OPERACIÓN';
  if (!isNaN(fi.getTime()) && fi > today) return 'NO INICIADA';
  return record.order_status;
}

export interface OrderGroup {
  clientId: string;
  orderNumber: string;
  courseName: string;
  initCourse: string;
  endCourse: string;
  promotedOrderStatus: string;
  enrolledCount: number;
  totalConnections: number;
  pctConexion: number;
  records: TableroRecord[];
}

/**
 * Agrupa registros por curso (client_id + order_number).
 *
 * Orden de operaciones (importante, ver prompt §5.2):
 *  1. Excluye OCs internacionales (order_number empieza con "INT").
 *  2. Corre promoteOrderStatus ANTES de agregar (evita falsos positivos con order_status vacio).
 *  3. Excluye grupos cuyo order_status promovido normalizado esta en INACTIVE_STATUSES.
 *  4. Agrega inscritos (enrolled_count) y sence_connections para calcular pct_conexion.
 */
export function groupOrders(records: TableroRecord[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();

  for (const record of records) {
    if (record.order_number.toUpperCase().startsWith('INT')) continue;

    const promoted = promoteOrderStatus(record);
    const normPromoted = promoted.trim().toUpperCase();
    if (INACTIVE_STATUSES.has(normPromoted)) continue;

    const key = `${record.client_id}#${record.order_number}`;
    const existing = groups.get(key);
    if (existing) {
      existing.enrolledCount += record.enrolled_count;
      existing.totalConnections += record.sence_connections;
      existing.records.push(record);
    } else {
      groups.set(key, {
        clientId: record.client_id,
        orderNumber: record.order_number,
        courseName: record.course_name,
        initCourse: record.init_course,
        endCourse: record.end_course,
        promotedOrderStatus: promoted,
        enrolledCount: record.enrolled_count,
        totalConnections: record.sence_connections,
        pctConexion: 0,
        records: [record],
      });
    }
  }

  for (const group of groups.values()) {
    group.pctConexion =
      group.enrolledCount > 0 ? (group.totalConnections / group.enrolledCount) * 100 : 0;
  }

  return Array.from(groups.values());
}
