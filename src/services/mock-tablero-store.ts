/**
 * mock-tablero-store — el Tablero Mock: un Semaforo de juguete, EDITABLE, en memoria del proceso.
 *
 * Para que existe: probar el flujo real de llamada de punta a punta sin depender de que un
 * curso real caiga en banda critica. El operador edita una OC, la vuelve critica, y si las
 * llamadas automaticas estan encendidas, suena el telefono.
 *
 * Los campos operativos editables son los que el Semaforo real usa para calcular criticidad
 * (verificado leyendo `useSenceData.ts` y `StatusCursosPage.tsx` del repo
 * `micrositio-operaciones-tablero-sence`):
 *
 *   | Campo editable | De donde sale en el original |
 *   |---|---|
 *   | `orderStatus`  | promocion por fechas + filtro DEAD + gate de seccion (`useSenceData.ts:97`) |
 *   | `initCourse`   | `getCourseWeek` (`StatusCursosPage.tsx:52`) |
 *   | `endCourse`    | `getCourseWeek` + gate "curso no terminado" (`StatusCursosPage.tsx:533`) |
 *   | `inscritos`    | CANTIDAD de registros activos por OC (`useSenceData.ts:169`) |
 *   | `conexiones`   | registros con `sence_connections === 1` (`useSenceData.ts:171`) |
 *   | `djs`          | registros con `dj === 1` — `djp` (`useSenceData.ts:177`), seccion B |
 *   | `ultimaActualizacion` | `max(updated_at)` de la OC (`StatusCursosPage.tsx:632`), seccion C |
 *
 * Contacto, empresa y curso se pueden editar aparte para representar escenarios de voz.
 * Son contexto conversacional: no intervienen en las reglas de criticidad.
 *
 * Montos, RUTs y OTIC NO se pueden editar porque no intervienen en la criticidad de ninguna de
 * las tres secciones. Agregarlos seria inventar reglas que el original no tiene.
 *
 * **Las tres secciones del Semaforo, un solo juego de OCs.** Cada OC se evalua por los tres
 * criterios a la vez, igual que en `StatusCursosPage.tsx`: A - Riesgo Conexion (% de conexion
 * contra la semana de curso), B - Riesgo DJ (dias desde el cierre con DJ incompleta) y
 * C - Rectificacion (dias esperando la OC Final del OTIC). Las tres se muestran y se editan;
 * **solo A puede terminar en una llamada** — `regla` sale unicamente de la seccion A, y ni
 * `dj` ni `rectificacion` entran en `call-rules.ts` ni en `mock-call-trigger.ts` (ADR-011).
 *
 * La clasificacion NO se calcula aca: se delega en los mismos modulos espejo del Semaforo
 * (`order-status-promoter`, `semaforo-sections`, `urgency-classifier`). Este archivo solo
 * guarda datos y los expande a registros por alumno, que es la forma en que `tablero-api`
 * entrega el dato real.
 *
 * Estado en memoria a proposito: es un banco de pruebas, no una fuente de verdad. Reiniciar el
 * server lo devuelve al fixture original.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEAD_ESTADOS,
  MANUAL_ESTADOS,
  groupOrders,
  promoteOrderStatus,
} from './order-status-promoter.js';
import {
  diasDesdeElCierre,
  diasEsperandoAlOtic,
  gateSeccionA,
  gateSeccionB,
  gateSeccionC,
  type MotivoFueraDeSeccionA,
  type MotivoFueraDeSeccionB,
  type MotivoFueraDeSeccionC,
} from './semaforo-sections.js';
import {
  clasificarConexion,
  clasificarDj,
  clasificarRectificacion,
  getCourseWeek,
} from './urgency-classifier.js';
import {
  defaultCallRules,
  evaluarReglaDeLlamada,
  type CallRuleDecision,
  type CallRules,
} from './call-rules.js';
import { resolveFixtureRecord } from './tablero-api-client.fixture.js';
import { esTelefonoDelMock, MOCK_TEST_PHONE, MOCK_TEST_PHONES } from './guardrails.js';
import { normalizeCourseDate } from '../utils/dates.js';
import type { CourseWeek, TableroRecord, UrgencyLevel } from '../domain/candidate.js';
import { buildAgentDynamicVariables } from './agent-variables.js';
import { courseDaysRemaining } from '../utils/dates.js';
import { MOTIVO_RIESGO_CONEXION } from '../domain/followup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FIXTURE = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'tablero_search_sample.json',
);

/** Estados que el editor ofrece. Son los que el Semaforo real reconoce y trata distinto. */
export const ESTADOS_EDITABLES = [
  '',
  'CURSO EN OPERACIÓN',
  'NO INICIADA',
  'OBTENIENDO DJ',
  'REVISAR',
  'ESPERA OC FINAL',
  'ENVIADA A FACTURAR',
  'FACTURADA',
  'BAJA',
] as const;

