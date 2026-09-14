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
  /**
   * La llamada nunca se establecio por un fallo del proveedor: numero invalido, rechazo del
   * carrier, permisos geograficos de Twilio, o cancelada antes de que atendieran. Lo reporta
   * Twilio (`status` = failed/canceled), nunca ElevenLabs: su `data.status` no lo distingue.
   */
  | 'call_failed'
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
      /**
       * Presente solo en payloads simulados/antiguos. El webhook REAL de ElevenLabs no pone el
       * SID de Twilio aca: viaja en `metadata.phone_call.call_sid` (ver `phone_call` abajo).
       * Se deja declarado porque los fixtures y el mock lo usan, y porque el handler acepta
       * ambas formas.
       */
      call_sid?: string;
      /**
       * Bloque que ElevenLabs agrega cuando la conversacion fue una llamada telefonica. Aca
       * viene el `call_sid` real de Twilio. Sin leerlo, toda llamada real quedaba registrada
       * con `callSid: null` y no habia forma de cruzarla con el log de Twilio.
       */
      phone_call?: {
        type?: string;
        call_sid?: string;
        external_number?: string;
        agent_number?: string;
        direction?: string;
      };
      /** Inicio real de la llamada. Alimenta `FollowupCall.startedAt` (antes siempre null). */
      start_time_unix_secs?: number;
      /**
       * Por que termino la llamada (texto libre del proveedor). No se interpreta todavia: es la
       * pista mas probable para distinguir "no contestaron" de "conversacion vacia", pero hay
       * que calibrarla con payloads reales antes de convertirla en regla (ver UV-053).
       */
      termination_reason?: string;
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
