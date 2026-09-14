/**
 * course-lookup — el UNICO lugar donde se compone la cadena completa de lectura del Semaforo:
 *
 *   tablero.search()  ->  groupOrders()  ->  gateSeccion{A,B,C}()  ->  clasificar*()
 *
 * Existe para que el dispatcher (revalidacion antes de llamar), el disparo manual y
 * `GET /api/tablero` lean el Semaforo exactamente igual. No agrega ninguna regla propia: solo
 * ordena modulos que ya existen. Los umbrales viven en `urgency-classifier.ts`, la agregacion
 * en `order-status-promoter.ts` y los filtros de seccion en `semaforo-sections.ts`.
 *
 * El orden importa y es el del Semaforo real: primero se agrupa por OC, DESPUES se aplica el
 * filtro de seccion, y recien al final se clasifica. Clasificar antes de filtrar es lo que
 * hacia que cursos ya terminados entraran como candidatos a llamada.
 *
 * Las TRES secciones se resuelven en una sola pasada (`readSemaforoSecciones`) porque salen del
 * MISMO `search()`: el Semaforo real tambien baja el dataset una vez y arma las tres desde
 * `courseRows` (`StatusCursosPage.tsx:528/582/626`). Releerlo por seccion serian tres lecturas
 * de ~6.000 registros para el mismo dato.
 *
 * `readCallSemaforo` compone A y B para voz; C solo se muestra (ADR-012).
 */

import { groupOrders, type GroupOrdersStats, type OrderGroup } from './order-status-promoter.js';
import {
  diasDesdeElCierre,
  diasEsperandoAlOtic,
  gateSeccionA,
  gateSeccionB,
  gateSeccionC,
  type GateSeccionA,
  type MotivoFueraDeSeccionA,
  type MotivoFueraDeSeccionB,
  type MotivoFueraDeSeccionC,
} from './semaforo-sections.js';
import {
  clasificarConexion,
  clasificarDj,
  clasificarRectificacion,
  getCourseWeek,
} from './urgency-classifier.js';
import type { TableroApiClient } from './tablero-api-client.js';
import type { CourseWeek, UrgencyLevel } from '../domain/candidate.js';
import { logger } from '../utils/logger.js';
import { courseDaysRemaining } from '../utils/dates.js';
import { evaluarReglaDj, evaluarReglaDeLlamada } from './call-rules.js';

import type { CallSection } from '../domain/followup.js';

export interface CourseEvaluation {
  /** Ausente en evaluaciones antiguas: criterio A. */
  seccion?: CallSection;
  dj?: DjEvaluation;
  group: OrderGroup;
  semana: CourseWeek;
  nivel: UrgencyLevel;
  /** Dias que le quedan al curso (negativo si ya termino). */
  diasRestantes: number | undefined;
  /** Contacto del curso — dato SINTETICO del fixture, no existe en tablero-api (UV-024). */
  contactoNombre: string | null;
  /**
   * `true` si el Semaforo real lo mostraria en la seccion A: paso el gate de seccion Y su
   * nivel no es NORMAL (`StatusCursosPage.tsx:568` descarta NORMAL de la tabla).
   */
  visibleEnSemaforo: boolean;
  /** `true` si la sección de voz está en nivel CRITICO. */
  candidatoALlamada: boolean;
}

/** Todo lo que se puede contar de una lectura del Semaforo, para logs y para `/api/tablero`. */
export interface SemaforoStats extends GroupOrdersStats {
  paginas: number;
  truncado: boolean;
  ocsFueraDeSeccionA: Record<MotivoFueraDeSeccionA, number>;
  ocsSeccionA: number;
  porNivel: Record<UrgencyLevel, number>;
  ocsVisiblesEnSemaforo: number;
  ocsCriticas: number;
}

export interface SemaforoRead {
  /** Solo las OCs que pasaron el gate de seccion A, ya clasificadas. */
  evaluaciones: CourseEvaluation[];
  stats: SemaforoStats;
}

/**
 * Seccion B - Riesgo DJ, ya clasificada (`StatusCursosPage.tsx:582-624`). Una OC cerrada a la
 * que le faltan Declaraciones Juradas.
 *
 * `base` son los CONECTADOS, no los inscritos: el Semaforo divide `djp / sence_connections`.
 * Un alumno que nunca se conecto no tiene DJ que entregar.
 */
export interface DjEvaluation {
  group: OrderGroup;
  /** Dias de calendario desde `endCourse`. El gate ya garantizo que son > 3. */
  diasDesdeCierre: number;
  /** Alumnos con DJ emitida (`djp`). */
  conDj: number;
  /** Denominador: alumnos conectados. */
  base: number;
  /** `conDj / base` en 0-100. */
  pctDj: number;
  /** Cuantas DJ faltan. */
  pendientes: number;
  /** CRITICO > 7 dias, ALERTA > 3 — otra escala, sin relacion con la de conexion. */
  nivel: UrgencyLevel;
}