export interface MockOrder {
  clientId: string;
  clientName: string;
  orderNumber: string;
  courseName: string;
  /** Nombre ficticio para representar al contacto durante la prueba de voz. */
  contactoNombre: string;
  /**
   * A que numero se llama por ESTA OC. Solo puede ser uno de `MOCK_TEST_PHONES`: el Mock no
   * puede asignar un numero que el guardrail despues rechace.
   */
  phone: string;
  orderStatus: string;
  initCourse: string;
  endCourse: string;
  /** Alumnos inscritos que se van a generar para esta OC. */
  inscritos: number;
  /** Cuantos de esos alumnos tienen `sence_connections === 1`. */
  conexiones: number;
  /**
   * Cuantos alumnos tienen `dj === 1` — el `djp` del Semaforo. Alimenta SOLO la seccion B.
   *
   * Se valida `djs <= conexiones`: en el Mock los alumnos con DJ son un subconjunto de los
   * conectados. El dato real no obliga a eso (un alumno podria tener DJ sin conexion), pero la
   * seccion B divide `djp / conectados`, asi que permitirlo daria porcentajes sobre 100 sin
   * representar ningun escenario que el Semaforo muestre distinto.
   */
  djs: number;
  /**
   * `YYYY-MM-DD` que se escribe como `updated_at` en todos los registros de la OC. Es lo unico
   * que mueve los "dias pendiente" de la seccion C: el Semaforo usa `max(updated_at)` como
   * proxy de cuando se pidio la rectificacion. Alimenta SOLO la seccion C.
   */
  ultimaActualizacion: string;
}

/** Lo que el editor del micrositio puede mandar. Todo opcional; se valida aca, no en el front. */
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

export interface MockOrderEvaluation {
  order: MockOrder;
  variablesAgente: Record<string, string>;
  /** Inscritos que el Semaforo cuenta de verdad (0 si el estado los deja inactivos). */
  inscritosActivos: number;
  conectados: number;
  pctConexion: number;
  semana: CourseWeek;
  /** `null` cuando el estado es DEAD y el Semaforo directamente descarta la OC. */
  nivel: UrgencyLevel | null;
  enSeccionA: boolean;
  motivoFueraDeSeccionA: MotivoFueraDeSeccionA | 'estado_muerto' | null;
  /**
   * Estados que cuadran con las fechas de esta OC. El resto se puede elegir en el desplegable
   * (junto con un cambio de fechas), pero el PATCH los rechaza si las fechas no acompanan.
   */
  estadosCoherentes: string[];
  /**
   * Seccion B - Riesgo DJ. Se calcula y se muestra; NUNCA se consulta para decidir una llamada.
   * Va en un bloque aparte y no en campos sueltos para que sea evidente de un vistazo que
   * `regla` no lo mira: la decision de llamar usa `nivel`/`enSeccionA`, nada de aca.
   */
  dj: SeccionDjEvaluacion;
  /** Seccion C - Rectificacion. Mismo trato que `dj`: se muestra, no llama. */
  rectificacion: SeccionRectificacionEvaluacion;
  /**
   * Decision de la REGLA DE LLAMADA configurable — no es el nivel del Semaforo, y sale
   * EXCLUSIVAMENTE de la seccion A (conexion).
   */
  regla: CallRuleDecision;
  ultimoDisparoAt: string | null;
  ultimoResultado: string | null;
}

/** Seccion B - Riesgo DJ: cuanto lleva el curso cerrado sin que llegue la Declaracion Jurada. */
export interface SeccionDjEvaluacion {
  /** Alumnos con DJ emitida (`djp`). */
  conDj: number;
  /** Alumnos conectados — el DENOMINADOR de la seccion B, no los inscritos. */
  base: number;
  /** Porcentaje 0-100 de `conDj / base`. 0 si no hay conectados. */
  pctDj: number;
  /** Dias de calendario desde `endCourse`. Negativo si el curso todavia no termino. */
  diasDesdeCierre: number;
  /** `null` cuando el estado es DEAD y el Semaforo descarta la OC entera. */
  nivel: UrgencyLevel | null;
  enSeccion: boolean;
  motivoFuera: MotivoFueraDeSeccionB | 'estado_muerto' | null;
}

