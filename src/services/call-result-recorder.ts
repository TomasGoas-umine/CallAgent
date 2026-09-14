/**
 * call-result-recorder — persiste el resultado de UNA llamada y mueve el FOLLOWUP al estado
 * que corresponda.
 *
 * Existe para que haya **un solo** lugar donde se decide que pasa con un resultado de llamada.
 * Hoy hay dos formas de obtenerlo y no deben divergir nunca:
 *
 *   1. `handlers/webhooks/elevenlabs-post-call` — ElevenLabs nos lo entrega (push). Requiere
 *      URL publica viva, webhook registrado y secreto correcto.
 *   2. `services/conversation-sync` — el proyecto lo va a buscar a la API (pull). Solo requiere
 *      la API key.
 *   3. `services/dialing-reconciler` — cuando NO hubo conversacion en ElevenLabs (nadie atendio,
 *      el carrier rechazo), el unico que sabe algo es Twilio. Llega aca con un payload sintetico
 *      y el snapshot de Twilio en `input.twilio`.
 *
 * Los tres terminan aca con el MISMO payload en la forma `post_call_transcription`. Este modulo
 * no sabe de HTTP, de firmas ni de quien lo llamo.
 *
 * Idempotente por `conversation_id`: la escritura del CALL es condicional, y si ya existia no
 * se vuelve a tocar el estado del FOLLOWUP (evita que un reintento del webhook, o un sync
 * repetido, revierta una transicion posterior).
 */

import { classifyCallOutcome, isDoNotCallRequested } from './call-outcome-classifier.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { retryBackoffMs } from '../utils/scheduling.js';
import type { ElevenLabsPostCallPayload } from '../domain/call.js';
import type { TwilioCallSnapshot } from './twilio-calls-client.js';

export interface CallResultRecorderDeps {
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
}

export type RecordCallResultStatus = 'processed' | 'already_processed' | 'followup_missing';

export interface RecordCallResultInput {
  followupId: string;
  payload: ElevenLabsPostCallPayload;
  /** Como llegamos a este resultado. Queda persistido en el CALL y en los logs. */
  fuente: 'webhook' | 'sync' | 'twilio';
  /**
   * Estado final que reporto Twilio para esta misma llamada, si se pudo consultar. Manda sobre
   * la heuristica de la conversacion cuando dice que la llamada nunca se establecio: ElevenLabs
   * no distingue una no contestada de una conversacion vacia (UV-053) y la cerraba como
   * `contacted` -> CERRADO. Opcional: sin el, la clasificacion es la de siempre.
   */
  twilio?: TwilioCallSnapshot | null;
}

export interface RecordCallResultOutput {
  status: RecordCallResultStatus;
  followupId: string;
  conversationId: string;
  outcome?: string;
  isNotAnswered?: boolean;
}

const NOT_ANSWERED_OUTCOMES = new Set([
  'no_answer',
  'busy',
  'voicemail',
  'invalid_number',
  'call_failed',
]);

/**
 * Estados en los que ElevenLabs todavia no termino de procesar la conversacion. Guardarlos
 * seria registrar un resultado a medias (sin analysis ni transcripcion completa) y, peor,
 * bloquear el registro definitivo: `recordCall` es condicional por `conversation_id`, asi que
 * la version incompleta ganaria y la buena se descartaria como duplicada.
 */
const ESTADOS_FINALES = new Set([
  'done',
  'failed',
  'completed',
  'canceled',
  'no-answer',
  'no_answer',
  'busy',
  'voicemail',
  'invalid-number',
  'invalid_number',
]);

export function esConversacionFinal(status: string | undefined): boolean {
  return typeof status === 'string' && ESTADOS_FINALES.has(status);
}

/**
 * Fin real de la llamada = inicio + duracion. El `event_timestamp` del sobre es cuando se
 * EMITIO el evento, que en un webhook se parece al fin, pero en un sync es "ahora" — usarlo
 * ahi fecharia una llamada de la semana pasada como recien terminada.
 */
