/**
 * manual-call — disparo MANUAL de UNA llamada. Es el unico camino de originacion pensado para
 * el micrositio de operacion (`POST /api/calls`).
 *
 * Restriccion central del proyecto (plan Starter, muy pocos minutos): ninguna llamada se
 * dispara sola. Aca no hay cron, ni scheduler, ni polling, ni reintento automatico: este
 * servicio corre una vez por cada vez que un humano aprieta el boton, y nada mas.
 *
 * Lo que este servicio NO hace: no reimplementa ningun guardrail ni la clasificacion de
 * urgencia. Compone las piezas que ya existen (`course-lookup`, `guardrails`,
 * `IdempotencyRepository`, `FollowupRepository`) y termina delegando en `dispatchFollowup`,
 * que vuelve a revalidar TODO por su cuenta (Semaforo, guardrails, cuota atomica y la
 * escritura condicional READY->DIALING). El pre-chequeo de aca solo sirve para poder responder
 * con un motivo preciso ANTES de crear un FOLLOWUP o quemar la idempotency key.
 */

import { randomUUID } from 'node:crypto';
import { dispatchFollowup, type DispatcherDeps } from '../handlers/call-dispatcher/handler.js';
import { buildTableroApiClient } from './tablero-api-client.factory.js';
import { findCourseEvaluation } from './course-lookup.js';
import { isKillSwitchActive, runGuardrails } from './guardrails.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { IdempotencyRepository } from '../repositories/idempotency-repository.js';
import { QuotaRepository, type QuotaSnapshot } from '../repositories/quota-repository.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { MOTIVO_RIESGO_CONEXION } from '../domain/followup.js';
import type { Followup } from '../domain/followup.js';
import type { TableroApiClient } from './tablero-api-client.js';

const MOTIVO = MOTIVO_RIESGO_CONEXION;

/**
 * Namespace para la idempotency key del disparo manual. La key la elige el cliente (header
 * `Idempotency-Key`), asi que se prefija para que no pueda colisionar con las keys sha256 que
 * calcula el evaluador (`services/idempotency.ts`).
 */
export function manualIdempotencyKey(clientKey: string): string {
  return `manual:${clientKey}`;
}

export type ManualCallStatus =
  /** La llamada se origino (en local: contra MockElevenLabsClient). */
  | 'dialing'
  /** Misma idempotency key ya usada: NO se origina una segunda llamada. */
  | 'already_processed'
  | 'kill_switch'
  | 'no_en_allowlist'
  | 'cuota_diaria_alcanzada'
  | 'fuera_de_ventana_horaria'
  | 'do_not_call'
  | 'curso_no_encontrado'
  | 'curso_no_critico'
  | 'error_proveedor'
  /** El dispatcher no origino la llamada por un motivo que no calza con ninguno de arriba. */
  | 'no_originada';

export interface ManualCallInput {
  clientId: string;
  orderNumber: string;
  /**
   * Debe estar en ALLOWLIST_NUMBERS. El micrositio lo ofrece como desplegable y tambien deja
   * escribirlo a mano, pero eso es solo comodidad: quien decide es `runGuardrails` mas abajo.
   */
  phone: string;
  /** Obligatoria. La aporta quien dispara; dos llamadas con la misma key originan UNA sola. */
  idempotencyKey: string;
  /** Traza de quien apreto el boton (usuario del micrositio, o 'local-demo'). */
  requestedBy?: string;
}

export interface ManualCallResult {
  status: ManualCallStatus;
  followupId?: string;
  followupEstado?: string;
  conversationId?: string;
  callSid?: string;
  /** Detalle legible para mostrar en la UI cuando el disparo no procede. */
  detalle?: string;
  cuota?: QuotaSnapshot;
  curso?: {
    clientId: string;
    clientName: string;
    orderNumber: string;
    courseName: string;
    nivel: string;
    semana: number;
    pctConexion: number;
  };
}

export interface ManualCallDeps extends DispatcherDeps {
  contactRepository?: ContactRepository;
  idempotencyRepository?: IdempotencyRepository;
}