/** Seccion C - Rectificacion: cuanto lleva la OC esperando la OC Final del OTIC. */
export interface SeccionRectificacionEvaluacion {
  /** Dias desde `ultimaActualizacion`, el proxy que usa el Semaforo. */
  diasPendiente: number;
  nivel: UrgencyLevel | null;
  enSeccion: boolean;
  motivoFuera: MotivoFueraDeSeccionC | 'estado_muerto' | null;
}

interface TriggerState {
  /** Si la OC ya estaba en condicion de llamar en la evaluacion anterior. */
  disparabaAntes: boolean;
  /** Se incrementa en cada transicion no→si. Entra en la idempotency key. */
  secuencia: number;
  ultimoDisparoAt: string | null;
  ultimoResultado: string | null;
}

interface MockState {
  /**
   * Identificador de esta siembra del store. Entra en la idempotency key de los disparos.
   *
   * Hace falta porque los dos lados de la idempotencia viven en sitios distintos: la secuencia
   * de disparo es memoria del proceso, pero el lock de `originateManualCall` se persiste en
   * DynamoDB. Sin el runId, reiniciar el server (o apretar "Restaurar datos") devolvia la
   * secuencia a 0 y la key chocaba con la de la corrida anterior: el primer disparo de esa OC
   * respondia `already_processed` y no llamaba nunca. Con el runId, una corrida nueva puede
   * volver a llamar, y dentro de una misma corrida dos requests del mismo flanco siguen
   * originando UNA sola llamada.
   */
  runId: string;
  orders: Map<string, MockOrder>;
  callRules: CallRules;
  autoCallEnabled: boolean;
  triggers: Map<string, TriggerState>;
}

export function mockOrderKey(clientId: string, orderNumber: string): string {
  return `${clientId}||${orderNumber}`;
}

let state: MockState | null = null;

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lee el fixture y lo colapsa a OCs editables. Solo se ejecuta al sembrar/resetear. */
function seedOrders(): Map<string, MockOrder> {
  const raw = JSON.parse(readFileSync(SEED_FIXTURE, 'utf-8')) as Array<
    TableroRecord & Record<string, unknown>
  >;
  // Sin allowlist: las fechas se resuelven relativas a hoy; el telefono se ignora (el Mock usa
  // uno solo, ver `toTableroRecords`).
  const records = raw.map((r) => resolveFixtureRecord(r, {}));
  const { groups } = groupOrders(records);

  const orders = new Map<string, MockOrder>();
  for (const g of groups) {
    orders.set(mockOrderKey(g.clientId, g.orderNumber), {
      clientId: g.clientId,
      clientName: g.clientName,
      orderNumber: g.orderNumber,
      courseName: g.courseName,
      // La marca TEST queda en el fixture y en la UI, no en el saludo hablado.
      contactoNombre: (g.records[0]?.contacto_nombre ?? '').replace(/^TEST\s*·\s*/i, '').trim(),
      // Todas arrancan en el numero por defecto; el operador reasigna por OC desde el editor.
      phone: MOCK_TEST_PHONE,
      orderStatus: g.promotedOrderStatus,
      initCourse: g.initCourse,
      endCourse: g.endCourse,
      inscritos: g.enrolledCount,
      conexiones: g.totalConnections,
      // El fixture no trae `dj` (tampoco lo trae `tablero_search_sample.json`): las OCs arrancan
      // con la DJ entera pendiente, que es el escenario que la seccion B existe para mostrar.
      djs: g.djCount,
      ultimaActualizacion: g.lastUpdatedAt ? g.lastUpdatedAt.slice(0, 10) : hoyIso(),
    });
  }
  return orders;
}

function ensureState(): MockState {
  if (!state) {
    state = {
      runId: randomUUID().slice(0, 8),
      orders: seedOrders(),
      callRules: defaultCallRules(),
      // Apagado por defecto: nadie enciende llamadas reales sin decirlo explicitamente.
      autoCallEnabled: false,
      triggers: new Map(),
    };
  }
  return state;
}

/** Vuelve todo al fixture original: datos, umbrales, toggle y memoria de disparos. */
export function resetMockStore(): void {
  state = null;
  ensureState();
}