/**
 * Seccion C - Rectificacion, ya clasificada (`StatusCursosPage.tsx:626-660`). Una OC esperando
 * la OC Final del OTIC.
 */
export interface RectificacionEvaluation {
  group: OrderGroup;
  /** Dias desde `max(updated_at)` — el proxy del Semaforo, ver `diasEsperandoAlOtic`. */
  diasPendiente: number;
  /** CRITICO > 30 dias, ALERTA > 15. Tercera escala, tambien independiente. */
  nivel: UrgencyLevel;
}

/** Las tres secciones del Semaforo resueltas de una sola lectura. */
export interface SemaforoSecciones extends SemaforoRead {
  /** Seccion B - Riesgo DJ. Alimenta también readCallSemaforo. */
  seccionB: DjEvaluation[];
  /** Seccion C - Rectificacion. Se muestra; nunca decide una llamada. */
  seccionC: RectificacionEvaluation[];
}

/** Dias hasta `endCourse`, contra la medianoche UTC de hoy. */
export const diasRestantes = courseDaysRemaining;

/** Solo el banco Mock ofrece reglas de prueba. Las fuentes reales conservan CRITICO. */
export function isCourseCallable(client: TableroApiClient, evaluation: CourseEvaluation): boolean {
  const rules = client.getTestCallRules?.();
  if (evaluation.seccion === 'B_RIESGO_DJ')
    return evaluarReglaDj(
      Boolean(evaluation.dj),
      evaluation.nivel,
      evaluation.dj?.diasDesdeCierre ?? NaN,
      rules?.dj,
    ).dispara;
  return rules
    ? evaluarReglaDeLlamada(
        rules,
        evaluation.semana,
        evaluation.group.pctConexion,
        evaluation.nivel,
      ).dispara
    : evaluation.candidatoALlamada;
}

function evaluate(group: OrderGroup, gate: GateSeccionA): CourseEvaluation {
  const semana = getCourseWeek(group.initCourse, group.endCourse);
  const nivel = clasificarConexion(semana, group.pctConexion);
  const enSeccionA = gate.incluido;
  return {
    group,
    semana,
    nivel,
    diasRestantes: diasRestantes(group.endCourse),
    contactoNombre: group.records[0]?.contacto_nombre ?? null,
    visibleEnSemaforo: enSeccionA && nivel !== 'NORMAL',
    candidatoALlamada: enSeccionA && nivel === 'CRITICO',
  };
}

function evaluateDj(group: OrderGroup, nowMs: number): DjEvaluation {
  const diasDesdeCierre = diasDesdeElCierre(group.endCourse, nowMs);
  const base = group.totalConnections;
  return {
    group,
    diasDesdeCierre,
    conDj: group.djCount,
    base,
    pctDj: base > 0 ? (group.djCount / base) * 100 : 0,
    pendientes: base - group.djCount,
    nivel: clasificarDj(diasDesdeCierre),
  };
}

function evaluateRectificacion(group: OrderGroup, nowMs: number): RectificacionEvaluation {
  const diasPendiente = diasEsperandoAlOtic(group.lastUpdatedAt, nowMs);
  return { group, diasPendiente, nivel: clasificarRectificacion(diasPendiente) };
}

/**
 * Lee el Semaforo entero y devuelve las TRES secciones ya clasificadas, junto con los
 * contadores de todo lo que se descarto en el camino.
 *
 * Una sola llamada a `search()` para las tres: es el mismo dataset y bajarlo son ~6.000
 * registros. Las secciones se evaluan en el mismo recorrido y son independientes entre si —
 * una OC puede estar en A y no en B, en B y no en C, o en ninguna.
 */
