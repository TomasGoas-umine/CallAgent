/**
 * Dominio: FOLLOWUP — la unidad de trabajo central del sistema.
 * Modelo de datos: ver docs/architecture/ARCHITECTURE.md y prompt §8 (single-table DynamoDB).
 */

/**
 * Motivos de voz admitidos (ADR-012): conexión y declaraciones juradas.
 * Estaba repetido como constante local en candidate-evaluator y manual-call.
 */
export const MOTIVO_RIESGO_CONEXION = 'riesgo_conexion_critico';
export const MOTIVO_RIESGO_DJ = 'riesgo_dj_critico';
export type CallSection = 'A_RIESGO_CONEXION' | 'B_RIESGO_DJ';
export function motivoDeSeccion(seccion: CallSection = 'A_RIESGO_CONEXION'): string {
  return seccion === 'B_RIESGO_DJ' ? MOTIVO_RIESGO_DJ : MOTIVO_RIESGO_CONEXION;
}

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
  /**
   * SID de Twilio del ultimo intento saliente, tal como lo devolvio ElevenLabs al originar.
   *
   * Es lo unico que permite averiguar que paso con una llamada que NO dejo conversacion en
   * ElevenLabs (nadie atendio, el carrier rechazo, permisos geo). Sin esto el FOLLOWUP se
   * quedaba en DIALING para siempre: `conversation-sync` recorre conversaciones, y de esas no
   * hay ninguna. Ver `services/dialing-reconciler.ts`.
   *
   * Opcional: los FOLLOWUP creados antes de que se persistiera no lo tienen.
   */
  ultimoCallSid?: string | null;
  /** `conversation_id` del ultimo intento. Permite pedir esa conversacion directo, sin listar. */
  ultimaConversationId?: string | null;
  /** Cuando se origino el ultimo intento. Es el reloj del periodo de gracia del reconciliador. */
  ultimoIntentoAt?: string | null;
  /** Contexto necesario para revalidar y para construir dynamic_variables del agente. */
  contexto: {
    clientId: string;
    clientName: string;
    courseName: string;
    orderNumber: string;
    initCourse: string;
    endCourse: string;
    nivelDetectado: 'CRITICO' | 'ALERTA' | 'NORMAL';
    seccion: CallSection;
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
  /**
   * `data_collection_results` crudo de ElevenLabs, con el `rationale` de cada campo (por que
   * el modelo extrajo ese valor). `dataCollection` de arriba guarda solo los valores de los
   * cinco campos tipados, que es lo que consume el clasificador; el rationale es la evidencia
   * que necesita un humano para auditar una clasificacion dudosa, y se perdia.
   */
  dataCollectionDetail?: Record<string, { value?: unknown; rationale?: string }>;
  /** Costo en creditos que reporta ElevenLabs (`metadata.cost`). */
  cost?: number | null;
  /**
   * Por que termino la llamada, en palabras del proveedor ("Call ended by remote party",
   * "This request exceeds your quota limit."...). Es la evidencia con la que hay que calibrar
   * la deteccion de no contestadas (UV-053) — sin persistirla no hay con que calibrar.
   */
  terminationReason?: string | null;
  /**
   * Como llego este resultado: `webhook` (ElevenLabs lo entrego), `sync` (lo fue a buscar
   * `conversation-sync` contra la API de ElevenLabs) o `twilio` (no hubo conversacion y lo
   * resolvio `dialing-reconciler` con el estado final de Twilio). Importa para depurar: si todo
   * dice `sync`, el webhook no esta entregando.
   */
  fuente?: 'webhook' | 'sync' | 'twilio';
  /**
   * Estado final que reporto Twilio para esta misma llamada, cuando se pudo consultar. Es la
   * evidencia dura de si el telefono llego a sonar y a ser atendido — ElevenLabs no la tiene
   * (UV-053) — y queda persistida para poder auditar una clasificacion y para calibrar.
   */
  twilio?: {
    status: string;
    answeredBy: string | null;
    durationSeconds: number | null;
    startedAt: string | null;
    endedAt: string | null;
    price: number | null;
  } | null;
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
