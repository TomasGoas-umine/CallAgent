/**
 * order-status-promoter — portado 1:1 desde el Semaforo real (`useSenceData.ts`, repo
 * `micrositio-operaciones-tablero-sence`). En el Semaforo esta logica esta DUPLICADA entre
 * `useSenceData.ts` e `InicioBPage.tsx` (riesgo conocido, marcado Alto en la auditoria) —
 * aqui vive en UN solo modulo.
 *
 * Contiene dos cosas, en el mismo orden que el original:
 *   1. `promoteOrderStatus` — recalculo del estado por fechas (`useSenceData.ts:97-106`).
 *   2. `groupOrders` — la agregacion por OC (`useSenceData.ts:120-222`), porque `tablero-api`
 *      entrega registros por ALUMNO, no agregados.
 *
 * OJO con tres detalles que parecen cosmeticos y no lo son (los tres fueron bugs reales, ver
 * docs/SEMAFORO_INTEGRACION.md §9):
 *   - Los inscritos se CUENTAN, no se leen de un campo. No existe `enrolled_count` en la API.
 *   - Se cuenta `sence_connections === 1`, no `> 0` ni una suma.
 *   - Los DEAD_ESTADOS se descartan ANTES de agregar. En prod `FACTURADA` es la mayoria
 *     absoluta de los registros (498 de 801 en el snapshot del 2026-09-09): si no se filtran,
 *     inflan los inscritos y hunden el porcentaje de conexion de cualquier OC mixta.
 *
 * La agregacion tambien acumula `djCount` y `lastUpdatedAt`, que no los usa la seccion A sino
 * las secciones B (Riesgo DJ) y C (Rectificacion) — ver `semaforo-sections.ts`. Se calculan aca
 * y no en cada seccion porque el recorrido por registro es UNO solo, igual que en el original.
 *
 * Cualquier cambio de umbral o de regla aca debe venir acompanado del cambio equivalente en el
 * repo del Semaforo, o se reintroduce la divergencia que este modulo existe para evitar.
 */

import type { TableroRecord } from '../domain/candidate.js';
import { normalizeCourseDate, normalizeTimestamp, toEpochMs } from '../utils/dates.js';

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

/**
 * Alumnos que NO cuentan como inscritos activos (HOT-137+139 del Semaforo): fueron removidos
 * de la OC Final o estan en revision. Se registran en `statusCounts` pero no suman a inscritos
 * ni a conectados (`useSenceData.ts:167`).
 */
export const INACTIVE_STATUSES = new Set(['REVISAR', 'BAJA', 'ANULADA']);

/** Prefijos de OC de otros equipos que comparten las tablas DynamoDB (HOT-183 del Semaforo). */
export const EXCLUDED_ORDER_PREFIXES = ['INT'];