/** Id de la siembra actual del store — entra en la idempotency key de los disparos. */
export function getMockRunId(): string {
  return ensureState().runId;
}

export function getCallRules(): CallRules {
  return structuredClone(ensureState().callRules);
}

export function setCallRules(rules: CallRules): void {
  ensureState().callRules = structuredClone(rules);
}

export function isAutoCallEnabled(): boolean {
  return ensureState().autoCallEnabled;
}

export function setAutoCallEnabled(enabled: boolean): void {
  ensureState().autoCallEnabled = enabled;
}

export function listMockOrders(): MockOrder[] {
  return [...ensureState().orders.values()].map((o) => ({ ...o }));
}

export function getMockOrder(clientId: string, orderNumber: string): MockOrder | null {
  const found = ensureState().orders.get(mockOrderKey(clientId, orderNumber));
  return found ? { ...found } : null;
}

export interface PatchResult {
  ok: boolean;
  error?: string;
  order?: MockOrder;
  /**
   * Cambio que el store hizo por su cuenta y el operador no pidio (hoy: el estado corregido
   * porque las fechas mandan). No es un error: la edicion se guardo.
   */
  aviso?: string;
}

// --- Coherencia entre ESTADO OC y fechas ---
//
// En el Semaforo real el estado NO es un campo libre: `promoteOrderStatus` lo recalcula a
// partir de init/end antes de cualquier otra cosa, salvo que sea DEAD o MANUAL (esos los pone
// una persona y las fechas no los tocan). Todos los demas son DERIVADOS de las fechas.
//
// Por que hace falta validarlo aca: el store guardaba cualquier estado del desplegable, asi que
// se podia dejar una OC en "NO INICIADA" con el inicio ya pasado. La UI mostraba "NO INICIADA"
// mientras la promocion la devolvia a "CURSO EN OPERACIÓN" al clasificar — la OC seguia CRITICA,
// en seccion A y llamable. El control mentia: parecia haber sacado el curso de operacion y no
// habia cambiado nada abajo.

