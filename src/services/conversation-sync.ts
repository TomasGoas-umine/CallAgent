/**
 * conversation-sync — trae a la base local el resultado de las llamadas leyendolo de la API de
 * ElevenLabs (camino "pull").
 *
 * Por que existe, si ya hay un webhook: el webhook depende de tres cosas que en local se rompen
 * solas — una URL publica viva, un webhook registrado apuntando a ESA url, y un secreto
 * correcto. Un tunel efimero invalida las tres cada vez que se reinicia. Este camino necesita
 * UNA sola cosa: `ELEVENLABS_API_KEY`. Ademas es re-corrible y recupera hacia atras, asi que
 * tambien sirve de red de seguridad cuando el webhook si esta configurado pero se perdio una
 * entrega (es la reconciliacion pendiente de UV-030).
 *
 * NO origina llamadas: solo hace GET contra ElevenLabs y contra Twilio. Y no se dispara solo —
 * lo llama una persona, por `npm run calls:sync` o por el boton del micrositio (regla 0 de
 * CLAUDE.md: sin cron, sin scheduler, sin polling).
 *
 * Son DOS pasadas, y la segunda existe porque la primera tiene un punto ciego:
 *
 *   1. Por CONVERSACION (ElevenLabs). Cuando se puede, se le pregunta ademas a Twilio como
 *      termino esa misma llamada: su `data.status` nunca dice `no-answer` ni `busy` (UV-053), asi
 *      que una llamada que nadie atendio llegaba al clasificador como conversacion vacia y se
 *      cerraba como `contacted` -> CERRADO. Twilio si lo sabe.
 *   2. Por FOLLOWUP en DIALING (`services/dialing-reconciler`). Las llamadas que no dejan
 *      NINGUNA conversacion no aparecen en la pasada 1 por definicion, y su seguimiento se
 *      quedaba en DIALING para siempre.
 *
 * Las dos pasadas son opcionales en lo que toca a Twilio: sin `TWILIO_ACCOUNT_SID`/
 * `TWILIO_AUTH_TOKEN` el sync hace exactamente lo que hacia antes, y lo dice en el reporte.
 *
 * Como decide a que FOLLOWUP pertenece cada conversacion, en este orden:
 *
 *   1. El item local `CONVERSATION#<id> META`, que escribe el dispatcher al llamar.
 *   2. El `user_id` que viaja DENTRO de la conversacion en ElevenLabs (lo manda el dispatcher
 *      como `attributionId`). Sobrevive a que la base local se pierda.
 *   3. Nada mas. Si no hay ninguno de los dos, la conversacion se reporta como NO ATRIBUIBLE y
 *      no se toca. Cuando trae `orden_compra` se informa como pista, pero atribuirla por
 *      OC+telefono seria adivinar: dos intentos a la misma OC son indistinguibles y una
 *      atribucion equivocada ensucia el registro de otra llamada. Para esos casos esta
 *      `syncConversacionForzada`, donde un humano decide explicitamente.
 */

import {
  extractAttributionId,
  extractOrdenCompra,
  toPostCallPayload,
} from './elevenlabs-conversations-client.js';
import { esConversacionFinal, recordCallResult } from './call-result-recorder.js';
import { reconcileDialingFollowups, type ReconcileItemResult } from './dialing-reconciler.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { logger } from '../utils/logger.js';
import type {
  ConversationDetail,
  ConversationSummary,
  ConversationsClient,
} from './elevenlabs-conversations-client.js';
import type { TwilioCallSnapshot, TwilioCallsClient } from './twilio-calls-client.js';

export type SyncItemEstado =
  'registrada' | 'ya_registrada' | 'no_final' | 'no_atribuible' | 'error';

export interface SyncItemResult {
  conversationId: string;
  estado: SyncItemEstado;
  followupId?: string;
  outcome?: string;
  /** Por que quedo asi, cuando no es obvio (no atribuible, error). */
  motivo?: string;
  /** Como se resolvio la atribucion, para poder auditar. */
  via?: 'conversation_link' | 'user_id' | 'forzada';
  startedAt?: string | null;
  durationSeconds?: number | null;
  /** Estado final que reporto Twilio para esta llamada, si se pudo consultar. */
  twilioStatus?: string;
}

