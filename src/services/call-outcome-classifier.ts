/**
 * call-outcome-classifier — taxonomia centralizada de resultado de llamada (prompt §5.4).
 * UN solo modulo: ningun handler debe reimplementar esta clasificacion.
 *
 * Heuristica de precedencia (MVP — se refinara cuando el agente real de ElevenLabs este
 * configurado en produccion con sus criterios de evaluacion definitivos; hoy es una
 * aproximacion razonable basada en los 5 campos de data_collection modelados en el prompt):
 *
 *  0. Twilio dice que la llamada nunca se establecio -> no_answer / busy / call_failed
 *     (ver `classifyTwilioCall`). Va PRIMERO porque es el unico dato duro sobre si el telefono
 *     llego a sonar y a ser atendido: si no hubo conversacion, nada de lo que siga puede
 *     contradecirlo.
 *  1. La llamada nunca fue contestada -> no_answer / busy / voicemail / invalid_number
 *     (segun data.status / metadata del proveedor — en payloads REALES esto no se activa nunca,
 *     ver UV-053: por eso existe el paso 0).
 *  2. requiere_humano = true                              -> human_escalation
 *  3. motivo_no_conexion indica rechazo explicito a futuro contacto -> do_not_call
 *  4. tiene_bloqueo_tecnico = true                          -> technical_problem
 *  5. compromiso_fecha presente (la persona se comprometio) -> resolved
 *  6. necesidad_capacitacion_futura presente                -> training_need_detected
 *  7. evaluation_criteria_results todos 'success'            -> resolved
 *  8. Contestada pero sin nada accionable                    -> follow_up_required
 *  9. Fallback si contestada                                 -> contacted
 * 10. Cualquier otro caso                                    -> unknown
 */

import type {
  CallOutcome,
  ConnectionRiskDataCollection,
  ElevenLabsPostCallPayload,
} from '../domain/call.js';
import type { TwilioCallSnapshot } from './twilio-calls-client.js';

const NOT_ANSWERED_STATUS_MAP: Record<string, CallOutcome> = {
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  busy: 'busy',
  voicemail: 'voicemail',
  'invalid-number': 'invalid_number',
  invalid_number: 'invalid_number',
};

/** Valor centinela que el agente puede reportar en motivo_no_conexion cuando piden no ser llamados de nuevo. */
const DO_NOT_CALL_SENTINELS = new Set([
  'no_contactar',
  'solicita_no_ser_contactado',
  'do_not_call',
]);

/** El bloqueo de contacto es independiente de que el caso también requiera un humano. */
export function isDoNotCallRequested(data: Partial<ConnectionRiskDataCollection>): boolean {
  return DO_NOT_CALL_SENTINELS.has(data.motivo_no_conexion?.trim().toLowerCase() ?? '');
}

function extractDataCollection(
  payload: ElevenLabsPostCallPayload,
): Partial<ConnectionRiskDataCollection> {
  const raw = payload.data.analysis?.data_collection_results ?? {};
  const get = (key: keyof ConnectionRiskDataCollection): unknown => raw[key]?.value;
  return {
    motivo_no_conexion: (get('motivo_no_conexion') as string | undefined) ?? 'no_informado',
    tiene_bloqueo_tecnico: Boolean(get('tiene_bloqueo_tecnico')),
    compromiso_fecha: (get('compromiso_fecha') as string | undefined) ?? '',
    requiere_humano: Boolean(get('requiere_humano')),
    necesidad_capacitacion_futura:
      (get('necesidad_capacitacion_futura') as string | undefined) ?? '',
  };
}

function allEvaluationCriteriaSucceeded(payload: ElevenLabsPostCallPayload): boolean {
  const results = payload.data.analysis?.evaluation_criteria_results;
  if (!results || Object.keys(results).length === 0) return false;
  return Object.values(results).every((r) => r.result === 'success');
}

