/**
 * dialing-reconciler — resuelve los FOLLOWUP que quedaron en DIALING preguntandole a Twilio como
 * termino la llamada.
 *
 * El agujero que tapa: `conversation-sync` recorre CONVERSACIONES de ElevenLabs. Una llamada que
 * nadie atiende, que el carrier rechaza o que muere por permisos geograficos no deja una
 * conversacion util — asi que no aparece por ningun lado y el seguimiento se queda en DIALING
 * para siempre, indistinguible de una llamada que sigue hablando. El unico que sabe que paso es
 * Twilio, que fue el que marco el numero.
 *
 * Reglas que se respetan a rajatabla:
 *
 *   - Solo GET. Este modulo no puede originar llamadas (regla 0 de CLAUDE.md) y no se dispara
 *     solo: corre dentro de `calls:sync`, que aprieta una persona.
 *   - No se adivina. Sin `call_sid` guardado no se toca nada y se reporta por que. Si Twilio dice
 *     que la llamada fue atendida pero ElevenLabs todavia no entrega la conversacion, se deja en
 *     DIALING: cerrarla ahi seria descartar la transcripcion que esta por llegar.
 *   - Quien decide que pasa con un resultado sigue siendo `call-result-recorder`, uno solo.
 *
 * Periodo de gracia: un FOLLOWUP recien disparado esta legitimamente en DIALING (la llamada esta
 * sonando). Se ignoran los intentos mas nuevos que `TWILIO_RECONCILE_GRACE_MINUTES`.
 */

import { recordCallResult } from './call-result-recorder.js';
import { esEstadoTwilioFinal } from './twilio-calls-client.js';
import { classifyTwilioCall } from './call-outcome-classifier.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import type { ElevenLabsPostCallPayload } from '../domain/call.js';
import type { Followup } from '../domain/followup.js';
import type { TwilioCallSnapshot, TwilioCallsClient } from './twilio-calls-client.js';

export type ReconcileEstado =
  /** Twilio confirmo que no hubo conversacion: se registro el resultado y el FOLLOWUP se movio. */
  | 'resuelta_por_twilio'
  /** Ese resultado ya estaba registrado (re-correr el sync no duplica nada). */
  | 'ya_registrada'
  /** Sigue sonando / en curso, o dentro del periodo de gracia: no hay nada que decidir todavia. */
  | 'en_curso'
  /** Twilio dice que fue atendida: el resultado bueno lo tiene ElevenLabs, hay que esperarlo. */
  | 'esperando_conversacion'
  /** No se pudo averiguar (sin call_sid, sin credenciales, SID de otra cuenta). */
  | 'sin_datos'
  | 'error';

export interface ReconcileItemResult {
  followupId: string;
  estado: ReconcileEstado;
  callSid?: string | null;
  twilioStatus?: string;
  outcome?: string;
  motivo?: string;
}

export interface DialingReconcilerDeps {
  twilioClient: TwilioCallsClient;
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
}

export interface ReconcileOptions {
  /**
   * Minutos que se le dan a una llamada recien originada antes de considerarla candidata. Una
   * llamada puede estar sonando y hablando; preguntarle a Twilio antes solo daria `in-progress`.
   */
  graciaMinutos?: number;
  now?: Date;
}

const GRACIA_MINUTOS_DEFAULT = env.twilioReconcileGraceMinutes;

/**
 * Envuelve el estado de Twilio en la forma que consume `call-result-recorder`. Es un payload
 * SINTETICO y se nota: `type` lo dice, no hay transcripcion ni analysis porque no hubo
 * conversacion, y el `conversation_id` es `twilio:<CallSid>`.
 *
 * Ese id no es cosmetico: el CALL se guarda como `CALL#twilio:<CallSid>`, asi que reconciliar dos
 * veces la misma llamada es idempotente por `call_sid`, igual que el camino normal lo es por
 * `conversation_id`. Y si mas tarde ElevenLabs entrega la conversacion de verdad, se guarda como
 * un CALL aparte en vez de pisar este ni ser descartada como duplicada.
 */
export function payloadDesdeTwilio(
  twilio: TwilioCallSnapshot,
  agentId: string = env.elevenlabsAgentId,
): ElevenLabsPostCallPayload {
  const inicioUnix = twilio.startedAt ? Math.floor(new Date(twilio.startedAt).getTime() / 1000) : 0;
  return {
    type: 'twilio_call_status',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: `twilio:${twilio.sid}`,
      agent_id: agentId,
      status: twilio.status,
      transcript: [],
      metadata: {
        call_sid: twilio.sid,
        call_duration_secs: twilio.durationSeconds ?? 0,
        ...(inicioUnix ? { start_time_unix_secs: inicioUnix } : {}),
        // La razon de termino es, literalmente, lo que dijo Twilio. No se inventa texto.
        termination_reason: `twilio_status=${twilio.status}`,
      },
      analysis: {},
    },
  };
}