function mismoEstado(a: string, b: string): boolean {
  return (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();
}

/**
 * Si las FECHAS deciden este estado. El vacio queda afuera a proposito: es "sin estado", una
 * palanca de prueba deliberada (el gate de la seccion A lo trata como en ejecucion, ver
 * `semaforo-sections.ts`), no una afirmacion sobre las fechas.
 */
function loDecidenLasFechas(orderStatus: string): boolean {
  const norm = (orderStatus ?? '').trim().toUpperCase();
  if (norm === '') return false;
  return !DEAD_ESTADOS.has(norm) && !MANUAL_ESTADOS.has(norm);
}

/**
 * El estado que las fechas de ESTA OC dictan, o `null` si no hay nada que corregir: el estado
 * ya coincide, lo pone una persona (DEAD/MANUAL), esta vacio, o las fechas son ilegibles.
 *
 * Delega en `promoteOrderStatus`: la regla de fechas no se reimplementa aca (regla 2 de
 * CLAUDE.md — la logica del Semaforo vive en cuatro modulos y este no es uno de ellos).
 */
function estadoDictadoPorLasFechas(order: MockOrder): string | null {
  if (!loDecidenLasFechas(order.orderStatus)) return null;
  const dictado = promoteOrderStatus({
    order_status: order.orderStatus,
    init_course: order.initCourse,
    end_course: order.endCourse,
  });
  return mismoEstado(dictado, order.orderStatus) ? null : dictado;
}

/**
 * Por que las fechas dictan ese estado, en palabras, para que el operador sepa que fecha mover.
 *
 * Va indexado por el RESULTADO de `promoteOrderStatus` en vez de volver a comparar fechas: si
 * se recomparara aca, el borde "el curso termina hoy" podria explicarse distinto de como se
 * decidio. Si la promocion gana un estado nuevo, cae en el texto generico.
 */
const PORQUE_LO_DICTAN_LAS_FECHAS: Record<string, (o: MockOrder) => string> = {
  'OBTENIENDO DJ': (o) => `el curso ya termino (termino el ${o.endCourse})`,
  'CURSO EN OPERACIÓN': (o) => `el curso ya arranco (arranco el ${o.initCourse})`,
  'NO INICIADA': (o) => `el curso todavia no arranca (arranca el ${o.initCourse})`,
};

function explicarDictado(dictado: string, order: MockOrder): string {
  const explicar = PORQUE_LO_DICTAN_LAS_FECHAS[dictado.trim().toUpperCase()];
  return explicar ? explicar(order) : 'las fechas dictan otro estado';
}

/**
 * Estados que son coherentes con las fechas de ESTA OC: los que pone una persona
 * (DEAD/MANUAL/vacio) mas el unico que las fechas dictan.
 *
 * Lo calcula el backend para que el micrositio pueda AVISAR cual no cuadra sin tener que saber
 * la regla. El desplegable sigue ofreciendo todos (una edicion puede mover estado y fechas de
 * una sola vez, y esa combinacion si es valida); el que rechaza es el PATCH.
 */
export function estadosCoherentesConLasFechas(order: MockOrder): string[] {
  return (ESTADOS_EDITABLES as readonly string[]).filter(
    (estado) => estadoDictadoPorLasFechas({ ...order, orderStatus: estado }) === null,
  );
}

/** Valida y aplica una edicion. Toda la validacion vive aca, nunca en el micrositio. */
export function updateMockOrder(
  clientId: string,
  orderNumber: string,
  patch: MockOrderPatch,
): PatchResult {
  const s = ensureState();
  const key = mockOrderKey(clientId, orderNumber);
  const current = s.orders.get(key);
  if (!current)
    return { ok: false, error: `OC ${orderNumber} del cliente ${clientId} no existe en el Mock` };

  const next: MockOrder = { ...current };

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch debe ser un objeto' };
  }
  const allowed = [
    'orderStatus',
    'initCourse',
    'endCourse',
    'inscritos',
    'conexiones',
    'djs',
    'ultimaActualizacion',
    'contactoNombre',
    'phone',
    'clientName',
    'courseName',
  ];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) {
    return { ok: false, error: 'El patch contiene campos no editables' };
  }
  for (const campo of ['contactoNombre', 'clientName', 'courseName'] as const) {
    const value = patch[campo];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 300 || /[{}\r\n<>]/.test(value)) {
      return {
        ok: false,
        error: `${campo} debe ser texto de hasta 300 caracteres sin plantillas ni saltos de linea`,
      };
    }
    next[campo] = value.trim();
  }

  if (patch.phone !== undefined) {
    // Lista cerrada, no un formato: el Mock solo puede apuntar a los numeros de la etapa de
    // pruebas. El guardrail lo revalida igual antes de llamar (`runGuardrails`), esto lo adelanta
    // con un mensaje entendible.
    if (typeof patch.phone !== 'string' || !esTelefonoDelMock(patch.phone)) {
      return {
        ok: false,
        error: `phone debe ser uno de los numeros de pruebas: ${MOCK_TEST_PHONES.join(', ')}`,
      };
    }
    next.phone = patch.phone;
  }

  if (patch.orderStatus !== undefined) {
    if (typeof patch.orderStatus !== 'string') return { ok: false, error: 'orderStatus invalido' };
    if (!(ESTADOS_EDITABLES as readonly string[]).includes(patch.orderStatus)) {
      return { ok: false, error: `orderStatus no reconocido: ${patch.orderStatus}` };
    }
    next.orderStatus = patch.orderStatus;
  }

  for (const campo of ['initCourse', 'endCourse', 'ultimaActualizacion'] as const) {
    const v = patch[campo];
    if (v === undefined) continue;
    const normalizada = normalizeCourseDate(v);
    if (!normalizada)
      return { ok: false, error: `${campo} debe ser una fecha valida (YYYY-MM-DD)` };
    next[campo] = normalizada;
  }

  if (patch.inscritos !== undefined) {
    if (!Number.isInteger(patch.inscritos) || patch.inscritos < 0 || patch.inscritos > 500) {
      return { ok: false, error: 'inscritos debe ser un entero entre 0 y 500' };
    }
    next.inscritos = patch.inscritos;
  }

  if (patch.conexiones !== undefined) {
    if (!Number.isInteger(patch.conexiones) || patch.conexiones < 0) {
      return { ok: false, error: 'conexiones debe ser un entero >= 0' };
    }
    next.conexiones = patch.conexiones;
  }

  if (patch.djs !== undefined) {
    if (!Number.isInteger(patch.djs) || patch.djs < 0) {
      return { ok: false, error: 'djs debe ser un entero >= 0' };
    }
    next.djs = patch.djs;
  }

  if (next.conexiones > next.inscritos) {
    return { ok: false, error: 'conexiones no puede superar inscritos' };
  }
  // La seccion B divide DJ sobre CONECTADOS, no sobre inscritos (`StatusCursosPage.tsx:587`).
  if (next.djs > next.conexiones) {
    return { ok: false, error: 'djs no puede superar conexiones' };
  }
  if (next.endCourse && next.initCourse && next.endCourse < next.initCourse) {
    return { ok: false, error: 'end_course no puede ser anterior a init_course' };
  }

  // Las FECHAS mandan sobre el estado (ver "Coherencia entre ESTADO OC y fechas" arriba).
  let aviso: string | undefined;
  const dictado = estadoDictadoPorLasFechas(next);
  if (dictado !== null) {
    if (patch.orderStatus !== undefined) {
      // El operador eligio el estado a mano: se rechaza en vez de corregirlo por lo bajo, para
      // que quede claro que la OC nunca estuvo en ese estado.
      return {
        ok: false,
        error:
          `La OC no puede quedar en "${next.orderStatus}": ${explicarDictado(dictado, next)}, ` +
          `asi que el Semaforo la trata como "${dictado}". Las fechas mandan sobre el estado: ` +
          `mueve el inicio o el termino si necesitas ese estado.`,
      };
    }
    // Solo se movieron las fechas: manda la fecha y el estado la sigue. Tambien repara una OC
    // que hubiera quedado incoherente de antes.
    aviso =
      `El estado paso de "${next.orderStatus}" a "${dictado}" porque ` +
      `${explicarDictado(dictado, next)}. Las fechas mandan sobre el estado.`;
    next.orderStatus = dictado;
  }

  s.orders.set(key, next);
  return { ok: true, order: { ...next }, aviso };
}