export async function readSemaforoSecciones(client: TableroApiClient): Promise<SemaforoSecciones> {
  // `seccion` es un marcador semantico para el cliente fixture; el cliente HTTP no lo manda
  // porque el API real no lo conoce (ver tablero-api-client.http.ts).
  const { records, paginas, truncado } = await client.search({ seccion: 'A_RIESGO_CONEXION' });
  const { groups, stats: groupStats } = groupOrders(records);

  const now = Date.now();
  const ocsFueraDeSeccionA: Record<MotivoFueraDeSeccionA, number> = {
    no_en_ejecucion: 0,
    curso_terminado: 0,
    conexion_completa: 0,
  };
  const porNivel: Record<UrgencyLevel, number> = { NORMAL: 0, ALERTA: 0, CRITICO: 0 };

  const ocsFueraDeSeccionB: Record<MotivoFueraDeSeccionB, number> = {
    curso_no_terminado: 0,
    sin_conectados: 0,
    dj_completa: 0,
    cierre_reciente: 0,
  };
  const ocsFueraDeSeccionC: Record<MotivoFueraDeSeccionC, number> = {
    estado_no_espera_oc_final: 0,
    espera_reciente: 0,
  };

  const evaluaciones: CourseEvaluation[] = [];
  const seccionB: DjEvaluation[] = [];
  const seccionC: RectificacionEvaluation[] = [];

  for (const group of groups) {
    // Las tres secciones se preguntan por separado sobre la MISMA OC: el Semaforo no las trata
    // como excluyentes y quedarse con la primera que matchea escondería filas reales.
    const gate = gateSeccionA(group, now);
    if (gate.incluido) {
      const evaluation = evaluate(group, gate);
      porNivel[evaluation.nivel]++;
      evaluaciones.push(evaluation);
    } else {
      ocsFueraDeSeccionA[gate.motivo]++;
    }

    const gateB = gateSeccionB(group, now);
    if (gateB.incluido) {
      seccionB.push(evaluateDj(group, now));
    } else {
      ocsFueraDeSeccionB[gateB.motivo]++;
    }

    const gateC = gateSeccionC(group, now);
    if (gateC.incluido) {
      seccionC.push(evaluateRectificacion(group, now));
    } else {
      ocsFueraDeSeccionC[gateC.motivo]++;
    }
  }

  const stats: SemaforoStats = {
    ...groupStats,
    paginas,
    truncado,
    ocsFueraDeSeccionA,
    ocsSeccionA: evaluaciones.length,
    porNivel,
    ocsVisiblesEnSemaforo: evaluaciones.filter((e) => e.visibleEnSemaforo).length,
    ocsCriticas: evaluaciones.filter((e) => e.candidatoALlamada).length,
  };

  // Las secciones B y C no entran en `stats` a proposito: `SemaforoStats` es el contrato que ya
  // consumen `/api/tablero`, el dispatcher y sus tests, y es enteramente de la seccion A. Sus
  // contadores viajan aparte en el log, que es donde sirven para distinguir "hoy no hay filas"
  // de "la lectura esta rota".
  logger.info('semaforo_lectura', {
    stats,
    ocsSeccionB: seccionB.length,
    ocsFueraDeSeccionB,
    ocsSeccionC: seccionC.length,
    ocsFueraDeSeccionC,
  });
  return { evaluaciones, stats, seccionB, seccionC };
}

/**
 * Vista compatible de la sección A. Los caminos de voz usan readCallSemaforo.
 */
export async function readSemaforo(client: TableroApiClient): Promise<SemaforoRead> {
  const { evaluaciones, stats } = await readSemaforoSecciones(client);
  return { evaluaciones, stats };
}

/** Cursos de las secciones de voz A y B, ya agrupados y clasificados. */
export async function listCourseEvaluations(client: TableroApiClient): Promise<CourseEvaluation[]> {
  const { evaluaciones } = await readCallSemaforo(client);
  return evaluaciones;
}

/** Un curso puntual (`client_id` + `order_number`), o `null` si ya no aparece en la sección solicitada. */
export async function findCourseEvaluation(
  client: TableroApiClient,
  clientId: string,
  orderNumber: string,
  seccion?: CallSection,
): Promise<CourseEvaluation | null> {
  const evaluations = await listCourseEvaluations(client);
  return (
    evaluations.find(
      (e) =>
        e.group.clientId === clientId &&
        e.group.orderNumber === orderNumber &&
        (!seccion || (e.seccion ?? 'A_RIESGO_CONEXION') === seccion),
    ) ?? null
  );
}

/** Candidatos de voz A y B. C sigue siendo solo lectura; stats conserva el contrato de A. */
export async function readCallSemaforo(client: TableroApiClient): Promise<SemaforoRead> {
  const { evaluaciones, seccionB, stats } = await readSemaforoSecciones(client);
  return {
    stats,
    evaluaciones: [
      ...evaluaciones,
      ...seccionB.map((dj): CourseEvaluation => ({
        group: dj.group,
        seccion: 'B_RIESGO_DJ',
        dj,
        semana: getCourseWeek(dj.group.initCourse, dj.group.endCourse),
        nivel: dj.nivel,
        diasRestantes: diasRestantes(dj.group.endCourse),
        contactoNombre: dj.group.records[0]?.contacto_nombre ?? null,
        visibleEnSemaforo: true,
        candidatoALlamada: evaluarReglaDj(true, dj.nivel, dj.diasDesdeCierre).dispara,
      })),
    ],
  };
}
