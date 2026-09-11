/**
 * elevenlabs-conversations-client — acceso de SOLO LECTURA al historial de conversaciones de
 * ElevenLabs. Es el lado "pull" del resultado de una llamada.
 *
 * Existe separado de `elevenlabs-client.ts` a proposito: ese origina llamadas (gasta minutos y
 * dinero), este solo hace `GET`. Nada de lo que hay aca puede provocar una llamada, y por eso
 * puede correrse sin miedo tantas veces como haga falta.
 *
 * Dos endpoints:
 *   GET /v1/convai/conversations?agent_id=...   -> indice barato (sin transcripcion ni analysis)
 *   GET /v1/convai/conversations/{id}           -> la conversacion completa
 *
 * El indice NO trae `user_id`, `data_collection_results` ni transcripcion: para eso hay que
 * pedir el detalle. `conversation-sync` lo aprovecha para no pedir el detalle de lo que ya
 * tiene registrado.
 */

import { ELEVENLABS_API_BASE } from './elevenlabs-client.js';
import { logger } from '../utils/logger.js';
import type { ElevenLabsPostCallPayload } from '../domain/call.js';

const REQUEST_TIMEOUT_MS = 20_000;

/** Fila del indice. Solo los campos que se usan para decidir si vale la pena pedir el detalle. */
export interface ConversationSummary {
  conversation_id: string;
  agent_id?: string;
  status?: string;
  call_duration_secs?: number;
  start_time_unix_secs?: number;
  termination_reason?: string | null;
  call_successful?: 'success' | 'failure' | 'unknown';
  message_count?: number;
  direction?: string | null;
}

export interface ListConversationsPage {
  conversations: ConversationSummary[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Detalle completo. `data` del webhook post-call es *este mismo objeto*, por eso
 * `toPostCallPayload` puede envolverlo sin traducir campo por campo.
 */
export interface ConversationDetail extends ConversationSummary {
  /** `conversation_initiation_client_data.user_id` — nuestro followup_id (ver attributionId). */
  user_id?: string | null;
  transcript?: ElevenLabsPostCallPayload['data']['transcript'];
  metadata?: ElevenLabsPostCallPayload['data']['metadata'];
  analysis?: ElevenLabsPostCallPayload['data']['analysis'];
  conversation_initiation_client_data?: {
    user_id?: string | null;
    dynamic_variables?: Record<string, unknown>;
  };
}

export interface ListConversationsParams {
  agentId?: string;
  pageSize?: number;
  cursor?: string;
  /** Solo conversaciones iniciadas despues de este instante (unix segundos). */
  callStartAfterUnix?: number;
}

export interface ConversationsClient {
  listConversations(params?: ListConversationsParams): Promise<ListConversationsPage>;
  getConversation(conversationId: string): Promise<ConversationDetail | null>;
}

export class RealConversationsClient implements ConversationsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ELEVENLABS_API_BASE,
  ) {
    if (!apiKey) {
      throw new Error(
        'RealConversationsClient requiere ELEVENLABS_API_KEY — es lo unico que necesita el ' +
          'camino de sincronizacion (no hace falta URL publica ni webhook registrado).',
      );
    }
  }

  private async get<T>(path: string): Promise<{ status: number; body: T | null; raw: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'xi-api-key': this.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await res.text();
    let body: T | null = null;
    try {
      body = raw ? (JSON.parse(raw) as T) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, raw };
  }

  async listConversations(params: ListConversationsParams = {}): Promise<ListConversationsPage> {
    const query = new URLSearchParams();
    if (params.agentId) query.set('agent_id', params.agentId);
    query.set('page_size', String(params.pageSize ?? 100));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.callStartAfterUnix) {
      query.set('call_start_after_unix', String(params.callStartAfterUnix));
    }

    const res = await this.get<ListConversationsPage>(`/conversations?${query.toString()}`);
    if (res.status !== 200 || !res.body) {
      throw new Error(
        `GET /convai/conversations devolvio HTTP ${res.status}: ${res.raw.slice(0, 300)}`,
      );
    }
    return {
      conversations: res.body.conversations ?? [],
      next_cursor: res.body.next_cursor ?? null,
      has_more: Boolean(res.body.has_more),
    };
  }

  async getConversation(conversationId: string): Promise<ConversationDetail | null> {
    const res = await this.get<ConversationDetail>(
      `/conversations/${encodeURIComponent(conversationId)}`,
    );
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.body) {
      throw new Error(
        `GET /convai/conversations/${conversationId} devolvio HTTP ${res.status}: ` +
          res.raw.slice(0, 300),
      );
    }
    return res.body;
  }
}

/**
 * Envuelve el detalle en la forma del webhook `post_call_transcription`, que es lo que consume
 * `call-result-recorder`. No traduce nada: `data` del webhook es este mismo objeto.
 *
 * `event_timestamp` se pone en "ahora" porque es la marca de EMISION del evento, no el fin de
 * la llamada — el recorder calcula `endedAt` desde `start_time_unix_secs + call_duration_secs`
 * justamente para no fechar mal una conversacion vieja recuperada por sync.
 */
export function toPostCallPayload(detail: ConversationDetail): ElevenLabsPostCallPayload {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      ...detail,
      conversation_id: detail.conversation_id,
      agent_id: detail.agent_id ?? '',
      status: detail.status ?? 'unknown',
      transcript: detail.transcript ?? [],
      metadata: detail.metadata ?? {},
      analysis: detail.analysis ?? {},
    },
  };
}

/** Los followup_id son UUID v4 (`randomUUID()`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El `followup_id` que dejo el dispatcher, si lo hay.
 *
 * Orden: primero `dynamic_variables.followup_id`, que es el canal confiable (ElevenLabs las
 * devuelve verbatim). Despues `user_id`, pero SOLO si tiene forma de UUID: ese campo lo rellena
 * ElevenLabs por su cuenta — en esta cuenta quedo con el numero de telefono en las llamadas
 * Twilio y con un id de workspace en las pruebas del panel. Sin el filtro, cada prueba del panel
 * pareceria traer una atribucion rota.
 */
export function extractAttributionId(detail: ConversationDetail): string | null {
  const desdeVariables = detail.conversation_initiation_client_data?.dynamic_variables?.followup_id;
  if (typeof desdeVariables === 'string' && UUID.test(desdeVariables.trim())) {
    return desdeVariables.trim();
  }
  const desdeUserId = detail.user_id ?? detail.conversation_initiation_client_data?.user_id ?? null;
  if (typeof desdeUserId === 'string' && UUID.test(desdeUserId.trim())) {
    return desdeUserId.trim();
  }
  return null;
}

/** `orden_compra` de las dynamic_variables — solo se usa para SUGERIR, nunca para atribuir. */
export function extractOrdenCompra(detail: ConversationDetail): string | null {
  const raw = detail.conversation_initiation_client_data?.dynamic_variables?.orden_compra;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function buildConversationsClient(apiKey: string): ConversationsClient {
  logger.info('conversations_client_creado', { modo: 'real_solo_lectura' });
  return new RealConversationsClient(apiKey);
}
