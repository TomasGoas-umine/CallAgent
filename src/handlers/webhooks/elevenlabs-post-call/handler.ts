/**
 * webhooks/elevenlabs-post-call — recibe el resultado de la llamada (transcripcion, analysis,
 * data_collection_results, evaluation_criteria_results ya incluidos por ElevenLabs — no se
 * construye ningun procesador de LLM propio, prompt §3.2). Ver
 * docs/bpmn/flujo-3-procesamiento-post-llamada.mmd.
 *
 * Responde SIEMPRE 200 si el procesamiento fue correcto (ElevenLabs deshabilita el webhook
 * tras 10+ fallos consecutivos, prompt §5.4) — solo devuelve 401 si la firma es invalida.
 */

import { verifyElevenLabsSignature } from '../../../auth/elevenlabs-signature-validator.js';
import { classifyCallOutcome } from '../../../services/call-outcome-classifier.js';
import { FollowupRepository } from '../../../repositories/followup-repository.js';
import { ContactRepository } from '../../../repositories/contact-repository.js';
import { env } from '../../../utils/env.js';
import { logger } from '../../../utils/logger.js';
import { retryBackoffMs } from '../../../utils/scheduling.js';
import { ok, badRequest, unauthorized } from '../../../utils/responses.js';
import type { ElevenLabsPostCallPayload } from '../../../domain/call.js';
import type { ApiResponse } from '../../../utils/responses.js';

export interface ElevenLabsWebhookDeps {
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
  webhookSecret?: string;
}

const NOT_ANSWERED_OUTCOMES = new Set(['no_answer', 'busy', 'voicemail', 'invalid_number']);

export async function handleElevenLabsPostCall(
  rawBody: string,
  signatureHeader: string | undefined,
  deps: ElevenLabsWebhookDeps = {},
): Promise<ApiResponse> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const secret = deps.webhookSecret ?? env.elevenlabsWebhookSecret;

  const verification = verifyElevenLabsSignature(signatureHeader, rawBody, secret);
  if (!verification.valid) {
    logger.warn('elevenlabs_webhook_signature_invalid', { reason: verification.reason });
    return unauthorized(`invalid_signature: ${verification.reason}`);
  }

  let payload: ElevenLabsPostCallPayload;
  try {
    payload = JSON.parse(rawBody) as ElevenLabsPostCallPayload;
  } catch {
    return badRequest('invalid_json_body');
  }

  const conversationId = payload.data?.conversation_id;
  if (!conversationId) {
    return badRequest('missing_conversation_id');
  }

  const followupId = await followupRepository.findFollowupIdByConversation(conversationId);
  if (!followupId) {
    // No es un fallo del webhook (podria ser una llamada de otro entorno/prueba manual en
    // ElevenLabs) — se responde 200 igual, para no gatillar el auto-disable de ElevenLabs.
    logger.warn('elevenlabs_webhook_unknown_conversation', { conversationId });
    return ok({ status: 'ignored', reason: 'unknown_conversation_id' });
  }

  const classification = classifyCallOutcome(payload);

  const recordResult = await followupRepository.recordCall({
    followupId,
    conversationId,
    callSid: payload.data.metadata?.call_sid ?? null,
    status: payload.data.status,
    durationSeconds: payload.data.metadata?.call_duration_secs ?? null,
    startedAt: null,
    endedAt: new Date(payload.event_timestamp * 1000).toISOString(),
    dataCollection: classification.dataCollection,
    evaluation: payload.data.analysis?.evaluation_criteria_results ?? {},
    transcriptS3Key: null,
  });

  if (recordResult === 'already_exists') {
    // Idempotencia (prompt §1.5): mismo conversation_id ya procesado, ElevenLabs reintento la entrega.
    logger.info('elevenlabs_webhook_duplicate_ignored', { conversationId, followupId });
    return ok({ status: 'already_processed', followupId, conversationId });
  }

  const followup = await followupRepository.getById(followupId);
  if (!followup) {
    logger.error('elevenlabs_webhook_followup_missing', { followupId, conversationId });
    return ok({ status: 'processed_but_followup_missing', followupId });
  }

  switch (classification.outcome) {
    case 'human_escalation':
      // Bloquea reintentos automaticos (prompt §5.4 — nunca escalar y seguir reintentando en
      // paralelo). La persistencia de un registro ESCALATION dedicado (repositorio propio)
      // queda como siguiente ticket (docs/spec.csv) — este MVP registra la evidencia en logs
      // estructurados con el mismo shape del dominio Escalation.
      await followupRepository.setEstado(followupId, 'ESCALADO');
      logger.warn('followup_escalado', {
        followupId,
        origen: 'situacion_urgente_o_solicito_humano',
        dataCollection: classification.dataCollection,
      });
      break;

    case 'do_not_call':
      await contactRepository.markDoNotCall(followup.destinatarioPhone);
      await followupRepository.setEstado(followupId, 'CERRADO');
      break;

    case 'resolved':
      await contactRepository.markContacted(followup.destinatarioPhone);
      await followupRepository.setEstado(followupId, 'RESUELTO');
      break;

    case 'no_answer':
    case 'busy':
    case 'voicemail':
    case 'invalid_number': {
      const intentos = followup.intentos + 1;
      if (intentos >= env.maxAttempts) {
        await followupRepository.setEstado(followupId, 'AGOTADO', { intentos });
      } else {
        const nextAttemptAt = new Date(Date.now() + retryBackoffMs()).toISOString();
        // Vuelve a READY para que flujo-2 lo vuelva a tomar en el proximo intento.
        await followupRepository.setEstado(followupId, 'READY', { intentos, nextAttemptAt });
      }
      break;
    }

    case 'technical_problem':
    case 'scheduling_problem':
    case 'training_need_detected':
    case 'follow_up_required':
      await contactRepository.markContacted(followup.destinatarioPhone);
      await followupRepository.setEstado(followupId, 'FOLLOW_UP');
      break;

    case 'contacted':
    case 'unknown':
    default:
      await contactRepository.markContacted(followup.destinatarioPhone);
      await followupRepository.setEstado(followupId, 'CERRADO');
      break;
  }

  logger.info('elevenlabs_webhook_processed', {
    followupId,
    conversationId,
    outcome: classification.outcome,
  });

  const isNotAnswered = NOT_ANSWERED_OUTCOMES.has(classification.outcome);
  return ok({ status: 'processed', followupId, outcome: classification.outcome, isNotAnswered });
}
