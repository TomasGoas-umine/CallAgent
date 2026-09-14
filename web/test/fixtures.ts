import type {
  CursoOriginal,
  CursoRectificacion,
  CursoRiesgoDj,
  CursoTablero,
  Health,
  LlamadaResumen,
  MockOrderEvaluation,
  MockTableroResponse,
  SemaforoStats,
  TableroOriginalResponse,
} from '../src/types';

export const HEALTH_OK: Health = {
  status: 'ok',
  killSwitch: false,
  dryRun: false,
  mockProviders: true,
  tableroApiMode: 'fixture',
  cuota: { dateKey: '2026-09-03', usados: 1, limite: 5, restantes: 4 },
  ventanaHoraria: {
    inicio: '09:00',
    fin: '19:00',
    timezone: 'America/Santiago',
    abiertaAhora: true,
  },
  allowlist: [{ value: '+56900100141', masked: '***0141' }],
  disparoAutomatico: false,
  webhookPostCall: {
    urlConfigurada: true,
    url: 'https://ejemplo.test/webhooks/elevenlabs/post-call',
    verificadoCon: 'npm run providers:check && npm run webhook:selftest',
  },
  sincronizacionPorApi: {
    disponible: true,
    endpoint: 'POST /api/calls/sync',
    comando: 'npm run calls:sync',
  },
};

export const CURSO_CRITICO: CursoTablero = {
  clientId: 'client_test_demo',
  clientName: 'TEST DEMO · CLIENTE DUMMY',
  orderNumber: 'TEST-9600',
  courseName: 'CURSO DUMMY TEST DEMO CONEXION',
  initCourse: '2026-08-16',
  endCourse: '2026-09-13',
  orderStatus: 'CURSO EN OPERACIÓN',
  semana: 3,
  nivel: 'CRITICO',
  visibleEnSemaforo: true,
  pctConexion: 0,
  inscritos: 10,
  conectados: 0,
  diasRestantes: 10,
  contacto: { nombre: 'TEST · Marcela Bravo', cargo: 'Encargada de Capacitacion' },
  telefono: {
    masked: '***0141',
    disponible: true,
    enAllowlist: true,
    doNotCall: false,
    ultimoContactoAt: null,
    valor: '+56900100141',
  },
  llamable: true,
  variablesAgente: {
    nombre_cliente: 'TEST DEMO · CLIENTE DUMMY',
    curso: 'CURSO DUMMY TEST DEMO CONEXION',
    orden_compra: 'TEST-9600',
    motivo: 'riesgo_conexion_critico',
  },
  advertencias: [],
};

export const CURSO_NORMAL: CursoTablero = {
  ...CURSO_CRITICO,
  clientId: 'client_test_normal_s1',
  clientName: 'TEST NORMAL · CLIENTE DUMMY S1',
  orderNumber: 'TEST-9104',
  courseName: 'CURSO DUMMY TEST NORMAL CONEXION',
  semana: 1,
  nivel: 'NORMAL',
  // El Semaforo real descarta NORMAL de su tabla (StatusCursosPage.tsx:568).
  visibleEnSemaforo: false,
  pctConexion: 25,
  conectados: 5,
  diasRestantes: 24,
  telefono: {
    ...CURSO_CRITICO.telefono,
    masked: '***0016',
    enAllowlist: false,
    valor: '+56900000016',
  },
  llamable: false,
};

export const LLAMADA_RESUELTA: LlamadaResumen = {
  followupId: 'followup-1',
  estado: 'RESUELTO',
  motivo: 'riesgo_conexion_critico',
  prioridad: 'ALTA',
  origen: 'manual',
  requestedBy: 'tomas.goas@umine.com',
  orderNumber: 'TEST-9600',
  courseName: 'CURSO DUMMY TEST DEMO CONEXION',
  clientName: 'TEST DEMO · CLIENTE DUMMY',
  telefonoMasked: '***0141',
  intentos: 0,
  nextAttemptAt: null,
  createdAt: '2026-09-03T15:00:00.000Z',
  updatedAt: '2026-09-03T15:01:00.000Z',
  totalLlamadas: 1,
  resultado: {
    conversationId: 'conv_mock_1',
    outcome: 'resolved',
    status: 'done',
    durationSeconds: 95,
    endedAt: '2026-09-03T15:01:00.000Z',
    camposExtraidos: { motivo_no_conexion: 'olvido_conectarse', tiene_bloqueo_tecnico: false },
  },
};