/**
 * Estado final de Twilio -> resultado. Solo los que significan "no hubo conversacion": un
 * `completed` no decide nada aca, lo decide el contenido de la conversacion.
 *
 * `canceled` cae en `call_failed` y no en `no_answer` a proposito: significa que la llamada se
 * corto antes de ser atendida (cancelada por API, o Twilio la abandono), no que alguien la dejo
 * sonar. Los dos se tratan igual aguas abajo — la diferencia es para poder leer el registro.
 */
const TWILIO_STATUS_MAP: Record<string, CallOutcome> = {
  'no-answer': 'no_answer',
  busy: 'busy',
  failed: 'call_failed',
  canceled: 'call_failed',
};

/**
 * Lo que Twilio sabe del resultado de la llamada, o `null` si no aporta nada (la atendieron, o
 * todavia esta en curso) y hay que mirar la conversacion.
 *
 * `answered_by` solo viene cuando la llamada se origino con Answering Machine Detection — la
 * integracion nativa de ElevenLabs no la activa hoy, asi que en la practica es `null`. Se lee
 * igual: es la unica forma limpia de marcar un buzon de voz, y cuesta cero.
 */
export function classifyTwilioCall(twilio: TwilioCallSnapshot): CallOutcome | null {
  const porEstado = TWILIO_STATUS_MAP[twilio.status];
  if (porEstado) return porEstado;
  if (twilio.status !== 'completed') return null;

  const atendioMaquina = twilio.answeredBy?.startsWith('machine') || twilio.answeredBy === 'fax';
  if (atendioMaquina) return 'voicemail';
  return null;
}

export interface ClassifiedCallOutcome {
  outcome: CallOutcome;
  dataCollection: Partial<ConnectionRiskDataCollection>;
  requiresHumanEscalation: boolean;
}

/**
 * @param twilio Estado final que reporto Twilio para la misma llamada, si se pudo consultar
 *   (`services/twilio-calls-client`). Es opcional: sin el, la clasificacion es exactamente la de
 *   antes. Con el, deja de cerrarse como `contacted` una llamada que nadie atendio.
 */
export function classifyCallOutcome(
  payload: ElevenLabsPostCallPayload,
  twilio?: TwilioCallSnapshot | null,
): ClassifiedCallOutcome {
  const statusOutcome = NOT_ANSWERED_STATUS_MAP[payload.data.status];
  const dataCollection = extractDataCollection(payload);

  const twilioOutcome = twilio ? classifyTwilioCall(twilio) : null;
  if (twilioOutcome) {
    return { outcome: twilioOutcome, dataCollection, requiresHumanEscalation: false };
  }

  if (statusOutcome) {
    return { outcome: statusOutcome, dataCollection, requiresHumanEscalation: false };
  }

  if (dataCollection.requiere_humano) {
    return { outcome: 'human_escalation', dataCollection, requiresHumanEscalation: true };
  }

  if (isDoNotCallRequested(dataCollection)) {
    return { outcome: 'do_not_call', dataCollection, requiresHumanEscalation: false };
  }

  if (dataCollection.tiene_bloqueo_tecnico) {
    return { outcome: 'technical_problem', dataCollection, requiresHumanEscalation: false };
  }

  if (dataCollection.compromiso_fecha) {
    return { outcome: 'resolved', dataCollection, requiresHumanEscalation: false };
  }

  if (dataCollection.necesidad_capacitacion_futura) {
    return { outcome: 'training_need_detected', dataCollection, requiresHumanEscalation: false };
  }

  if (allEvaluationCriteriaSucceeded(payload)) {
    return { outcome: 'resolved', dataCollection, requiresHumanEscalation: false };
  }

  if (payload.data.status === 'done' || payload.data.call_successful === 'success') {
    return { outcome: 'follow_up_required', dataCollection, requiresHumanEscalation: false };
  }

  return { outcome: 'unknown', dataCollection, requiresHumanEscalation: false };
}
