import type {
  ConversationArchive,
  ConversationData,
} from '../../../repositories/conversation-archive-repository.js';
/**
 * webhooks/elevenlabs-post-call — recibe el resultado de la llamada cuando ElevenLabs LO
 * ENTREGA (camino push). Ver docs/bpmn/flujo-3-procesamiento-post-llamada.mmd.
 *
 * Este handler se ocupa SOLO de lo que es propio del transporte: validar la firma HMAC contra
 * el body crudo, parsear, y resolver a que FOLLOWUP pertenece la conversacion. Que hacer con
 * el resultado (clasificar, persistir el CALL, mover el estado, marcar el CONTACT) vive en
 * `services/call-result-recorder`, compartido con `services/conversation-sync` — el camino
 * pull, que va a buscar el mismo resultado a la API. Los dos caminos NO deben divergir: si
 * agregas una regla, va en el recorder, no aca.
 *
 * Responde SIEMPRE 200 si el procesamiento fue correcto (ElevenLabs deshabilita el webhook
 * tras 10+ fallos consecutivos, prompt §5.4) — solo devuelve 401 si la firma es invalida.
 */

import { verifyElevenLabsSignature } from '../../../auth/elevenlabs-signature-validator.js';
import { esConversacionFinal, recordCallResult } from '../../../services/call-result-recorder.js';
import { FollowupRepository } from '../../../repositories/followup-repository.js';
import { ContactRepository } from '../../../repositories/contact-repository.js';
import { env } from '../../../utils/env.js';
import { logger } from '../../../utils/logger.js';
import { ok, badRequest, unauthorized } from '../../../utils/responses.js';
import type { ElevenLabsPostCallPayload } from '../../../domain/call.js';
import type { ApiResponse } from '../../../utils/responses.js';

export interface ElevenLabsWebhookDeps {
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
  webhookSecret?: string;
  archive?: ConversationArchive;
  agentId?: string;
}

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

  if (!payload || typeof payload !== 'object') return badRequest('invalid_payload');
  if (!['post_call_transcription', 'call_initiation_failure'].includes(payload.type)) {
    return ok({ status: 'ignored', reason: 'unsupported_event' });
  }
  if (deps.agentId && payload.data?.agent_id !== deps.agentId) {
    return ok({ status: 'ignored', reason: 'other_agent' });
  }
  const conversationId = payload.data?.conversation_id;
  if (typeof conversationId !== 'string' || !conversationId) {
    return badRequest('missing_conversation_id');
  }

  if (typeof payload.data.agent_id !== 'string' || !payload.data.agent_id)
    return badRequest('missing_agent_id');

  if (deps.archive) {
    const data = { ...payload.data } as unknown as ConversationData;
    if (payload.type === 'call_initiation_failure') {
      data.status = 'failed';
      data.webhook_event = { type: payload.type, event_timestamp: payload.event_timestamp };
    }
    await deps.archive.save(data, 'webhook');
  }
  // Failure events carry provider diagnostics, not a post-call analysis. Keep them in history
  // without letting an empty transcript win the conditional CALL write.
  if (payload.type === 'call_initiation_failure') return ok({ status: 'archived', conversationId });

  if (!esConversacionFinal(payload.data.status)) {
    // ElevenLabs todavia no termino de procesar: guardar esto ganaria la escritura condicional
    // y despues el resultado bueno se descartaria como duplicado. Se responde 200 (no es un
    // fallo de entrega) y el resultado definitivo llega en el evento siguiente, o via sync.
    logger.info('elevenlabs_webhook_conversacion_no_final', {
      conversationId,
      status: payload.data.status,
    });
    return ok({ status: 'ignored', reason: 'conversation_not_final' });
  }

  const followupId = await followupRepository.findFollowupIdByConversation(conversationId);
  if (!followupId) {
    // No es un fallo del webhook (podria ser una llamada de otro entorno/prueba manual en
    // ElevenLabs) — se responde 200 igual, para no gatillar el auto-disable de ElevenLabs.
    logger.warn('elevenlabs_webhook_unknown_conversation', { conversationId });
    return ok(
      deps.archive
        ? { status: 'archived', conversationId }
        : { status: 'ignored', reason: 'unknown_conversation_id' },
    );
  }

  const resultado = await recordCallResult(
    { followupId, payload, fuente: 'webhook' },
    { followupRepository, contactRepository },
  );

  switch (resultado.status) {
    case 'already_processed':
      // Idempotencia (prompt §1.5): mismo conversation_id ya procesado, ElevenLabs reintento.
      return ok({ status: 'already_processed', followupId, conversationId });
    case 'followup_missing':
      return ok({ status: 'processed_but_followup_missing', followupId });
    default:
      return ok({
        status: 'processed',
        followupId,
        outcome: resultado.outcome,
        isNotAnswered: resultado.isNotAnswered,
      });
  }
}