// ---------------------------------------------------------------------------
// Tablero Mock
// ---------------------------------------------------------------------------

export const TELEFONO_PRUEBAS = '+56956194817';
export const TELEFONO_PRUEBAS_2 = '+56955326503';

export function mockOrden(overrides: Partial<MockOrderEvaluation> = {}): MockOrderEvaluation {
  return {
    order: {
      clientId: 'client_test_demo',
      clientName: 'MOCK · CLIENTE DEMO',
      orderNumber: 'TEST-9600',
      courseName: 'CURSO MOCK CONEXION',
      contactoNombre: 'Carolina Soto',
      phone: TELEFONO_PRUEBAS,
      orderStatus: 'CURSO EN OPERACIÓN',
      initCourse: '2026-08-20',
      endCourse: '2026-09-19',
      inscritos: 10,
      conexiones: 0,
      djs: 0,
      ultimaActualizacion: '2026-09-02',
    },
    variablesAgente: {
      nombre_interlocutor: 'Carolina Soto',
      nombre_cliente: 'MOCK · CLIENTE DEMO',
      nombre_curso: 'CURSO MOCK CONEXION',
      dias_restantes: '10',
      pct_conexion: '0%',
      orden_compra: 'TEST-9600',
      motivo: 'riesgo_conexion_critico',
    },
    inscritosActivos: 10,
    conectados: 0,
    pctConexion: 0,
    semana: 3,
    nivel: 'CRITICO',
    enSeccionA: true,
    motivoFueraDeSeccionA: null,
    // El curso ya arranco: de los estados que dependen de fechas solo cuadra este.
    estadosCoherentes: ['', 'CURSO EN OPERACIÓN', 'BAJA'],
    // Curso corriendo: llamaria por conexion. Los tests de DJ lo sobreescriben.
    seccion: 'A_RIESGO_CONEXION',
    // Secciones B y C: el curso sigue corriendo, asi que ninguna de las dos la incluye. Se
    // sobreescriben por test para armar los escenarios de DJ pendiente / espera del OTIC.
    dj: {
      conDj: 0,
      base: 0,
      pctDj: 0,
      diasDesdeCierre: -10,
      nivel: 'NORMAL',
      enSeccion: false,
      motivoFuera: 'curso_no_terminado',
    },
    rectificacion: {
      diasPendiente: 1,
      nivel: 'NORMAL',
      enSeccion: false,
      motivoFuera: 'estado_no_espera_oc_final',
    },
    regla: { dispara: true, motivo: 'umbral_alcanzado', umbral: 80 },
    ultimoDisparoAt: null,
    ultimoResultado: null,
    ...overrides,
  };
}

