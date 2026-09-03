/**
 * call-dispatcher — consume un mensaje de la cola (SQS real en AWS; cola en memoria en local,
 * ver src/services/queue.ts) y dispara la llamada. Ver docs/bpmn/flujo-2-ejecucion-llamada.mmd.
 *
 * El paso mas importante de todo el flujo: REVALIDAR contra el Semaforo antes de llamar
 * (prompt §5.3) — el dato puede tener hasta ~30 min de desfase; si ya se resolvio, se cancela
 * sin llamar. Sin este paso, el sistema "reclama" algo que la persona ya soluciono.
 */

import { buildTableroApiClient } from '../../services/tablero-api-client.factory.js';
import { buildElevenLabsClient } from '../../services/elevenlabs-client.factory.js';
import { findCourseEvaluation } from '../../services/course-lookup.js';
import { buildAgentDynamicVariables } from '../../services/agent-variables.js';
import { runGuardrails } from '../../services/guardrails.js';
import { FollowupRepository } from '../../repositories/followup-repository.js';
import { QuotaRepository } from '../../repositories/quota-repository.js';
import { ConditionalCheckFailedError } from '../../repositories/base-repository.js';
import { env } from '../../utils/env.js';
import { logger } from '../../utils/logger.js';
import { tomorrowAtBusinessHoursStart, retryBackoffMs } from '../../utils/scheduling.js';
import type { TableroApiClient } from '../../services/tablero-api-client.js';
import type {
  ElevenLabsClient,
  MockOutboundCallScenario,
} from '../../services/elevenlabs-client.js';

export type DispatchOutcome =
  | 'dialing'
  | 'resuelto_sin_llamada'
  | 'reagendado'
  | 'bloqueado'
  | 'error'
  | 'agotado'
  | 'obsoleto';

export interface DispatchResult {
  followupId: string;
  outcome: DispatchOutcome;
  motivo?: string;
  conversationId?: string;
  callSid?: string;
}

export interface DispatcherDeps {
  followupRepository?: FollowupRepository;
  quotaRepository?: QuotaRepository;
  tableroClient?: TableroApiClient;
  elevenLabsClient?: ElevenLabsClient;
  /** Solo para tests/demo: fuerza el escenario del mock (success/no_answer/busy/error). */
  forcedMockScenario?: MockOutboundCallScenario;
  now?: Date;
}