export async function originateManualCall(
  input: ManualCallInput,
  deps: ManualCallDeps = {},
): Promise<ManualCallResult> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const idempotencyRepository = deps.idempotencyRepository ?? new IdempotencyRepository();
  const quotaRepository = deps.quotaRepository ?? new QuotaRepository();
  const tableroClient: TableroApiClient = deps.tableroClient ?? buildTableroApiClient();

  if (!input.idempotencyKey) {
    // El adaptador HTTP ya lo valida; esta guarda es para cualquier otro llamador.
    throw new Error('originateManualCall requiere una idempotencyKey no vacia');
  }

  const cuota = await quotaRepository.peek(env.dailyQuota, deps.now);

  if (isKillSwitchActive()) {
    return {
      status: 'kill_switch',
      detalle: 'KILL_SWITCH=true — no se origina ninguna llamada.',
      cuota,
    };
  }

  // --- Revalidacion contra el Semaforo (mismo modulo que usa el dispatcher) ---
  const evaluation = await findCourseEvaluation(tableroClient, input.clientId, input.orderNumber);
  if (!evaluation) {
    return {
      status: 'curso_no_encontrado',
      detalle: `La OC ${input.orderNumber} del cliente ${input.clientId} no aparece en el Semaforo.`,
      cuota,
    };
  }

  const curso = {
    clientId: evaluation.group.clientId,
    clientName: evaluation.group.records[0]?.client_name ?? evaluation.group.clientId,
    orderNumber: evaluation.group.orderNumber,
    courseName: evaluation.group.courseName,
    nivel: evaluation.nivel,
    semana: evaluation.semana,
    pctConexion: evaluation.group.pctConexion,
  };

  if (evaluation.nivel !== 'CRITICO') {
    return {
      status: 'curso_no_critico',
      detalle: `El curso esta en nivel ${evaluation.nivel}: el unico caso de uso del MVP es CRITICO.`,
      cuota,
      curso,
    };
  }

  // --- Guardrails (kill switch ya evaluado arriba; aca ventana horaria + allowlist + cuota) ---
  const guard = runGuardrails(input.phone, { now: deps.now, dailyCountSoFar: cuota.usados });
  if (!guard.allowed) {
    return {
      status: (guard.motivo ?? 'no_originada') as ManualCallStatus,
      detalle: detalleGuardrail(guard.motivo, cuota),
      cuota,
      curso,
    };
  }

  // Consentimiento: si la persona pidio no ser contactada, ni el boton manual lo pasa por
  // encima. Es la misma regla que aplica el evaluador (ContactRepository es su fuente de verdad).
  const contact = await contactRepository.getByPhone(input.phone);
  if (contact?.doNotCall) {
    return {
      status: 'do_not_call',
      detalle: 'El destinatario esta marcado do_not_call — no se puede llamar.',
      cuota,
      curso,
    };
  }

  // --- Idempotencia: la key la elige el cliente y es obligatoria ---
  const idempKey = manualIdempotencyKey(input.idempotencyKey);
  const existing = await idempotencyRepository.get(idempKey);
  if (existing) {
    const followup = await followupRepository.getById(existing.followupId);
    logger.info('manual_call_idempotent_replay', {
      idempotencyKey: idempKey,
      followupId: existing.followupId,
    });
    return {
      status: 'already_processed',
      followupId: existing.followupId,
      followupEstado: followup?.estado,
      detalle: 'Esta idempotency key ya se uso: no se origino una segunda llamada.',
      cuota,
      curso,
    };
  }

  const followupId = randomUUID();
  const acquired = await idempotencyRepository.tryAcquireLock(idempKey, followupId);
  if (!acquired) {
    // Carrera con otro disparo simultaneo de la misma key: gana el primero.
    const winner = await idempotencyRepository.get(idempKey);
    const followup = winner ? await followupRepository.getById(winner.followupId) : null;
    return {
      status: 'already_processed',
      followupId: winner?.followupId,
      followupEstado: followup?.estado,
      detalle: 'Otro disparo con la misma idempotency key llego primero.',
      cuota,
      curso,
    };
  }

  const nowIso = (deps.now ?? new Date()).toISOString();
  const followup: Followup = {
    followupId,
    motivo: MOTIVO,
    prioridad: 'ALTA',
    estado: 'READY',
    destinatarioId: evaluation.group.clientId,
    destinatarioPhone: input.phone,
    oc: evaluation.group.orderNumber,
    curso: evaluation.group.courseName,
    intentos: 0,
    nextAttemptAt: nowIso,
    idempotencyKey: idempKey,
    createdAt: nowIso,
    updatedAt: nowIso,
    origen: 'manual',
    requestedBy: input.requestedBy ?? 'desconocido',
    contexto: {
      clientId: evaluation.group.clientId,
      clientName: curso.clientName,
      courseName: evaluation.group.courseName,
      orderNumber: evaluation.group.orderNumber,
      initCourse: evaluation.group.initCourse,
      endCourse: evaluation.group.endCourse,
      nivelDetectado: 'CRITICO',
      seccion: 'A_RIESGO_CONEXION',
    },
  };
  await followupRepository.create(followup);

  logger.info('manual_call_followup_creado', {
    followupId,
    orderNumber: followup.oc,
    phone: input.phone,
    requestedBy: followup.requestedBy,
  });

  // --- Y a partir de aca, el mismo dispatcher que usa el flujo automatico: revalida el
  // Semaforo, revalida guardrails, consume cuota de forma atomica y hace la escritura
  // condicional READY->DIALING. No se salta ningun paso. ---
  const dispatch = await dispatchFollowup(followupId, {
    ...deps,
    followupRepository,
    quotaRepository,
    tableroClient,
  });

  const cuotaFinal = await quotaRepository.peek(env.dailyQuota, deps.now);
  const base = { followupId, cuota: cuotaFinal, curso };

  switch (dispatch.outcome) {
    case 'dialing':
      return {
        ...base,
        status: 'dialing',
        followupEstado: 'DIALING',
        conversationId: dispatch.conversationId,
        callSid: dispatch.callSid,
      };
    case 'reagendado':
      return {
        ...base,
        status: (dispatch.motivo ?? 'no_originada') as ManualCallStatus,
        followupEstado: 'DIFERIDO',
        detalle: detalleGuardrail(dispatch.motivo, cuotaFinal),
      };
    case 'bloqueado':
      return {
        ...base,
        status: (dispatch.motivo ?? 'no_originada') as ManualCallStatus,
        followupEstado: 'BLOQUEADO',
        detalle: detalleGuardrail(dispatch.motivo, cuotaFinal),
      };
    case 'resuelto_sin_llamada':
      return {
        ...base,
        status: 'curso_no_critico',
        followupEstado: 'RESUELTO_SIN_LLAMADA',
        detalle: `El Semaforo cambio entre el pre-chequeo y el disparo (${dispatch.motivo}).`,
      };
    case 'error':
    case 'agotado':
      return {
        ...base,
        status: 'error_proveedor',
        followupEstado: dispatch.outcome === 'agotado' ? 'AGOTADO' : 'ERROR',
        detalle: `El proveedor no acepto la llamada: ${dispatch.motivo}`,
      };
    default:
      return {
        ...base,
        status: 'no_originada',
        detalle: `El dispatcher devolvio '${dispatch.outcome}' (${dispatch.motivo ?? 'sin motivo'}).`,
      };
  }
}

function detalleGuardrail(motivo: string | undefined, cuota: QuotaSnapshot): string {
  switch (motivo) {
    case 'kill_switch':
      return 'KILL_SWITCH=true — no se origina ninguna llamada.';
    case 'no_en_allowlist':
      return 'El numero no esta en ALLOWLIST_NUMBERS.';
    case 'fuera_de_ventana_horaria':
      return `Fuera de la ventana horaria (${env.businessHoursStart}-${env.businessHoursEnd} ${env.timezone}, lunes a viernes).`;
    case 'cuota_diaria_alcanzada':
      return `Cuota diaria agotada (${cuota.usados}/${cuota.limite} llamadas el ${cuota.dateKey}).`;
    case 'do_not_call':
      return 'El destinatario esta marcado do_not_call — no se puede llamar.';
    default:
      return motivo ?? 'sin motivo';
  }
}