export function mockTablero(overrides: Partial<MockTableroResponse> = {}): MockTableroResponse {
  return {
    telefonos: [
      {
        valor: TELEFONO_PRUEBAS,
        masked: '***4817',
        doNotCall: false,
        ultimoContactoAt: null,
        enAllowlist: true,
      },
      {
        valor: TELEFONO_PRUEBAS_2,
        masked: '***6503',
        doNotCall: false,
        ultimoContactoAt: null,
        enAllowlist: true,
      },
    ],
    whitelistPruebas: [TELEFONO_PRUEBAS, TELEFONO_PRUEBAS_2],
    autoCallEnabled: { A_RIESGO_CONEXION: false, B_RIESGO_DJ: false },
    cooldownSegundos: 300,
    estadosEditables: ['', 'CURSO EN OPERACIÓN', 'NO INICIADA', 'BAJA'],
    callRules: {
      dj: { llamarSiDiasMayorA: 7, nivelesQueLlaman: ['CRITICO'] },
      llamarSiPctMenorA: { 1: null, 2: 55, 3: 80, 4: 90 },
      nivelesQueLlaman: ['CRITICO'],
    },
    callRulesDefault: {
      dj: { llamarSiDiasMayorA: 7, nivelesQueLlaman: ['CRITICO'] },
      llamarSiPctMenorA: { 1: null, 2: 55, 3: 80, 4: 90 },
      nivelesQueLlaman: ['CRITICO'],
    },
    ordenes: [mockOrden()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tablero Original
// ---------------------------------------------------------------------------

const STATS_OK: SemaforoStats = {
  paginas: 3,
  truncado: false,
  registrosRecibidos: 5943,
  registrosAgregados: 1963,
  registrosDescartados: {
    estadoMuerto: 3841,
    sinOrderNumber: 0,
    ocExcluida: 0,
    alumnoInactivo: 139,
  },
  ocsAgrupadas: 225,
  ocsFueraDeSeccionA: { no_en_ejecucion: 140, curso_terminado: 0, conexion_completa: 9 },
  ocsSeccionA: 76,
  porNivel: { NORMAL: 16, ALERTA: 31, CRITICO: 29 },
  ocsVisiblesEnSemaforo: 60,
  ocsCriticas: 29,
};

export function cursoOriginal(overrides: Partial<CursoOriginal> = {}): CursoOriginal {
  return {
    clientId: '7953',
    clientName: 'CLIENTE X23',
    orderNumber: '2142332',
    courseName: 'CURSO REAL',
    orderStatus: 'CURSO EN OPERACION',
    initCourse: '2026-08-25',
    endCourse: '2026-09-30',
    semana: 2,
    nivel: 'CRITICO',
    visibleEnSemaforo: true,
    pctConexion: 50,
    inscritos: 10,
    conectados: 5,
    diasRestantes: 21,
    ...overrides,
  };
}

/** Seccion B - Riesgo DJ. Llega ya filtrada por el backend: todo lo que hay se muestra. */
export function cursoRiesgoDj(overrides: Partial<CursoRiesgoDj> = {}): CursoRiesgoDj {
  return {
    clientId: '7953',
    clientName: 'CLIENTE X23',
    orderNumber: '3311002',
    courseName: 'CURSO YA CERRADO',
    orderStatus: 'OBTENIENDO DJ',
    initCourse: '2026-07-01',
    endCourse: '2026-08-18',
    nivel: 'CRITICO',
    diasDesdeCierre: 22,
    conDj: 3,
    conectados: 10,
    pendientes: 7,
    pctDj: 30,
    ...overrides,
  };
}

/** Seccion C - Rectificacion. Idem: el gate de >3 dias ya lo aplico el backend. */
export function cursoRectificacion(
  overrides: Partial<CursoRectificacion> = {},
): CursoRectificacion {
  return {
    clientId: '3030',
    clientName: 'CLIENTE V53',
    orderNumber: '8741939',
    courseName: 'CURSO ESPERANDO OC FINAL',
    orderStatus: 'ESPERA OC FINAL',
    otic: 'ALIANZA PYME',
    nivel: 'ALERTA',
    diasPendiente: 21,
    ultimaActualizacion: '2026-08-19T14:42:20.267Z',
    ...overrides,
  };
}

export function tableroOriginal(
  overrides: Partial<TableroOriginalResponse> = {},
): TableroOriginalResponse {
  const cursos = overrides.cursos ?? [cursoOriginal()];
  return {
    soloLectura: true,
    fuente: 'https://ejemplo.test/tablero/search',
    actualizadoAt: '2026-09-09T18:30:00.000Z',
    duracionMs: 24562,
    stats: STATS_OK,
    total: cursos.length,
    riesgoDj: [cursoRiesgoDj()],
    rectificacion: [cursoRectificacion()],
    ...overrides,
    cursos,
  };
}
