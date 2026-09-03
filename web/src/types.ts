/**
 * Formas de las respuestas de la API (`src/local/api-routes.ts`). Se declaran a mano en vez de
 * importarlas del backend a proposito: `web/` es un paquete independiente, sin dependencia de
 * compilacion hacia el repo raiz, para poder embeberlo en un core de Umine tal cual.
 */

export type Nivel = 'NORMAL' | 'ALERTA' | 'CRITICO';

export interface AllowlistEntry {
  value: string;
  masked: string;
}

export interface Health {
  status: string;
  killSwitch: boolean;
  dryRun: boolean;
  mockProviders: boolean;
  tableroApiMode: string;
  cuota: { dateKey: string; usados: number; limite: number; restantes: number };
  ventanaHoraria: { inicio: string; fin: string; timezone: string; abiertaAhora: boolean };
  allowlist: AllowlistEntry[];
  disparoAutomatico: boolean;
}

export interface CursoTablero {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  initCourse: string;
  endCourse: string;
  orderStatus: string;
  semana: number;
  nivel: Nivel;
  pctConexion: number;
  inscritos: number;
  conectados: number;
  diasRestantes: number;
  contacto: { nombre: string | null; cargo: string | null };
  telefono: {
    masked: string;
    disponible: boolean;
    enAllowlist: boolean;
    doNotCall: boolean;
    ultimoContactoAt: string | null;
    /**
     * Numero completo del curso, para poder ofrecerlo como opcion en el disparador. Solo viene
     * en modo fixture (ahi es dato sintetico); con un Semaforo real llega `null` a proposito.
     */
    valor: string | null;
  };
  llamable: boolean;
  variablesAgente: Record<string, string>;
  advertencias: string[];
}

export interface TableroResponse {
  total: number;
  cursos: CursoTablero[];
}

export interface ResultadoLlamada {
  conversationId: string;
  outcome: string | null;
  status: string;
  durationSeconds: number | null;
  endedAt: string | null;
  camposExtraidos: Record<string, unknown>;
}

export interface LlamadaResumen {
  followupId: string;
  estado: string;
  motivo: string;
  prioridad: string;
  origen: string;
  requestedBy: string | null;
  orderNumber: string;
  courseName: string;
  clientName: string;
  telefonoMasked: string;
  intentos: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalLlamadas: number;
  resultado: ResultadoLlamada | null;
}

export interface CallsResponse {
  total: number;
  llamadas: LlamadaResumen[];
}

export interface TranscriptTurn {
  role: string;
  message: string;
  time_in_call_secs?: number;
}

export interface LlamadaDetalle {
  conversationId: string;
  callSid: string | null;
  status: string;
  outcome: string | null;
  durationSeconds: number | null;
  endedAt: string | null;
  camposExtraidos: Record<string, unknown>;
  evaluacion: Record<string, unknown>;
  transcriptSummary: string | null;
  transcript: TranscriptTurn[];
}

export interface CallDetalleResponse {
  followup: {
    followupId: string;
    estado: string;
    motivo: string;
    prioridad: string;
    origen: string;
    requestedBy: string | null;
    orderNumber: string;
    courseName: string;
    telefonoMasked: string;
    intentos: number;
    nextAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
    contexto: Record<string, unknown>;
  };
  llamadas: LlamadaDetalle[];
}

/** Respuesta de POST /api/calls (el mismo `ManualCallResult` del backend). */
export interface DisparoResponse {
  status: string;
  followupId?: string;
  followupEstado?: string;
  conversationId?: string;
  callSid?: string;
  detalle?: string;
  cuota?: Health['cuota'];
  curso?: Record<string, unknown>;
  error?: string;
}