export interface SyncSummary {
  total: number;
  registradas: number;
  yaRegistradas: number;
  noFinales: number;
  noAtribuibles: number;
  errores: number;
  items: SyncItemResult[];
  /**
   * Resultado de la segunda pasada: los FOLLOWUP que estaban en DIALING, resueltos contra el
   * estado final de Twilio. Vacio si no hay credenciales de Twilio (y entonces `twilio.motivo`
   * dice por que).
   */
  pendientes: ReconcileItemResult[];
  /** Que se pudo hacer con Twilio en esta corrida. Es informativo, para el reporte. */
  twilio: {
    consultado: boolean;
    /** Cuando no se consulto: por que. */
    motivo?: string;
    /** Cuantas conversaciones de la pasada 1 se pudieron cruzar con su llamada de Twilio. */
    conversacionesCruzadas: number;
    /** Cuantos FOLLOWUP en DIALING se cerraron con el estado final de Twilio. */
    dialingResueltos: number;
  };
}

export interface ConversationSyncDeps {
  conversationsClient: ConversationsClient;
  /**
   * Lector de estado final de Twilio. Opcional a proposito: sin el (sin credenciales) el sync
   * funciona como antes, solo que sin poder distinguir una no contestada ni destrabar un DIALING.
   */
  twilioClient?: TwilioCallsClient | null;
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
}

export interface SyncOptions {
  /** Solo el agente configurado. Sin esto entrarian conversaciones de otros agentes. */
  agentId?: string;
  /** Solo conversaciones iniciadas despues de este instante (unix segundos). */
  sinceUnixSecs?: number;
  /** Tope de conversaciones a revisar, por si el historial creciera mucho. */
  maxConversaciones?: number;
  /**
   * Saltea la segunda pasada (FOLLOWUP en DIALING contra Twilio). Util para una corrida rapida
   * que solo quiere traer conversaciones nuevas.
   */
  omitirPendientes?: boolean;
  /** Minutos de gracia antes de considerar "colgado" un DIALING recien disparado. */
  graciaMinutos?: number;
  now?: Date;
}

const PAGE_SIZE = 100;
/** Cota dura de paginacion: evita un bucle infinito si la API devolviera siempre has_more. */
const MAX_PAGINAS = 50;

async function listarTodas(
  client: ConversationsClient,
  options: SyncOptions,
): Promise<ConversationSummary[]> {
  const todas: ConversationSummary[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const page = await client.listConversations({
      agentId: options.agentId,
      pageSize: PAGE_SIZE,
      cursor,
      callStartAfterUnix: options.sinceUnixSecs,
    });
    todas.push(...page.conversations);
    if (options.maxConversaciones && todas.length >= options.maxConversaciones) {
      return todas.slice(0, options.maxConversaciones);
    }
    if (!page.has_more || !page.next_cursor) return todas;
    cursor = page.next_cursor;
  }
  logger.warn('conversation_sync_paginacion_truncada', { paginas: MAX_PAGINAS });
  return todas;
}

/**
 * El `call_sid` de Twilio que trae la conversacion. En los payloads reales viaja en
 * `metadata.phone_call.call_sid`; los fixtures y el mock lo ponen plano en `metadata.call_sid`.
 */
function callSidDe(detail: ConversationDetail): string | null {
  return detail.metadata?.phone_call?.call_sid ?? detail.metadata?.call_sid ?? null;
}

/**
 * Como termino esta misma llamada segun Twilio, o `null` si no se puede saber (sin credenciales,
 * sin `call_sid`, o Twilio no la conoce).
 *
 * Un fallo consultando Twilio NUNCA voltea el sync: se registra el resultado igual, con la
 * clasificacion de siempre. Perder el dato de Twilio degrada la precision; abortar perderia la
 * conversacion entera.
 */
async function consultarTwilio(
  detail: ConversationDetail,
  client: TwilioCallsClient | null | undefined,
): Promise<TwilioCallSnapshot | null> {
  if (!client) return null;
  const callSid = callSidDe(detail);
  if (!callSid) return null;

  const res = await client.getCall(callSid);
  if (res.estado === 'ok') return res.call;
  logger.warn('conversation_sync_twilio_no_consultado', {
    conversationId: detail.conversation_id,
    callSid,
    motivo: res.estado === 'no_encontrada' ? 'no_encontrada_en_esta_cuenta' : res.motivo,
  });
  return null;
}