export async function dispatchFollowup(
  followupId: string,
  deps: DispatcherDeps = {},
): Promise<DispatchResult> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const quotaRepository = deps.quotaRepository ?? new QuotaRepository();
  const tableroClient = deps.tableroClient ?? buildTableroApiClient();
  const elevenLabsClient = deps.elevenLabsClient ?? buildElevenLabsClient(deps.forcedMockScenario);

  const followup = await followupRepository.getById(followupId);
  if (!followup) {
    return { followupId, outcome: 'obsoleto', motivo: 'followup_no_encontrado' };
  }
  if (followup.estado !== 'READY') {
    return { followupId, outcome: 'obsoleto', motivo: `estado_actual_${followup.estado}` };
  }

  // --- Revalidacion (prompt §5.3, el paso mas critico del flujo) ---
  const evaluation = await findCourseEvaluation(
    tableroClient,
    followup.contexto.clientId,
    followup.contexto.orderNumber,
  );

  if (!evaluation) {
    await followupRepository.setEstado(followupId, 'RESUELTO_SIN_LLAMADA');
    logger.info('dispatcher_resuelto_sin_llamada', {
      followupId,
      motivo: 'oc_ya_no_aparece_en_semaforo',
    });
    return { followupId, outcome: 'resuelto_sin_llamada', motivo: 'oc_ya_no_aparece_en_semaforo' };
  }

  if (evaluation.nivel !== 'CRITICO') {
    await followupRepository.setEstado(followupId, 'RESUELTO_SIN_LLAMADA');
    logger.info('dispatcher_resuelto_sin_llamada', {
      followupId,
      motivo: 'ya_no_es_critico',
      nivelActual: evaluation.nivel,
    });
    return { followupId, outcome: 'resuelto_sin_llamada', motivo: 'ya_no_es_critico' };
  }

  // --- Guardrails, revalidados (misma pieza que el evaluador, prompt §1.4) ---
  // El contador de cuota sale de la base (QuotaRepository), no de memoria: con un plan de muy
  // pocos minutos la cuota tiene que sobrevivir reinicios y ser la misma para todos los
  // caminos que originan una llamada. Este peek solo sirve para cortar temprano con un motivo
  // legible; el gate real es el `tryConsume` atomico de mas abajo.
  const quotaSnapshot = await quotaRepository.peek(env.dailyQuota, deps.now);
  const guard = runGuardrails(followup.destinatarioPhone, {
    now: deps.now,
    dailyCountSoFar: quotaSnapshot.usados,
  });
  if (!guard.allowed) {
    if (guard.motivo === 'fuera_de_ventana_horaria' || guard.motivo === 'cuota_diaria_alcanzada') {
      await followupRepository.setEstado(followupId, 'DIFERIDO', {
        nextAttemptAt: tomorrowAtBusinessHoursStart(),
      });
      return { followupId, outcome: 'reagendado', motivo: guard.motivo };
    }
    await followupRepository.setEstado(followupId, 'BLOQUEADO');
    return { followupId, outcome: 'bloqueado', motivo: guard.motivo };
  }

  // --- Anti doble disparo (escritura condicional READY->DIALING) ---
  try {
    await followupRepository.markDialing(followupId);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedError) {
      return { followupId, outcome: 'obsoleto', motivo: 'ya_tomado_por_otro_worker' };
    }
    throw err;
  }

  // --- Cuota diaria, gate atomico (despues del anti doble disparo: si otro worker se llevo
  // este followup, no queremos haber gastado un slot de cuota por nada) ---
  const consumed = await quotaRepository.tryConsume(env.dailyQuota, deps.now);
  if (!consumed.ok) {
    await followupRepository.setEstado(followupId, 'DIFERIDO', {
      nextAttemptAt: tomorrowAtBusinessHoursStart(),
    });
    logger.warn('dispatcher_reagendado_por_cuota', { followupId, usados: consumed.usados });
    return { followupId, outcome: 'reagendado', motivo: 'cuota_diaria_alcanzada' };
  }

  const callResult = await elevenLabsClient.startOutboundCall({
    agentId: env.elevenlabsAgentId,
    agentPhoneNumberId: env.elevenlabsAgentPhoneNumberId,
    toNumber: followup.destinatarioPhone,
    callRecordingEnabled: env.callRecordingEnabled,
    // Los numeros salen de la REVALIDACION (dato fresco del Semaforo), no del contexto
    // guardado en el FOLLOWUP, que puede tener horas de antiguedad.
    dynamicVariables: buildAgentDynamicVariables({
      clientName: followup.contexto.clientName,
      courseName: followup.contexto.courseName,
      orderNumber: followup.contexto.orderNumber,
      motivo: followup.motivo,
      contactoNombre: evaluation.contactoNombre,
      diasRestantes: evaluation.diasRestantes,
      pctConexion: evaluation.group.pctConexion,
    }),
  });

  if (!callResult.success) {
    const intentos = followup.intentos + 1;
    if (intentos >= env.maxAttempts) {
      await followupRepository.setEstado(followupId, 'AGOTADO', { intentos });
      logger.warn('dispatcher_agotado', { followupId, intentos, error: callResult.error });
      return { followupId, outcome: 'agotado', motivo: callResult.error };
    }
    const nextAttemptAt = new Date(Date.now() + retryBackoffMs()).toISOString();
    await followupRepository.setEstado(followupId, 'ERROR', { intentos, nextAttemptAt });
    return { followupId, outcome: 'error', motivo: callResult.error };
  }

  if (callResult.conversationId) {
    await followupRepository.linkConversation(callResult.conversationId, followupId);
  }

  logger.info('dispatcher_dialing', {
    followupId,
    conversationId: callResult.conversationId,
    callSid: callResult.callSid,
  });

  return {
    followupId,
    outcome: 'dialing',
    conversationId: callResult.conversationId,
    callSid: callResult.callSid,
  };
}