/**
 * Expande UNA OC a registros por alumno, que es la forma en que `tablero-api` entrega el dato
 * real. Cada OC lleva el telefono que tiene asignado (uno de `MOCK_TEST_PHONES`).
 */
function toRecords(order: MockOrder): TableroRecord[] {
  return Array.from({ length: order.inscritos }, (_, i) => ({
    client_name: order.clientName,
    client_id: order.clientId,
    course_name: order.courseName,
    order_number: order.orderNumber,
    init_course: order.initCourse,
    end_course: order.endCourse,
    rut: `${20_000_000 + i}-0`,
    sence_connections: i < order.conexiones ? 1 : 0,
    // Los alumnos con DJ son los primeros de la lista, o sea un subconjunto de los conectados
    // (validado en `updateMockOrder`). Asi `djp / conectados` nunca pasa de 100%.
    dj: i < order.djs ? 1 : 0,
    order_status: order.orderStatus,
    student_email: `mock.alumno.${i + 1}@correo-test.umine.dev`,
    first_name: `Mock${i + 1}`,
    last_name: order.orderNumber,
    // La fecha editable de la OC, no "ahora": es el unico dato que mueve la seccion C.
    updated_at: `${order.ultimaActualizacion}T00:00:00.000Z`,
    phone_test_only: order.phone,
    contacto_nombre: order.contactoNombre,
    contacto_cargo: 'Encargado de Capacitacion (dato de prueba)',
  }));
}

/** Todos los registros del Mock, como los entregaria `GET /tablero/search`. */
export function toTableroRecords(): TableroRecord[] {
  return listMockOrders().flatMap(toRecords);
}

/**
 * Evalua UNA OC con la misma cadena que el Semaforo real, mas la regla de llamada configurable.
 * Se evalua por OC y no globalmente porque la agregacion es por `cliente||OC`: el resultado es
 * identico y permite mostrar en el editor tambien las OCs que el Semaforo descartaria.
 */