export function isExcludedOrder(orderNumber: string | number | null | undefined): boolean {
  if (orderNumber === null || orderNumber === undefined || orderNumber === '') return false;
  const upper = String(orderNumber).toUpperCase().trim();
  return EXCLUDED_ORDER_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Normaliza las fechas de un registro crudo de tablero-api. Se aplica ANTES de promover el
 * estado y de agregar, porque las dos cosas comparan fechas (ver `src/utils/dates.ts`).
 */
export function normalizeRecord(record: TableroRecord): TableroRecord {
  return {
    ...record,
    init_course: normalizeCourseDate(record.init_course),
    end_course: normalizeCourseDate(record.end_course),
    updated_at: normalizeTimestamp(record.updated_at) ?? '',
  };
}

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
  clientName: string;
  orderNumber: string;
  courseName: string;
  /**
   * OTIC de la OC, tomado del PRIMER registro del grupo igual que el Semaforo
   * (`useSenceData.ts:149`). No entra en ninguna regla: lo muestra la seccion C.
   */
  otic: string;
  initCourse: string;
  endCourse: string;
  /** Estado a nivel OC: el mas frecuente entre los alumnos ACTIVOS (`useSenceData.ts:187-193`). */
  promotedOrderStatus: string;
  /** Inscritos activos — CONTADOS, excluyendo REVISAR/BAJA/ANULADA. */
  enrolledCount: number;
  /** Alumnos con `sence_connections === 1`. */
  totalConnections: number;
  /** Porcentaje 0-100. El Semaforo lo guarda como fraccion 0-1 y lo multiplica al clasificar. */
  pctConexion: number;
  /**
   * Alumnos ACTIVOS con `dj === 1` (`useSenceData.ts:177`, ahi se llama `djp`). Es el numerador
   * de la seccion B: el Semaforo compara `djp / conectados`, no `djp / inscritos`.
   */
  djCount: number;
  /**
   * `max(updated_at)` de los registros de la OC, en ISO. Es el proxy que la seccion C usa para
   * saber hace cuanto se pidio la rectificacion (`StatusCursosPage.tsx:632-645`): no hay una
   * fecha de "se marco ESPERA OC FINAL" en el dato, y `end_course` daba numeros absurdos.
   * `''` si ningun registro trae una fecha legible.
   */
  lastUpdatedAt: string;
  records: TableroRecord[];
}

/** Contadores de lo que entro y lo que se cayo en el camino — para observabilidad. */
export interface GroupOrdersStats {
  registrosRecibidos: number;
  registrosDescartados: {
    estadoMuerto: number;
    sinOrderNumber: number;
    ocExcluida: number;
    alumnoInactivo: number;
  };
  registrosAgregados: number;
  ocsAgrupadas: number;
}

export interface GroupOrdersResult {
  groups: OrderGroup[];
  stats: GroupOrdersStats;
}

interface Accumulator {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  otic: string;
  initCourse: string;
  endCourse: string;
  enrolledCount: number;
  totalConnections: number;
  djCount: number;
  /** Epoch ms del `updated_at` mas reciente del grupo; 0 si ninguno era legible. */
  lastUpdatedMs: number;
  statusCounts: Record<string, number>;
  /**
   * Estado del PRIMER registro de la OC. Es el fallback cuando la OC no tiene ningun alumno
   * activo (ej. todos en REVISAR): el Semaforo deja `m.order_status` con el valor inicial
   * (`useSenceData.ts:149` + `:189`), NO lo vacia. Vaciarlo seria peligroso: el gate de la
   * seccion A trata el estado vacio como "en ejecucion", asi que una OC enteramente dada de
   * baja entraria al tablero como si estuviera corriendo.
   */
  estadoInicial: string;
  records: TableroRecord[];
}

/**
 * Agrupa registros por curso (cliente + OC), replicando el orden de operaciones de
 * `useSenceData.ts`:
 *
 *  1. Normaliza fechas (defensa propia, el Semaforo lo hace con `parseLocalDate`).
 *  2. Promueve `order_status` por fechas — ANTES de filtrar, para no descartar por un estado
 *     vacio que en realidad correspondia a un curso en operacion.
 *  3. Descarta DEAD_ESTADOS (paso 2 de `filteredRecords`).
 *  4. Descarta OCs sin numero y OCs de otros equipos (prefijo `INT`).
 *  5. Agrupa por `client_id || client_name || 'Sin cliente'` + `order_number`, contando
 *     inscritos y conectados, y saltando de esas cuentas a los alumnos INACTIVE.
 *  6. Deriva el estado de la OC como el mas frecuente entre los alumnos activos.
 */