function minutosDesde(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 60_000;
}

async function reconciliarUno(
  followup: Followup,
  deps: Required<
    Pick<DialingReconcilerDeps, 'twilioClient' | 'followupRepository' | 'contactRepository'>
  >,
  options: Required<Pick<ReconcileOptions, 'graciaMinutos'>> & { now: Date },
): Promise<ReconcileItemResult> {
  const followupId = followup.followupId;
  const base = { followupId, callSid: followup.ultimoCallSid ?? null };

  // Recien disparado: la llamada puede estar sonando. No hay nada que reconciliar todavia.
  const desdeElIntento = minutosDesde(followup.ultimoIntentoAt ?? followup.updatedAt, options.now);
  if (desdeElIntento < options.graciaMinutos) {
    return {
      ...base,
      estado: 'en_curso',
      motivo: `disparada hace menos de ${options.graciaMinutos} min`,
    };
  }

  const callSid = followup.ultimoCallSid;
  if (!callSid) {
    return {
      ...base,
      estado: 'sin_datos',
      motivo:
        'el FOLLOWUP no tiene call_sid guardado (se origino antes de que se persistiera). ' +
        'Buscalo en el log de Twilio y atribuilo a mano si corresponde',
    };
  }

  const res = await deps.twilioClient.getCall(callSid);
  if (res.estado === 'no_encontrada') {
    return {
      ...base,
      estado: 'sin_datos',
      motivo:
        'Twilio no conoce ese call_sid con estas credenciales: TWILIO_ACCOUNT_SID tiene que ser ' +
        'la MISMA cuenta que ElevenLabs usa para llamar',
    };
  }
  if (res.estado === 'error') return { ...base, estado: 'error', motivo: res.motivo };

  const twilio = res.call;
  if (!esEstadoTwilioFinal(twilio.status)) {
    return { ...base, estado: 'en_curso', twilioStatus: twilio.status };
  }

  // Atendida: el resultado que vale es la conversacion de ElevenLabs, que puede estar todavia
  // procesandose. Cerrarla aca con lo poco que sabe Twilio seria tirar la transcripcion.
  const outcome = classifyTwilioCall(twilio);
  if (!outcome) {
    return {
      ...base,
      estado: 'esperando_conversacion',
      twilioStatus: twilio.status,
      motivo:
        `Twilio dice ${twilio.status} (${twilio.durationSeconds ?? 0}s): la llamada se atendio, ` +
        'pero ElevenLabs todavia no entrego la conversacion. Volve a correr el sync mas tarde',
    };
  }

  const resultado = await recordCallResult(
    {
      followupId,
      payload: payloadDesdeTwilio(twilio),
      fuente: 'twilio',
      twilio,
    },
    { followupRepository: deps.followupRepository, contactRepository: deps.contactRepository },
  );

  if (resultado.status === 'already_processed') {
    return { ...base, estado: 'ya_registrada', twilioStatus: twilio.status };
  }
  if (resultado.status === 'followup_missing') {
    return { ...base, estado: 'error', motivo: 'el followup desaparecio mientras se reconciliaba' };
  }

  logger.info('dialing_reconciliado_por_twilio', {
    followupId,
    callSid,
    twilioStatus: twilio.status,
    outcome: resultado.outcome,
  });
  return {
    ...base,
    estado: 'resuelta_por_twilio',
    twilioStatus: twilio.status,
    outcome: resultado.outcome,
  };
}

/**
 * Revisa TODOS los FOLLOWUP en DIALING contra Twilio. Devuelve un item por followup revisado —
 * incluidos los que se dejan como estan, con el motivo: un reporte que solo muestra lo que
 * cambio no sirve para entender por que algo sigue colgado.
 */
export async function reconcileDialingFollowups(
  deps: DialingReconcilerDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileItemResult[]> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const now = options.now ?? new Date();
  const graciaMinutos = options.graciaMinutos ?? GRACIA_MINUTOS_DEFAULT;

  const enDialing = await followupRepository.listDialing();
  const items: ReconcileItemResult[] = [];

  for (const followup of enDialing) {
    try {
      items.push(
        await reconciliarUno(
          followup,
          { twilioClient: deps.twilioClient, followupRepository, contactRepository },
          { graciaMinutos, now },
        ),
      );
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.error('dialing_reconciler_item_fallo', {
        followupId: followup.followupId,
        error: motivo,
      });
      items.push({ followupId: followup.followupId, estado: 'error', motivo });
    }
  }

  return items;
}