export function evaluateMockOrder(order: MockOrder, rules: CallRules): MockOrderEvaluation {
  const trigger = ensureState().triggers.get(mockOrderKey(order.clientId, order.orderNumber));
  const semana = getCourseWeek(order.initCourse, order.endCourse);
  const { groups } = groupOrders(toRecords(order));
  const group = groups[0];

  const base = {
    order: { ...order },
    estadosCoherentes: estadosCoherentesConLasFechas(order),
    variablesAgente: buildAgentDynamicVariables({
      ...order,
      motivo: MOTIVO_RIESGO_CONEXION,
      diasRestantes: courseDaysRemaining(order.endCourse),
      pctConexion: group?.pctConexion,
    }),
    semana,
    ultimoDisparoAt: trigger?.ultimoDisparoAt ?? null,
    ultimoResultado: trigger?.ultimoResultado ?? null,
  };

  if (!group) {
    // El estado es DEAD (FACTURADA/BAJA/...): el Semaforo descarta los registros antes de
    // agregar, asi que no hay nivel que mostrar en NINGUNA de las tres secciones. No se
    // inventa uno.
    return {
      ...base,
      inscritosActivos: 0,
      conectados: 0,
      pctConexion: 0,
      nivel: null,
      enSeccionA: false,
      motivoFueraDeSeccionA: 'estado_muerto',
      dj: {
        conDj: 0,
        base: 0,
        pctDj: 0,
        diasDesdeCierre: diasDesdeElCierre(order.endCourse),
        nivel: null,
        enSeccion: false,
        motivoFuera: 'estado_muerto',
      },
      rectificacion: {
        diasPendiente: diasEsperandoAlOtic(`${order.ultimaActualizacion}T00:00:00.000Z`),
        nivel: null,
        enSeccion: false,
        motivoFuera: 'estado_muerto',
      },
      regla: {
        dispara: false,
        motivo: 'nivel_no_habilitado',
        umbral: rules.llamarSiPctMenorA[semana],
      },
    };
  }

  // --- Seccion A - Riesgo Conexion. La UNICA que puede terminar en una llamada. ---
  const nivel = clasificarConexion(semana, group.pctConexion);
  const gate = gateSeccionA(group);
  const enSeccionA = gate.incluido;
  const regla = enSeccionA
    ? evaluarReglaDeLlamada(rules, semana, group.pctConexion, nivel)
    : // Fuera de la seccion A no se llama, pase lo que pase con los umbrales: el Semaforo real
      // ni siquiera mostraria esta OC en riesgo de conexion.
      {
        dispara: false,
        motivo: 'nivel_no_habilitado' as const,
        umbral: rules.llamarSiPctMenorA[semana],
      };

  // --- Secciones B y C. Se calculan DESPUES de `regla` y no entran en ella. ---
  const diasDesdeCierre = diasDesdeElCierre(group.endCourse);
  const gateB = gateSeccionB(group);
  const gateC = gateSeccionC(group);
  const diasPendiente = diasEsperandoAlOtic(group.lastUpdatedAt);

  return {
    ...base,
    inscritosActivos: group.enrolledCount,
    conectados: group.totalConnections,
    pctConexion: group.pctConexion,
    nivel,
    enSeccionA,
    motivoFueraDeSeccionA: gate.incluido ? null : gate.motivo,
    dj: {
      conDj: group.djCount,
      base: group.totalConnections,
      pctDj: group.totalConnections > 0 ? (group.djCount / group.totalConnections) * 100 : 0,
      diasDesdeCierre,
      nivel: clasificarDj(diasDesdeCierre),
      enSeccion: gateB.incluido,
      motivoFuera: gateB.incluido ? null : gateB.motivo,
    },
    rectificacion: {
      diasPendiente,
      nivel: clasificarRectificacion(diasPendiente),
      enSeccion: gateC.incluido,
      motivoFuera: gateC.incluido ? null : gateC.motivo,
    },
    regla,
  };
}

export function evaluateAllMockOrders(): MockOrderEvaluation[] {
  const rules = getCallRules();
  return listMockOrders().map((o) => evaluateMockOrder(o, rules));
}

// --- Memoria de disparos (transicion + cooldown + secuencia de idempotencia) ---

export function getTriggerState(clientId: string, orderNumber: string): TriggerState {
  const s = ensureState();
  const key = mockOrderKey(clientId, orderNumber);
  let t = s.triggers.get(key);
  if (!t) {
    t = { disparabaAntes: false, secuencia: 0, ultimoDisparoAt: null, ultimoResultado: null };
    s.triggers.set(key, t);
  }
  return t;
}

export function recordTriggerEvaluation(
  clientId: string,
  orderNumber: string,
  dispara: boolean,
): void {
  getTriggerState(clientId, orderNumber).disparabaAntes = dispara;
}

export function recordTriggerFired(
  clientId: string,
  orderNumber: string,
  resultado: string,
  at: string,
): number {
  const t = getTriggerState(clientId, orderNumber);
  t.secuencia += 1;
  t.ultimoDisparoAt = at;
  t.ultimoResultado = resultado;
  return t.secuencia;
}
