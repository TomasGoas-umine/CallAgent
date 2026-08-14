/**
 * Dominio: FOLLOWUP — la unidad de trabajo central del sistema.
 * Modelo de datos: ver docs/architecture/ARCHITECTURE.md y prompt §8 (single-table DynamoDB).
 */

export type FollowupEstado =
  | 'READY'
  | 'DIALING'
  | 'ERROR'
  | 'AGOTADO'
  | 'RESUELTO'
  | 'FOLLOW_UP'
  | 'CERRADO'
  | 'ESCALADO'
  | 'RESUELTO_SIN_LLAMADA'
  | 'DIFERIDO'
  | 'BLOQUEADO';

export interface Followup {
  followupId: string;
  motivo: string;
  prioridad: 'ALTA' | 'MEDIA' | 'BAJA';
  estado: FollowupEstado;
  destinatarioId: string;
  destinatarioPhone: string;
  oc: string;
  curso: string;
  intentos: number;
  nextAttemptAt: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  /** Contexto necesario para revalidar y para construir dynamic_variables del agente. */
  contexto: {
    clientId: string;
    clientName: string;
    courseName: string;
    orderNumber: string;
    initCourse: string;
    endCourse: string;
    nivelDetectado: 'CRITICO';
    seccion: 'A_RIESGO_CONEXION';
  };
}

export interface FollowupCall {
  followupId: string;
  conversationId: string;
  callSid: string | null;
  status: string;
  durationSeconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
  dataCollection: Record<string, unknown>;
  evaluation: Record<string, unknown>;
  transcriptS3Key: string | null;
}
