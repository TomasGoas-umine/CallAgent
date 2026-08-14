/**
 * call-outcome-classifier — taxonomia centralizada de resultado de llamada (prompt §5.4).
 * UN solo modulo: ningun handler debe reimplementar esta clasificacion.
 *
 * Heuristica de precedencia (MVP — se refinara cuando el agente real de ElevenLabs este
 * configurado en produccion con sus criterios de evaluacion definitivos; hoy es una
 * aproximacion razonable basada en los 5 campos de data_collection modelados en el prompt):
 *
 *  1. La llamada nunca fue contestada -> no_answer / busy / voicemail / invalid_number
 *     (segun data.status / metadata del proveedor).
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

import type { CallOutcome, ConnectionRiskDataCollection, ElevenLabsPostCallPayload } from '../domain/call.js';

const NOT_ANSWERED_STATUS_MAP: Record<string, CallOutcome> = {
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  busy: 'busy',
  voicemail: 'voicemail',
  'invalid-number': 'invalid_number',
  invalid_number: 'invalid_number',
};

/** Valor centinela que el agente puede reportar en motivo_no_conexion cuando piden no ser llamados de nuevo. */
const DO_NOT_CALL_SENTINELS = new Set(['no_contactar', 'solicita_no_ser_contactado', 'do_not_call']);

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
    necesidad_capacitacion_futura: (get('necesidad_capacitacion_futura') as string | undefined) ?? '',
  };
}

function allEvaluationCriteriaSucceeded(payload: ElevenLabsPostCallPayload): boolean {
  const results = payload.data.analysis?.evaluation_criteria_results;
  if (!results || Object.keys(results).length === 0) return false;
  return Object.values(results).every((r) => r.result === 'success');
}

export interface ClassifiedCallOutcome {
  outcome: CallOutcome;
  dataCollection: Partial<ConnectionRiskDataCollection>;
  requiresHumanEscalation: boolean;
}

export function classifyCallOutcome(payload: ElevenLabsPostCallPayload): ClassifiedCallOutcome {
  const statusOutcome = NOT_ANSWERED_STATUS_MAP[payload.data.status];
  const dataCollection = extractDataCollection(payload);

  if (statusOutcome) {
    return { outcome: statusOutcome, dataCollection, requiresHumanEscalation: false };
  }

  if (dataCollection.requiere_humano) {
    return { outcome: 'human_escalation', dataCollection, requiresHumanEscalation: true };
  }

  if (
    dataCollection.motivo_no_conexion &&
    DO_NOT_CALL_SENTINELS.has(dataCollection.motivo_no_conexion.toLowerCase())
  ) {
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
