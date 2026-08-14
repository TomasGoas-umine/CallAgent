/**
 * Dominio: ESCALATION — ver docs/bpmn/flujo-4-escalamiento.mmd.
 * Un escalamiento bloquea reintentos automaticos del FOLLOWUP asociado (nunca en paralelo).
 */

export type EscalationSeveridad = 'ALTA' | 'MEDIA' | 'BAJA';

export type EscalationEstado = 'PENDIENTE_HUMANO' | 'RESUELTO_POR_HUMANO' | 'DESCARTADO';

export type EscalationOrigen =
  | 'situacion_urgente_detectada'
  | 'solicito_humano'
  | 'intentos_agotados'
  | 'error_persistente_proveedor';

export interface Escalation {
  escalationId: string;
  followupId: string;
  origen: EscalationOrigen;
  severidad: EscalationSeveridad;
  estado: EscalationEstado;
  evidencia: {
    transcriptS3Key: string | null;
    motivoOriginal: string;
    datosExtraidos: Record<string, unknown>;
    historialIntentos: number;
  };
  createdAt: string;
  resolvedAt: string | null;
  notas: string | null;
}
