/**
 * twilio-calls-client — acceso de SOLO LECTURA al estado final de una llamada en Twilio.
 *
 * Por que hace falta, si ya tenemos ElevenLabs: el `data.status` de una conversacion de
 * ElevenLabs solo toma `initiated`/`in-progress`/`processing`/`done`/`failed` (verificado contra
 * la cuenta, UV-053). Nunca dice `no-answer` ni `busy`, asi que una llamada que nadie contesto
 * llegaba al clasificador como una conversacion vacia y terminaba en `contacted`/`unknown` ->
 * CERRADO. Quien SI lo sabe es Twilio, que es el que marco el telefono.
 *
 * Y hay un caso peor: llamadas que ni siquiera producen una conversacion util en ElevenLabs
 * (nadie atendio, el carrier rechazo, permisos geo). El FOLLOWUP se quedaba en DIALING para
 * siempre porque `conversation-sync` recorre conversaciones, y de esas no hay ninguna.
 *
 * Igual que `elevenlabs-conversations-client`, aca SOLO hay `GET`: nada de lo que vive en este
 * modulo puede originar una llamada ni gastar un minuto (regla 0 de CLAUDE.md).
 *
 * Endpoint: GET /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json (Basic auth con
 * TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN). Tienen que ser las credenciales de la MISMA cuenta de
 * Twilio que ElevenLabs usa para llamar — si no, el SID existe pero esta cuenta no lo ve (404).
 */

import { logger } from '../utils/logger.js';

const REQUEST_TIMEOUT_MS = 15_000;
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/** Los estados que declara la API de Twilio para una llamada saliente. */
export type TwilioCallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'failed'
  | 'no-answer'
  | 'canceled';

/**
 * Estados en los que Twilio ya no va a cambiar de opinion. Mientras la llamada este en uno de
 * los otros (sonando, en curso) no hay nada que registrar: registrar ahora seria cerrar un
 * seguimiento que todavia esta hablando.
 */
const ESTADOS_FINALES: ReadonlySet<string> = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

export function esEstadoTwilioFinal(status: string | undefined): boolean {
  return typeof status === 'string' && ESTADOS_FINALES.has(status);
}

/** Lo que este proyecto usa de una llamada de Twilio. El resto del recurso se ignora. */
export interface TwilioCallSnapshot {
  sid: string;
  status: string;
  /** Segundos facturables de conversacion. `0` en una no contestada. */
  durationSeconds: number | null;
  /**
   * Quien atendio, SOLO si la llamada se origino con Answering Machine Detection. La integracion
   * nativa de ElevenLabs no la activa hoy, asi que en la practica llega `null` — se lee igual
   * porque es la unica forma limpia de distinguir un buzon de voz de una persona.
   */
  answeredBy: string | null;
  startedAt: string | null;
  endedAt: string | null;
  price: number | null;
  to: string | null;
  from: string | null;
  direction: string | null;
}

/** Forma cruda del recurso Call de Twilio (solo los campos que se leen). */
interface TwilioCallResource {
  sid?: string;
  status?: string;
  duration?: string | number | null;
  answered_by?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  price?: string | number | null;
  to?: string | null;
  from?: string | null;
  direction?: string | null;
}

export type GetTwilioCallResult =
  | { estado: 'ok'; call: TwilioCallSnapshot }
  | { estado: 'no_encontrada' }
  | { estado: 'error'; motivo: string };

export interface TwilioCallsClient {
  getCall(callSid: string): Promise<GetTwilioCallResult>;
}

function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Twilio devuelve las fechas en RFC 2822 ("Mon, 14 Sep 2026 12:00:00 +0000"). */
function parseFecha(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const fecha = new Date(raw);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

export function toSnapshot(resource: TwilioCallResource, callSid: string): TwilioCallSnapshot {
  // El precio de Twilio viene negativo ("-0.014"): es un cargo. Se guarda su magnitud.
  const precio = parseNumber(resource.price);
  return {
    sid: resource.sid ?? callSid,
    status: resource.status ?? 'unknown',
    durationSeconds: parseNumber(resource.duration),
    answeredBy: resource.answered_by ?? null,
    startedAt: parseFecha(resource.start_time),
    endedAt: parseFecha(resource.end_time),
    price: precio === null ? null : Math.abs(precio),
    to: resource.to ?? null,
    from: resource.from ?? null,
    direction: resource.direction ?? null,
  };
}

export class RealTwilioCallsClient implements TwilioCallsClient {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly baseUrl: string = TWILIO_API_BASE,
  ) {
    if (!accountSid || !authToken) {
      throw new Error(
        'RealTwilioCallsClient requiere TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN (solo lectura).',
      );
    }
  }

  async getCall(callSid: string): Promise<GetTwilioCallResult> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const url = `${this.baseUrl}/Accounts/${this.accountSid}/Calls/${encodeURIComponent(callSid)}.json`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        estado: 'error',
        motivo: `red/timeout: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const raw = await res.text();
    if (res.status === 404) return { estado: 'no_encontrada' };
    if (res.status === 401 || res.status === 403) {
      return {
        estado: 'error',
        motivo: `Twilio rechazo las credenciales (HTTP ${res.status}): revisa TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN`,
      };
    }
    if (res.status !== 200) {
      return { estado: 'error', motivo: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
    }

    let body: TwilioCallResource;
    try {
      body = JSON.parse(raw) as TwilioCallResource;
    } catch {
      return { estado: 'error', motivo: `respuesta no-JSON: ${raw.slice(0, 200)}` };
    }
    return { estado: 'ok', call: toSnapshot(body, callSid) };
  }
}

/**
 * Devuelve `null` cuando no hay credenciales, en vez de lanzar: el sync tiene que seguir
 * funcionando sin Twilio (solo pierde la parte de estado final), igual que funcionaba antes.
 */
export function buildTwilioCallsClient(
  accountSid: string,
  authToken: string,
): TwilioCallsClient | null {
  if (!accountSid || !authToken) return null;
  logger.info('twilio_calls_client_creado', { modo: 'real_solo_lectura' });
  return new RealTwilioCallsClient(accountSid, authToken);
}
