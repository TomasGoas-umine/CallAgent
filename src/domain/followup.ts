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
  /**
   * Como se origino este FOLLOWUP. `manual` = un humano apreto el boton en el micrositio
   * (unico camino habilitado mientras el plan sea Starter); `automatico` = candidate-evaluator.
   * Opcional porque los FOLLOWUP creados antes de que existiera el campo no lo tienen.
   */
  origen?: 'manual' | 'automatico';
  /** Quien disparo la llamada, cuando `origen === 'manual'`. Traza para auditoria. */
  requestedBy?: string;
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
  /**
   * Transcripcion tal como la entrega ElevenLabs. Se PERSISTE (el operador necesita poder
   * leerla en el micrositio) pero nunca se loguea: `logger.ts` la omite explicitamente.
   * `transcriptS3Key` queda para cuando el volumen justifique moverla a S3.
   */
  transcript?: Array<{ role: string; message: string; time_in_call_secs?: number }>;
  transcriptSummary?: string | null;
  /** Resultado ya clasificado por `call-outcome-classifier` (taxonomia unica). */
  outcome?: string;
}

/** Todos los estados posibles — usado para listar followups sin depender de un `scan`. */
export const ALL_FOLLOWUP_ESTADOS: FollowupEstado[] = [
  'READY',
  'DIALING',
  'ERROR',
  'AGOTADO',
  'RESUELTO',
  'FOLLOW_UP',
  'CERRADO',
  'ESCALADO',
  'RESUELTO_SIN_LLAMADA',
  'DIFERIDO',
  'BLOQUEADO',
];