function resolverEndedAt(payload: ElevenLabsPostCallPayload): string {
  const metadata = payload.data.metadata;
  const inicio = metadata?.start_time_unix_secs;
  const duracion = metadata?.call_duration_secs;
  if (inicio) {
    return new Date((inicio + (duracion ?? 0)) * 1000).toISOString();
  }
  return new Date(payload.event_timestamp * 1000).toISOString();
}

export async function recordCallResult(
  input: RecordCallResultInput,
  deps: CallResultRecorderDeps = {},
): Promise<RecordCallResultOutput> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const { followupId, payload, fuente, twilio } = input;
  const conversationId = payload.data.conversation_id;

  const classification = classifyCallOutcome(payload, twilio);
  const metadata = payload.data.metadata;
  // El SID de Twilio viene en `metadata.phone_call.call_sid` en los payloads reales; los
  // fixtures/el mock lo ponen plano en `metadata.call_sid`. Se aceptan ambos. Y si el resultado
  // vino del reconciliador (llamada sin conversacion), el SID lo trae el propio snapshot.
  const callSid = metadata?.call_sid ?? metadata?.phone_call?.call_sid ?? twilio?.sid ?? null;
  const startedAt = metadata?.start_time_unix_secs
    ? new Date(metadata.start_time_unix_secs * 1000).toISOString()
    : null;

  const recordResult = await followupRepository.recordCall({
    followupId,
    conversationId,
    callSid,
    status: payload.data.status,
    durationSeconds: metadata?.call_duration_secs ?? null,
    startedAt,
    endedAt: resolverEndedAt(payload),
    dataCollection: classification.dataCollection,
    dataCollectionDetail: payload.data.analysis?.data_collection_results ?? {},
    evaluation: payload.data.analysis?.evaluation_criteria_results ?? {},
    cost: metadata?.cost ?? null,
    terminationReason: metadata?.termination_reason ?? null,
    twilio: twilio
      ? {
          status: twilio.status,
          answeredBy: twilio.answeredBy,
          durationSeconds: twilio.durationSeconds,
          startedAt: twilio.startedAt,
          endedAt: twilio.endedAt,
          price: twilio.price,
        }
      : null,
    transcriptS3Key: null,
    // Se persiste para que el operador pueda leerla en el micrositio. Nunca se loguea:
    // logger.ts omite `transcript`/`transcript_summary` a proposito.
    transcript: payload.data.transcript ?? [],
    transcriptSummary: payload.data.analysis?.transcript_summary ?? null,
    outcome: classification.outcome,
    fuente,
  });

  if (recordResult === 'already_exists') {
    logger.info('call_result_duplicado_ignorado', { conversationId, followupId, fuente });
    return { status: 'already_processed', followupId, conversationId };
  }

  const followup = await followupRepository.getById(followupId);
  if (!followup) {
    logger.error('call_result_followup_inexistente', { followupId, conversationId, fuente });
    return { status: 'followup_missing', followupId, conversationId };
  }

  // Puede pedir un humano Y rechazar futuros contactos en la misma conversación.
  // Mantener ESCALADO sin perder el bloqueo permanente del contacto.
  if (isDoNotCallRequested(classification.dataCollection)) {
    await contactRepository.markDoNotCall(followup.destinatarioPhone);
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
      await followupRepository.setEstado(followupId, 'CERRADO');
      break;

    case 'resolved':
      await contactRepository.markContacted(followup.destinatarioPhone);
      await followupRepository.setEstado(followupId, 'RESUELTO');
      break;

    case 'no_answer':
    case 'busy':
    case 'voicemail':
    case 'invalid_number':
    // La llamada no llego a establecerse (lo dice Twilio): mismo tratamiento que una no
    // contestada — cuenta un intento y vuelve a quedar disponible, nunca se cierra como
    // contactado. Nada la va a reintentar sola: el disparo sigue siendo manual (regla 0).
    case 'call_failed': {
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

  logger.info('call_result_procesado', {
    followupId,
    conversationId,
    outcome: classification.outcome,
    fuente,
    twilioStatus: twilio?.status,
  });

  return {
    status: 'processed',
    followupId,
    conversationId,
    outcome: classification.outcome,
    isNotAnswered: NOT_ANSWERED_OUTCOMES.has(classification.outcome),
  };
}