export function groupOrders(records: TableroRecord[]): GroupOrdersResult {
  const stats: GroupOrdersStats = {
    registrosRecibidos: records.length,
    registrosDescartados: { estadoMuerto: 0, sinOrderNumber: 0, ocExcluida: 0, alumnoInactivo: 0 },
    registrosAgregados: 0,
    ocsAgrupadas: 0,
  };

  const groups = new Map<string, Accumulator>();

  for (const raw of records) {
    const record = normalizeRecord(raw);
    const promoted = promoteOrderStatus(record);
    const normPromoted = promoted.trim().toUpperCase();

    if (DEAD_ESTADOS.has(normPromoted)) {
      stats.registrosDescartados.estadoMuerto++;
      continue;
    }

    const ocValue = record.order_number ? String(record.order_number) : '';
    if (!ocValue) {
      stats.registrosDescartados.sinOrderNumber++;
      continue;
    }
    if (isExcludedOrder(ocValue)) {
      stats.registrosDescartados.ocExcluida++;
      continue;
    }

    const clientKey = record.client_id || record.client_name || 'Sin cliente';
    const key = `${clientKey}||${ocValue}`;

    let acc = groups.get(key);
    if (!acc) {
      acc = {
        clientId: clientKey,
        clientName: record.client_name || 'Sin cliente',
        orderNumber: ocValue,
        courseName: record.course_name || ocValue,
        otic: record.otic || '',
        initCourse: record.init_course || '',
        endCourse: record.end_course || '',
        enrolledCount: 0,
        totalConnections: 0,
        djCount: 0,
        lastUpdatedMs: 0,
        statusCounts: {},
        estadoInicial: promoted,
        records: [],
      };
      groups.set(key, acc);
    }

    // El registro entra al grupo aunque sea inactivo: el disparador necesita poder mirar a
    // todos los alumnos de la OC, y `statusCounts` necesita verlos para derivar el estado.
    acc.records.push({ ...record, order_status: promoted });

    // `updated_at` se acumula ANTES del salto por alumno inactivo: el Semaforo saca el maximo de
    // `filteredRecords` (todos los registros vivos de la OC), no solo de los activos.
    const updatedMs = toEpochMs(record.updated_at);
    if (updatedMs !== null && updatedMs > acc.lastUpdatedMs) acc.lastUpdatedMs = updatedMs;

    const recStatus = normPromoted;
    if (recStatus) acc.statusCounts[recStatus] = (acc.statusCounts[recStatus] ?? 0) + 1;

    if (INACTIVE_STATUSES.has(recStatus)) {
      stats.registrosDescartados.alumnoInactivo++;
      continue;
    }

    acc.enrolledCount++;
    // `=== 1`, igual que el Semaforo. Un `> 0` o una suma darian otro numero.
    if (Number(record.sence_connections) === 1) acc.totalConnections++;
    // `=== 1` otra vez, y solo entre activos (`useSenceData.ts:177`).
    if (Number(record.dj) === 1) acc.djCount++;
    stats.registrosAgregados++;
  }

  const result: OrderGroup[] = [];
  for (const acc of groups.values()) {
    const activos = Object.entries(acc.statusCounts).filter(([s]) => !INACTIVE_STATUSES.has(s));
    activos.sort((a, b) => b[1] - a[1]);
    const promotedOrderStatus =
      activos.length > 0 ? (activos[0]?.[0] ?? acc.estadoInicial) : acc.estadoInicial;

    result.push({
      clientId: acc.clientId,
      clientName: acc.clientName,
      orderNumber: acc.orderNumber,
      courseName: acc.courseName,
      otic: acc.otic,
      initCourse: acc.initCourse,
      endCourse: acc.endCourse,
      promotedOrderStatus,
      enrolledCount: acc.enrolledCount,
      totalConnections: acc.totalConnections,
      pctConexion: acc.enrolledCount > 0 ? (acc.totalConnections / acc.enrolledCount) * 100 : 0,
      djCount: acc.djCount,
      lastUpdatedAt: acc.lastUpdatedMs > 0 ? new Date(acc.lastUpdatedMs).toISOString() : '',
      records: acc.records,
    });
  }

  stats.ocsAgrupadas = result.length;
  return { groups: result, stats };
}
