/**
 * candidate-evaluator — Lambda disparada por cron (EventBridge en AWS real; en local, por
 * npm run local:demo o por el endpoint POST /internal/evaluator del server Fastify).
 * Ver docs/bpmn/flujo-1-seleccion-priorizacion.mmd para el flujo completo.
 *
 * Candidatos CRITICO de A (conexión) y B (declaraciones juradas), ADR-012.
 */

import { randomUUID } from 'node:crypto';
import { buildTableroApiClient } from '../../services/tablero-api-client.factory.js';
import {
  readCallSemaforo,
  isCourseCallable,
  type SemaforoStats,
} from '../../services/course-lookup.js';
import { computeIdempotencyKey } from '../../services/idempotency.js';
import { isKillSwitchActive, isDailyQuotaExceeded } from '../../services/guardrails.js';
import { FollowupRepository } from '../../repositories/followup-repository.js';
import { ContactRepository } from '../../repositories/contact-repository.js';
import { IdempotencyRepository } from '../../repositories/idempotency-repository.js';
import { sharedLocalQueue, type QueueClient } from '../../services/queue.js';
import { env } from '../../utils/env.js';
import { logger } from '../../utils/logger.js';
import { ok } from '../../utils/responses.js';
import { tomorrowAtBusinessHoursStart } from '../../utils/scheduling.js';
import { motivoDeSeccion } from '../../domain/followup.js';
import type { Followup } from '../../domain/followup.js';
import type { ApiResponse } from '../../utils/responses.js';
import type { TableroApiClient } from '../../services/tablero-api-client.js';

export interface EvaluatorDeps {
  /**
   * Fuente del Semaforo. Por defecto la factory (Mock editable en local). Inyectable como en el
   * dispatcher y el disparo manual, para que los tests fijen el dato que quieren evaluar en vez
   * de depender de en que modo quedo configurado el entorno.
   */
  tableroClient?: TableroApiClient;
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
  idempotencyRepository?: IdempotencyRepository;
  queue?: QueueClient;
}

export type DiscardMotivo =
  'sin_telefono' | 'do_not_call' | 'cooldown' | 'duplicado' | 'cuota_diaria_alcanzada';

export interface EvaluatorResult {
  killSwitch: boolean;
  dryRun: boolean;
  /** Contadores de la lectura del Semaforo: paginas, registros, OCs agrupadas y descartes. */
  semaforo: SemaforoStats | null;
  candidatesEvaluated: number;
  created: Array<{
    followupId: string;
    destinatarioPhone: string;
    orderNumber: string;
    estado: string;
  }>;
  discarded: Array<{ orderNumber: string; motivo: DiscardMotivo }>;
}