/**
 * Procesa UNA conversacion ya atribuida. Devuelve el item del reporte.
 * Toda la logica de negocio (clasificar, persistir, mover estado) vive en `call-result-recorder`.
 */
async function registrar(
  detail: ConversationDetail,
  followupId: string,
  via: NonNullable<SyncItemResult['via']>,
  deps: Required<Pick<ConversationSyncDeps, 'followupRepository' | 'contactRepository'>> & {
    twilioClient?: TwilioCallsClient | null;
  },
): Promise<SyncItemResult> {
  const twilio = await consultarTwilio(detail, deps.twilioClient);
  const resultado = await recordCallResult(
    { followupId, payload: toPostCallPayload(detail), fuente: 'sync', twilio },
    deps,
  );

  const base: SyncItemResult = {
    conversationId: detail.conversation_id,
    followupId,
    via,
    startedAt: detail.metadata?.start_time_unix_secs
      ? new Date(detail.metadata.start_time_unix_secs * 1000).toISOString()
      : null,
    durationSeconds: detail.metadata?.call_duration_secs ?? null,
    ...(twilio ? { twilioStatus: twilio.status } : {}),
    estado: 'registrada',
  };

  if (resultado.status === 'already_processed') return { ...base, estado: 'ya_registrada' };
  if (resultado.status === 'followup_missing') {
    return { ...base, estado: 'error', motivo: 'el followup referido ya no existe' };
  }
  return { ...base, outcome: resultado.outcome };
}

