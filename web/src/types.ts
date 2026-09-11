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
  /**
   * Camino PUSH. `urlConfigurada` dice solo que hay PUBLIC_BASE_URL en el .env del backend:
   * NO prueba que la URL resuelva, ni que haya un webhook registrado, ni que el secreto sea el
   * correcto (antes este campo se llamaba `configurado` y afirmaba de mas).
   */
  webhookPostCall: {
    registroConfigurado?: boolean;
    urlConfigurada: boolean;
    url: string | null;
    verificadoCon: string;
  };
  /** Camino PULL: traer los resultados desde la API de ElevenLabs. Solo necesita la API key. */
  sincronizacionPorApi: { disponible: boolean; endpoint: string; comando: string };
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
  /**
   * `true` si el Semaforo original lo listaria en su seccion A. El backend ya aplico los gates
   * de seccion y descarto NORMAL igual que `StatusCursosPage.tsx`. El micrositio NO recalcula
   * esto: si lo hiciera, habria dos definiciones de "en riesgo" que pueden divergir.
   */
  visibleEnSemaforo: boolean;
  pctConexion: number;
  inscritos: number;
  conectados: number;
  diasRestantes?: number;
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

/**
 * Contadores de la lectura del Semaforo. Sirven para distinguir "hoy no hay cursos criticos"
 * de "la lectura del Semaforo fallo o vino cortada" — desde el tablero los dos casos se ven
 * igual (una tabla vacia) y esa ambiguedad ya escondio bugs de contrato.
 */
export interface SemaforoStats {
  paginas: number;
  truncado: boolean;
  registrosRecibidos: number;
  registrosAgregados: number;
  registrosDescartados: {
    estadoMuerto: number;
    sinOrderNumber: number;
    ocExcluida: number;
    alumnoInactivo: number;
  };
  ocsAgrupadas: number;
  ocsFueraDeSeccionA: {
    no_en_ejecucion: number;
    curso_terminado: number;
    conexion_completa: number;
  };
  ocsSeccionA: number;
  porNivel: Record<Nivel, number>;
  ocsVisiblesEnSemaforo: number;
  ocsCriticas: number;
}

export interface TableroResponse {
  total: number;
  cursos: CursoTablero[];
  stats: SemaforoStats;
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
  startedAt: string | null;
  endedAt: string | null;
  camposExtraidos: Record<string, unknown>;
  /** Los mismos campos con el `rationale` del modelo: por que extrajo cada valor. */
  camposExtraidosDetalle: Record<string, { value?: unknown; rationale?: string }>;
  evaluacion: Record<string, { result?: string; rationale?: string }>;
  cost: number | null;
  terminationReason: string | null;
  /** `webhook` = ElevenLabs lo entrego; `sync` = lo trajo la sincronizacion por API. */
  fuente: 'webhook' | 'sync';
  transcriptSummary: string | null;
  transcript: TranscriptTurn[];
}

/** Una fila del reporte de POST /api/calls/sync. */
export interface SyncItem {
  conversationId: string;
  estado: 'registrada' | 'ya_registrada' | 'no_final' | 'no_atribuible' | 'error';
  followupId?: string;
  outcome?: string;
  motivo?: string;
  via?: 'conversation_link' | 'user_id' | 'forzada';
  startedAt?: string | null;
  durationSeconds?: number | null;
}