export async function runCandidateEvaluator(deps: EvaluatorDeps = {}): Promise<EvaluatorResult> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const idempotencyRepository = deps.idempotencyRepository ?? new IdempotencyRepository();
  const queue = deps.queue ?? sharedLocalQueue;

  const result: EvaluatorResult = {
    killSwitch: isKillSwitchActive(),
    dryRun: env.dryRun,
    semaforo: null,
    candidatesEvaluated: 0,
    created: [],
    discarded: [],
  };

  if (result.killSwitch) {
    logger.warn('candidate_evaluator_aborted_kill_switch');
    return result;
  }

  const tableroClient = deps.tableroClient ?? buildTableroApiClient();
  // Una sola lectura del Semaforo, con los gates de seccion A ya aplicados: `candidatoALlamada`
  // es `seccion A` + `nivel CRITICO`. Clasificar sin el gate metia cursos ya terminados.
  const { evaluaciones, stats } = await readCallSemaforo(tableroClient);
  result.semaforo = stats;

  let createdToday = 0;

  for (const evaluacion of evaluaciones) {
    if (!isCourseCallable(tableroClient, evaluacion)) continue;
    const group = evaluacion.group;

    result.candidatesEvaluated++;

    const candidateRecord = group.records.find((r) => r.phone_test_only);
    if (!candidateRecord?.phone_test_only) {
      result.discarded.push({ orderNumber: group.orderNumber, motivo: 'sin_telefono' });
      continue;
    }
    const phone = candidateRecord.phone_test_only;

    const contact = await contactRepository.getByPhone(phone);
    if (contact?.doNotCall) {
      result.discarded.push({ orderNumber: group.orderNumber, motivo: 'do_not_call' });
      continue;
    }

    if (contact?.lastContactedAt) {
      const elapsedMs = Date.now() - new Date(contact.lastContactedAt).getTime();
      if (elapsedMs < env.cooldownHours * 60 * 60 * 1000) {
        result.discarded.push({ orderNumber: group.orderNumber, motivo: 'cooldown' });
        continue;
      }
    }

    const idempotencyKey = computeIdempotencyKey({
      destinatario: phone,
      motivo: motivoDeSeccion(evaluacion.seccion),
      orderNumber: group.orderNumber,
    });

    const existingLock = await idempotencyRepository.get(idempotencyKey);
    if (existingLock) {
      result.discarded.push({ orderNumber: group.orderNumber, motivo: 'duplicado' });
      continue;
    }

    if (env.dryRun) {
      // DRY_RUN=true (default local, prompt §5.1): solo lista candidatos, no crea ni encola nada.
      result.created.push({
        followupId: '(dry-run — no se creo FOLLOWUP)',
        destinatarioPhone: phone,
        orderNumber: group.orderNumber,
        estado: 'DRY_RUN',
      });
      continue;
    }

    const followupId = randomUUID();
    const acquired = await idempotencyRepository.tryAcquireLock(idempotencyKey, followupId);
    if (!acquired) {
      result.discarded.push({ orderNumber: group.orderNumber, motivo: 'duplicado' });
      continue;
    }

    const willExceedQuota = isDailyQuotaExceeded(createdToday);
    const now = new Date().toISOString();
    const followup: Followup = {
      followupId,
      motivo: motivoDeSeccion(evaluacion.seccion),
      prioridad: 'ALTA',
      estado: 'READY',
      destinatarioId: group.clientId,
      destinatarioPhone: phone,
      oc: group.orderNumber,
      curso: group.courseName,
      intentos: 0,
      nextAttemptAt: willExceedQuota ? tomorrowAtBusinessHoursStart() : now,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
      origen: 'automatico',
      contexto: {
        clientId: group.clientId,
        clientName: candidateRecord.client_name,
        courseName: group.courseName,
        orderNumber: group.orderNumber,
        initCourse: group.initCourse,
        endCourse: group.endCourse,
        nivelDetectado: evaluacion.nivel,
        seccion: evaluacion.seccion ?? 'A_RIESGO_CONEXION',
      },
    };
    await followupRepository.create(followup);

    if (willExceedQuota) {
      result.discarded.push({ orderNumber: group.orderNumber, motivo: 'cuota_diaria_alcanzada' });
      continue;
    }

    await queue.publish({ followupId, messageGroupId: phone });
    createdToday++;
    result.created.push({
      followupId,
      destinatarioPhone: phone,
      orderNumber: group.orderNumber,
      estado: 'READY',
    });
  }

  logger.info('candidate_evaluator_finished', {
    paginas: stats.paginas,
    registros: stats.registrosRecibidos,
    registrosDescartados: stats.registrosDescartados,
    ocsAgrupadas: stats.ocsAgrupadas,
    ocsFueraDeSeccionA: stats.ocsFueraDeSeccionA,
    ocsSeccionA: stats.ocsSeccionA,
    porNivel: stats.porNivel,
    ocsCriticas: stats.ocsCriticas,
    candidatesEvaluated: result.candidatesEvaluated,
    created: result.created.length,
    discarded: result.discarded.length,
    dryRun: result.dryRun,
  });

  return result;
}

/** Adaptador HTTP (API GW / server local) — dispara el mismo runCandidateEvaluator. */
export async function handler(): Promise<ApiResponse> {
  const result = await runCandidateEvaluator();
  return ok(result);
}