export async function syncConversations(
  options: SyncOptions = {},
  deps: ConversationSyncDeps,
): Promise<SyncSummary> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();
  const repos = { followupRepository, contactRepository, twilioClient: deps.twilioClient };

  const conversaciones = await listarTodas(deps.conversationsClient, options);
  const items: SyncItemResult[] = [];

  for (const resumen of conversaciones) {
    const conversationId = resumen.conversation_id;
    try {
      // 1. Todavia en curso: no hay nada definitivo que guardar. Se salta sin pedir el detalle.
      //    Guardarla ahora ganaria la escritura condicional y bloquearia el resultado bueno.
      if (!esConversacionFinal(resumen.status)) {
        items.push({
          conversationId,
          estado: 'no_final',
          motivo: `status=${resumen.status ?? 'desconocido'}`,
        });
        continue;
      }

      // 2. Enlace local. Si ademas ya hay un CALL registrado, no hace falta el detalle:
      //    esto es lo que hace barato re-correr el sync.
      const followupIdPorEnlace =
        await followupRepository.findFollowupIdByConversation(conversationId);
      if (followupIdPorEnlace) {
        const yaRegistrada = await followupRepository.getCall(followupIdPorEnlace, conversationId);
        if (yaRegistrada) {
          items.push({
            conversationId,
            estado: 'ya_registrada',
            followupId: followupIdPorEnlace,
            via: 'conversation_link',
          });
          continue;
        }
      }

      const detail = await deps.conversationsClient.getConversation(conversationId);
      if (!detail) {
        items.push({
          conversationId,
          estado: 'error',
          motivo: 'la API no devolvio la conversacion',
        });
        continue;
      }

      if (followupIdPorEnlace) {
        items.push(await registrar(detail, followupIdPorEnlace, 'conversation_link', repos));
        continue;
      }

      // 3. `user_id` guardado dentro de la conversacion. Se verifica que apunte a un FOLLOWUP
      //    real antes de creerle: un id inventado no debe crear registros fantasma.
      const attributionId = extractAttributionId(detail);
      if (attributionId) {
        const followup = await followupRepository.getById(attributionId);
        if (followup) {
          // Se deja el enlace local escrito para que el proximo sync ni tenga que pedir el
          // detalle, y para que un webhook posterior encuentre el followup por el camino normal.
          await followupRepository.linkConversation(conversationId, attributionId);
          items.push(await registrar(detail, attributionId, 'user_id', repos));
          continue;
        }
        items.push({
          conversationId,
          estado: 'no_atribuible',
          motivo:
            `dice pertenecer al FOLLOWUP ${attributionId}, pero ese seguimiento no existe en ` +
            'esta base (se origino contra otro entorno, o la base local se recreo)',
        });
        continue;
      }

      // 4. Sin enlace ni user_id. Se informa la pista si la hay, pero no se adivina.
      const oc = extractOrdenCompra(detail);
      items.push({
        conversationId,
        estado: 'no_atribuible',
        motivo: oc
          ? `sin enlace local ni followup_id; sus dynamic_variables dicen orden_compra=${oc} — atribuila a mano con --conversation-id y --followup-id si corresponde`
          : 'sin enlace local ni followup_id (probablemente una prueba hecha desde el panel de ElevenLabs)',
        startedAt: resumen.start_time_unix_secs
          ? new Date(resumen.start_time_unix_secs * 1000).toISOString()
          : null,
        durationSeconds: resumen.call_duration_secs ?? null,
      });
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.error('conversation_sync_item_fallo', { conversationId, error: motivo });
      items.push({ conversationId, estado: 'error', motivo });
    }
  }

  // --- Pasada 2: los FOLLOWUP que quedaron en DIALING ---
  // No aparecen arriba por definicion: no hay conversacion que listar. Se resuelven con el
  // estado final de Twilio, que es el unico que sabe si el telefono llego a sonar.
  const pendientes =
    deps.twilioClient && !options.omitirPendientes
      ? await reconcileDialingFollowups(
          { twilioClient: deps.twilioClient, followupRepository, contactRepository },
          { graciaMinutos: options.graciaMinutos, now: options.now },
        )
      : [];

  const cuenta = (estado: SyncItemEstado) => items.filter((i) => i.estado === estado).length;
  const summary: SyncSummary = {
    total: items.length,
    registradas: cuenta('registrada'),
    yaRegistradas: cuenta('ya_registrada'),
    noFinales: cuenta('no_final'),
    noAtribuibles: cuenta('no_atribuible'),
    errores: cuenta('error'),
    items,
    pendientes,
    twilio: {
      consultado: Boolean(deps.twilioClient),
      ...(deps.twilioClient
        ? options.omitirPendientes
          ? { motivo: 'segunda pasada omitida por pedido explicito' }
          : {}
        : {
            motivo:
              'sin TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN: no se puede distinguir una llamada no ' +
              'contestada ni destrabar un seguimiento en DIALING',
          }),
      conversacionesCruzadas: items.filter((i) => i.twilioStatus).length,
      dialingResueltos: pendientes.filter((p) => p.estado === 'resuelta_por_twilio').length,
    },
  };
  logger.info('conversation_sync_completado', {
    total: summary.total,
    registradas: summary.registradas,
    yaRegistradas: summary.yaRegistradas,
    noAtribuibles: summary.noAtribuibles,
    errores: summary.errores,
    pendientesRevisados: pendientes.length,
    dialingResueltos: summary.twilio.dialingResueltos,
  });
  return summary;
}

/**
 * Atribucion manual: un humano afirma que esta conversacion pertenece a este FOLLOWUP.
 * Es la salida para las conversaciones viejas, anteriores al `user_id`, donde el sistema no
 * puede decidir solo sin arriesgarse a atribuir mal.
 */
export async function syncConversacionForzada(
  conversationId: string,
  followupId: string,
  deps: ConversationSyncDeps,
): Promise<SyncItemResult> {
  const followupRepository = deps.followupRepository ?? new FollowupRepository();
  const contactRepository = deps.contactRepository ?? new ContactRepository();

  const followup = await followupRepository.getById(followupId);
  if (!followup) {
    return { conversationId, estado: 'error', motivo: `no existe el FOLLOWUP ${followupId}` };
  }
  const detail = await deps.conversationsClient.getConversation(conversationId);
  if (!detail) {
    return { conversationId, estado: 'error', motivo: 'la API no devolvio esa conversacion' };
  }
  if (!esConversacionFinal(detail.status)) {
    return { conversationId, estado: 'no_final', motivo: `status=${detail.status}` };
  }

  await followupRepository.linkConversation(conversationId, followupId);
  logger.warn('conversation_sync_atribucion_forzada', { conversationId, followupId });
  return registrar(detail, followupId, 'forzada', {
    followupRepository,
    contactRepository,
    twilioClient: deps.twilioClient,
  });
}