export interface SyncResponse {
  total: number;
  registradas: number;
  yaRegistradas: number;
  noFinales: number;
  noAtribuibles: number;
  errores: number;
  items: SyncItem[];
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

// ---------------------------------------------------------------------------
// Tablero Mock — datos simulados y editables (GET/PATCH /api/tablero/mock)
// ---------------------------------------------------------------------------

/**
 * Datos operativos del Semaforo y contexto ficticio editable para las pruebas de voz.
 * Contacto, empresa y curso no intervienen en la criticidad. El backend valida el patch.
 */
export interface MockOrder {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  contactoNombre: string;
  /** A que numero se llama por esta OC. La lista de opciones viene en `telefonos`. */
  phone: string;
  orderStatus: string;
  initCourse: string;
  endCourse: string;
  inscritos: number;
  conexiones: number;
  /** Alumnos con Declaracion Jurada emitida. Solo interviene en la seccion B. */
  djs: number;
  /** `YYYY-MM-DD`. Solo interviene en la seccion C (dias esperando al OTIC). */
  ultimaActualizacion: string;
}

export type MockOrderPatch = Partial<
  Pick<
    MockOrder,
    | 'orderStatus'
    | 'initCourse'
    | 'endCourse'
    | 'inscritos'
    | 'conexiones'
    | 'djs'
    | 'ultimaActualizacion'
    | 'contactoNombre'
    | 'phone'
    | 'clientName'
    | 'courseName'
  >
>;

export interface CallRuleDecision {
  dispara: boolean;
  motivo: 'umbral_alcanzado' | 'nivel_no_habilitado' | 'semana_sin_umbral' | 'sobre_el_umbral';
  umbral: number | null;
}

/**
 * Por que una OC queda fuera de una seccion del Semaforo. Union de los motivos de las tres
 * secciones: el micrositio solo los rotula, no los decide (los manda `semaforo-sections.ts`).
 */
export type MotivoFueraDeSeccion =
  // Seccion A - Riesgo Conexion
  | 'no_en_ejecucion'
  | 'curso_terminado'
  | 'conexion_completa'
  // Seccion B - Riesgo DJ
  | 'curso_no_terminado'
  | 'sin_conectados'
  | 'dj_completa'
  | 'cierre_reciente'
  // Seccion C - Rectificacion
  | 'estado_no_espera_oc_final'
  | 'espera_reciente'
  // Las tres: el Semaforo descarta la OC entera antes de clasificar
  | 'estado_muerto';

/** Seccion B - Riesgo DJ. Se muestra y se edita; nunca dispara una llamada. */
export interface SeccionDjEvaluacion {
  conDj: number;
  /** Conectados — el denominador de la seccion B. */
  base: number;
  pctDj: number;
  diasDesdeCierre: number;
  nivel: Nivel | null;
  enSeccion: boolean;
  motivoFuera: MotivoFueraDeSeccion | null;
}

/** Seccion C - Rectificacion. Se muestra y se edita; nunca dispara una llamada. */
export interface SeccionRectificacionEvaluacion {
  diasPendiente: number;
  nivel: Nivel | null;
  enSeccion: boolean;
  motivoFuera: MotivoFueraDeSeccion | null;
}

export interface MockOrderEvaluation {
  order: MockOrder;
  variablesAgente: Record<string, string>;
  inscritosActivos: number;
  conectados: number;
  pctConexion: number;
  semana: number;
  /** `null` cuando el estado es DEAD y el Semaforo descarta la OC: no hay nivel que mostrar. */
  nivel: Nivel | null;
  enSeccionA: boolean;
  motivoFueraDeSeccionA: MotivoFueraDeSeccion | null;
  /** Estados que cuadran con las fechas de esta OC. Lo decide el backend, no esta vista. */
  estadosCoherentes: string[];
  /** Seccion B, ya clasificada por el backend. `regla` no la mira: esta seccion no llama. */
  dj: SeccionDjEvaluacion;
  /** Seccion C, ya clasificada por el backend. Tampoco llama. */
  rectificacion: SeccionRectificacionEvaluacion;
  /** Decision de llamada. Sale SOLO de la seccion A (riesgo de conexion). */
  regla: CallRuleDecision;
  ultimoDisparoAt: string | null;
  ultimoResultado: string | null;
}

/** Umbrales que disparan LLAMADAS. No son los del Semaforo: esos no se pueden editar. */
export interface CallRules {
  llamarSiPctMenorA: Record<string, number | null>;
  nivelesQueLlaman: Nivel[];
}

export interface MockTriggerOutcome {
  disparo: boolean;
  motivo:
    | 'llamada_originada'
    | 'llamada_no_originada'
    | 'auto_call_desactivado'
    | 'no_cumple_regla'
    | 'sin_transicion'
    | 'en_cooldown'
    | 'oc_no_encontrada';
  detalle?: string;
  llamada?: DisparoResponse;
  cooldownRestanteSegundos?: number;
}

/** Un numero asignable a una OC del Mock, con su estado ya resuelto por el backend. */
export interface TelefonoMock {
  valor: string;
  masked: string;
  doNotCall: boolean;
  ultimoContactoAt: string | null;
  enAllowlist: boolean;
}

export interface MockTableroResponse {
  /** Los numeros que el editor puede asignar por OC. El front no los conoce de antemano. */
  telefonos: TelefonoMock[];
  whitelistPruebas: string[];
  autoCallEnabled: boolean;
  cooldownSegundos: number;
  estadosEditables: string[];
  callRules: CallRules;
  callRulesDefault: CallRules;
  ordenes: MockOrderEvaluation[];
  /** Solo viene en la respuesta de un PATCH. */
  trigger?: MockTriggerOutcome;
  /** Solo viene en la respuesta de un PATCH: algo que el backend corrigio por su cuenta. */
  aviso?: string;
}

// ---------------------------------------------------------------------------
// Tablero Original — dato real de tablero-api, SOLO LECTURA
// ---------------------------------------------------------------------------

export interface CursoOriginal {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  orderStatus: string;
  initCourse: string;
  endCourse: string;
  semana: number;
  nivel: Nivel;
  visibleEnSemaforo: boolean;
  pctConexion: number;
  inscritos: number;
  conectados: number;
  diasRestantes?: number;
}

/**
 * Seccion B - Riesgo DJ: OC ya cerrada a la que le faltan Declaraciones Juradas.
 *
 * `conectados` es el DENOMINADOR del porcentaje, no los inscritos: un alumno que nunca se
 * conecto no tiene DJ que entregar. Viene resuelto del backend, igual que `nivel`.
 */
export interface CursoRiesgoDj {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  orderStatus: string;
  initCourse: string;
  endCourse: string;
  nivel: Nivel;
  diasDesdeCierre: number;
  conDj: number;
  conectados: number;
  pendientes: number;
  pctDj: number;
}

/** Seccion C - Rectificacion: OC esperando la OC Final del OTIC. */
export interface CursoRectificacion {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  orderStatus: string;
  otic: string;
  nivel: Nivel;
  diasPendiente: number;
  /** `max(updated_at)` de la OC — el proxy con el que el backend contó los dias. */
  ultimaActualizacion: string;
}

export interface TableroOriginalResponse {
  soloLectura: true;
  fuente: string;
  actualizadoAt: string;
  duracionMs: number;
  stats: SemaforoStats;
  total: number;
  /** Seccion A - Riesgo Conexion. La unica que alimenta llamadas (en el Mock, no aca). */
  cursos: CursoOriginal[];
  /** Seccion B - Riesgo DJ. Ya filtrada por el backend: llega lista para mostrar. */
  riesgoDj: CursoRiesgoDj[];
  /** Seccion C - Rectificacion. Idem. */
  rectificacion: CursoRectificacion[];
  /** `true` si vino de la cache del backend en vez de una lectura fresca de tablero-api. */
  desdeCache?: boolean;
}
