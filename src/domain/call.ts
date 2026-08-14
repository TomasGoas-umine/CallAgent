/**
 * Dominio: resultado de llamada — taxonomia centralizada de clasificacion post-llamada.
 * Un solo modulo la define; los handlers solo la consumen (ver services/call-outcome-classifier.ts).
 */

export type CallOutcome =
  | 'contacted'
  | 'no_answer'
  | 'busy'
  | 'voicemail'
  | 'invalid_number'
  | 'resolved'
  | 'follow_up_required'
  | 'human_escalation'
  | 'do_not_call'
  | 'technical_problem'
  | 'scheduling_problem'
  | 'training_need_detected'
  | 'unknown';

/** Subconjunto de campos de data_collection_results modelados para el caso "riesgo de conexion". */
export interface ConnectionRiskDataCollection {
  motivo_no_conexion: string;
  tiene_bloqueo_tecnico: boolean;
  compromiso_fecha: string;
  requiere_humano: boolean;
  necesidad_capacitacion_futura: string;
}

/** Forma minima del payload post-call de ElevenLabs que este proyecto consume. */
export interface ElevenLabsPostCallPayload {
  type: string;
  event_timestamp: number;
  data: {
    conversation_id: string;
    agent_id: string;
    status: string;
    call_successful?: 'success' | 'failure' | 'unknown';
    transcript?: Array<{ role: string; message: string; time_in_call_secs?: number }>;
    metadata?: {
      call_duration_secs?: number;
      call_sid?: string;
      cost?: number;
    };
    analysis?: {
      transcript_summary?: string;
      data_collection_results?: Record<string, { value: unknown; rationale?: string }>;
      evaluation_criteria_results?: Record<
        string,
        { result: 'success' | 'failure' | 'unknown'; rationale?: string }
      >;
    };
  };
}
