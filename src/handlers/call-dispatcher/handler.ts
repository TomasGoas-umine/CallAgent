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
import { groupOrders } from '../../services/order-status-promoter.js';
import { getCourseWeek, clasificarConexion } from '../../services/urgency-classifier.js';
import { runGuardrails } from '../../services/guardrails.js';
import { FollowupRepository } from '../../repositories/followup-repository.js';
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
  const records = await tableroClient.search({ seccion: 'A_RIESGO_CONEXION' });
  const groups = groupOrders(records);
  const group = groups.find(
    (g) =>
      g.clientId === followup.contexto.clientId && g.orderNumber === followup.contexto.orderNumber,
  );

  if (!group) {
    await followupRepository.setEstado(followupId, 'RESUELTO_SIN_LLAMADA');
    logger.info('dispatcher_resuelto_sin_llamada', {
      followupId,
      motivo: 'oc_ya_no_aparece_en_semaforo',
    });
    return { followupId, outcome: 'resuelto_sin_llamada', motivo: 'oc_ya_no_aparece_en_semaforo' };
  }

  const semana = getCourseWeek(group.initCourse, group.endCourse);
  const nivel = clasificarConexion(semana, group.pctConexion);
  if (nivel !== 'CRITICO') {
    await followupRepository.setEstado(followupId, 'RESUELTO_SIN_LLAMADA');
    logger.info('dispatcher_resuelto_sin_llamada', {
      followupId,
      motivo: 'ya_no_es_critico',
      nivelActual: nivel,
    });
    return { followupId, outcome: 'resuelto_sin_llamada', motivo: 'ya_no_es_critico' };
  }

  // --- Guardrails, revalidados (misma pieza que el evaluador, prompt §1.4) ---
  const guard = runGuardrails(followup.destinatarioPhone, { now: deps.now });
  if (!guard.allowed) {
    if (guard.motivo === 'fuera_de_ventana_horaria') {
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

  const callResult = await elevenLabsClient.startOutboundCall({
    agentId: env.elevenlabsAgentId,
    agentPhoneNumberId: env.elevenlabsAgentPhoneNumberId,
    toNumber: followup.destinatarioPhone,
    dynamicVariables: {
      nombre_cliente: followup.contexto.clientName,
      curso: followup.contexto.courseName,
      orden_compra: followup.contexto.orderNumber,
      motivo: followup.motivo,
    },
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
