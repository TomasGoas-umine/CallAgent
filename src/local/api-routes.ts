/**
 * API de operacion del micrositio (`/api/*`). Plugin de Fastify, registrado por
 * `src/local/server.ts`.
 *
 * Es un ADAPTADOR: no toma ninguna decision de negocio. Traduce HTTP <-> los servicios que ya
 * existen (`course-lookup`, `manual-call`, `guardrails`, repositorios) y mapea el `status`
 * tipado que devuelve `originateManualCall` a un codigo HTTP. Cualquier regla nueva va en el
 * servicio correspondiente, no aca.
 *
 * `POST /api/calls` es el unico camino de originacion: pasa por `originateManualCall`, que a su
 * vez delega en `dispatchFollowup`. No se saltea revalidacion contra el Semaforo, allowlist,
 * ventana horaria, cuota diaria ni la escritura condicional READY->DIALING. La idempotency key
 * es obligatoria (header `Idempotency-Key`, o `idempotencyKey` en el body).
 *
 * Nada de aca dispara nada por su cuenta: no hay cron, ni scheduler, ni polling. Un `POST` por
 * cada vez que un humano aprieta el boton.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildTableroApiClient } from '../services/tablero-api-client.factory.js';
import { listCourseEvaluations } from '../services/course-lookup.js';
import {
  isKillSwitchActive,
  isNumberAllowed,
  isWithinBusinessHours,
} from '../services/guardrails.js';
import { originateManualCall, type ManualCallStatus } from '../services/manual-call.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { QuotaRepository } from '../repositories/quota-repository.js';
import { buildAgentDynamicVariables } from '../services/agent-variables.js';
import { ALL_FOLLOWUP_ESTADOS, MOTIVO_RIESGO_CONEXION } from '../domain/followup.js';
import { env } from '../utils/env.js';
import { logger, maskPhone } from '../utils/logger.js';
import type { ManualCallDeps } from '../services/manual-call.js';
import type { TableroApiClient } from '../services/tablero-api-client.js';

/** Inyectables — en produccion/local se usan los defaults; los tests pasan los suyos. */
export interface ApiDeps {
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
  quotaRepository?: QuotaRepository;
  tableroClient?: TableroApiClient;
  /** Se pasa tal cual a `originateManualCall` (permite inyectar el cliente mockeado). */
  manualCallDeps?: ManualCallDeps;
}

/**
 * Mapeo status de negocio -> codigo HTTP. Vive aca a proposito: es una decision de transporte,
 * no de negocio (el servicio no sabe nada de HTTP).
 */
const HTTP_STATUS_BY_MANUAL_CALL_STATUS: Record<ManualCallStatus, number> = {
  dialing: 201,
  already_processed: 200,
  kill_switch: 503,
  no_en_allowlist: 403,
  do_not_call: 403,
  cuota_diaria_alcanzada: 429,
  fuera_de_ventana_horaria: 409,
  curso_no_encontrado: 404,
  curso_no_critico: 409,
  error_proveedor: 502,
  no_originada: 409,
};

interface CreateCallBody {
  clientId?: string;
  orderNumber?: string;
  phone?: string;
  idempotencyKey?: string;
  requestedBy?: string;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps = {}): Promise<void> {
  const followupRepository = () => deps.followupRepository ?? new FollowupRepository();
  const contactRepository = () => deps.contactRepository ?? new ContactRepository();
  const quotaRepository = () => deps.quotaRepository ?? new QuotaRepository();
  const tableroClient = () => deps.tableroClient ?? buildTableroApiClient();

  // -------------------------------------------------------------------------
  // GET /api/health — lo primero que mira el operador: en que modo esta el sistema
  // -------------------------------------------------------------------------
  app.get('/api/health', async (_request, reply) => {
    const cuota = await quotaRepository().peek(env.dailyQuota);
    reply.code(200).send({
      status: 'ok',
      killSwitch: isKillSwitchActive(),
      dryRun: env.dryRun,
      mockProviders: env.mockProviders,
      tableroApiMode: env.tableroApiMode,
      cuota,
      ventanaHoraria: {
        inicio: env.businessHoursStart,
        fin: env.businessHoursEnd,
        timezone: env.timezone,
        abiertaAhora: isWithinBusinessHours(),
      },
      // Los numeros autorizados van completos: son los del propio operador (los unicos que el
      // guardrail deja marcar), y necesita verlos para saber a cual esta llamando. En el tablero
      // los numeros de TERCEROS siguen enmascarados. El micrositio puebla su desplegable con
      // esta lista, y ademas permite escribir un numero a mano — el guardrail de allowlist
      // (backend) es el que decide, no el front.
      allowlist: env.allowlistNumbers.map((value) => ({ value, masked: maskPhone(value) })),
      /** El disparo automatico esta deliberadamente apagado (plan Starter). */
      disparoAutomatico: false,
      /**
       * Estado del webhook post-call. Sin el, una llamada real suena y conversa pero su
       * resultado nunca vuelve: el FOLLOWUP se queda en DIALING sin transcripcion ni
       * clasificacion. Se expone para que el micrositio lo avise en vez de que parezca un bug
       * (hoy esta diferido a proposito, ver UV-051).
       */
      webhookPostCall: {
        configurado: Boolean(env.publicBaseUrl),
        url: env.publicBaseUrl ? `${env.publicBaseUrl}/webhooks/elevenlabs/post-call` : null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/tablero — los 15 cursos del Semaforo, ya clasificados
  // -------------------------------------------------------------------------
  app.get('/api/tablero', async (_request, reply) => {
    const evaluations = await listCourseEvaluations(tableroClient());
    const contactos = contactRepository();

    const cursos = await Promise.all(
      evaluations.map(async (e) => {
        const representante = e.group.records.find((r) => r.phone_test_only);
        const phone = representante?.phone_test_only ?? null;
        const contactRecord = phone ? await contactos.getByPhone(phone) : null;
        const primero = e.group.records[0];

        return {
          clientId: e.group.clientId,
          clientName: primero?.client_name ?? e.group.clientId,
          orderNumber: e.group.orderNumber,
          courseName: e.group.courseName,
          initCourse: e.group.initCourse,
          endCourse: e.group.endCourse,
          orderStatus: e.group.promotedOrderStatus,
          semana: e.semana,
          nivel: e.nivel,
          pctConexion: Number(e.group.pctConexion.toFixed(1)),
          inscritos: e.group.enrolledCount,
          conectados: e.group.totalConnections,
          diasRestantes: diasRestantes(e.group.endCourse),
          contacto: {
            // Campos SINTETICOS del fixture — no existen en tablero-api real (ver UV-024).
            nombre: primero?.contacto_nombre ?? null,
            cargo: primero?.contacto_cargo ?? null,
          },
          telefono: {
            masked: maskPhone(phone),
            disponible: Boolean(phone),
            enAllowlist: phone ? isNumberAllowed(phone) : false,
            doNotCall: contactRecord?.doNotCall ?? false,
            ultimoContactoAt: contactRecord?.lastContactedAt ?? null,
            /**
             * Numero completo del curso, para que el disparador pueda OFRECERLO como opcion y
             * el operador pueda corregirlo a mano si esta mal (que es el caso normal: el
             * telefono real no existe en la cadena de datos del Semaforo, ver UV-024).
             *
             * Solo se expone en modo fixture, donde `phone_test_only` es dato SINTETICO. Si
             * algun dia `TABLERO_API_MODE=http` devuelve telefonos reales, este campo queda en
             * null a proposito: exponer telefonos de terceros es una decision de privacidad que
             * hay que tomar explicitamente, no heredar de este endpoint (ver UV-046).
             */
            valor: env.tableroApiMode === 'fixture' ? phone : null,
          },
          /**
           * `true` si el CURSO califica para una llamada (el unico caso de uso del MVP es
           * nivel CRITICO). Los gates que dependen del NUMERO elegido (allowlist) o del estado
           * global (cuota, kill switch, ventana horaria) no se evaluan aca: el numero lo elige
           * el operador en el desplegable de la allowlist, y el estado global sale de
           * GET /api/health.
           */
          llamable: e.nivel === 'CRITICO',
          /**
           * Exactamente las dynamic_variables que recibiria el agente si se dispara esta
           * llamada. Salen del mismo modulo que usa el dispatcher, para que el modal de
           * confirmacion no muestre algo distinto de lo que se envia.
           */
          variablesAgente: buildAgentDynamicVariables({
            clientName: primero?.client_name ?? e.group.clientId,
            courseName: e.group.courseName,
            orderNumber: e.group.orderNumber,
            motivo: MOTIVO_RIESGO_CONEXION,
          }),
          /** Cosas que el operador deberia ver antes de llamar, sin que bloqueen el boton. */
          advertencias: [
            ...(phone ? [] : ['el Semaforo no trae telefono para este curso']),
            ...(contactRecord?.doNotCall ? ['el contacto del curso esta marcado do_not_call'] : []),
            ...(contactRecord?.lastContactedAt
              ? [`ultimo contacto registrado: ${contactRecord.lastContactedAt}`]
              : []),
          ],
        };
      }),
    );

    reply.code(200).send({ total: cursos.length, cursos });
  });

  // -------------------------------------------------------------------------
  // GET /api/calls — followups con su resultado
  // -------------------------------------------------------------------------
  app.get('/api/calls', async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const repo = followupRepository();
    const followups = await repo.listByEstados(ALL_FOLLOWUP_ESTADOS, parseLimit(limit));

    const llamadas = await Promise.all(
      followups.map(async (f) => {
        const calls = await repo.listCalls(f.followupId);
        const ultima = calls[calls.length - 1];
        return {
          followupId: f.followupId,
          estado: f.estado,
          motivo: f.motivo,
          prioridad: f.prioridad,
          origen: f.origen ?? 'automatico',
          requestedBy: f.requestedBy ?? null,
          orderNumber: f.oc,
          courseName: f.curso,
          clientName: f.contexto.clientName,
          telefonoMasked: maskPhone(f.destinatarioPhone),
          intentos: f.intentos,
          nextAttemptAt: f.nextAttemptAt,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
          totalLlamadas: calls.length,
          resultado: ultima
            ? {
                conversationId: ultima.conversationId,
                outcome: ultima.outcome ?? null,
                status: ultima.status,
                durationSeconds: ultima.durationSeconds,
                endedAt: ultima.endedAt,
                camposExtraidos: ultima.dataCollection ?? {},
              }
            : null,
        };
      }),
    );

    reply.code(200).send({ total: llamadas.length, llamadas });
  });

  // -------------------------------------------------------------------------
  // GET /api/calls/:id — detalle completo, con transcripcion
  // -------------------------------------------------------------------------
  app.get('/api/calls/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = followupRepository();
    const followup = await repo.getById(id);
    if (!followup) {
      reply.code(404).send({ error: 'followup_no_encontrado', followupId: id });
      return;
    }
    const calls = await repo.listCalls(id);

    reply.code(200).send({
      followup: {
        followupId: followup.followupId,
        estado: followup.estado,
        motivo: followup.motivo,
        prioridad: followup.prioridad,
        origen: followup.origen ?? 'automatico',
        requestedBy: followup.requestedBy ?? null,
        orderNumber: followup.oc,
        courseName: followup.curso,
        telefonoMasked: maskPhone(followup.destinatarioPhone),
        intentos: followup.intentos,
        nextAttemptAt: followup.nextAttemptAt,
        createdAt: followup.createdAt,
        updatedAt: followup.updatedAt,
        contexto: followup.contexto,
      },
      llamadas: calls.map((c) => ({
        conversationId: c.conversationId,
        callSid: c.callSid,
        status: c.status,
        outcome: c.outcome ?? null,
        durationSeconds: c.durationSeconds,
        endedAt: c.endedAt,
        camposExtraidos: c.dataCollection ?? {},
        evaluacion: c.evaluation ?? {},
        transcriptSummary: c.transcriptSummary ?? null,
        transcript: c.transcript ?? [],
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/calls — dispara UNA llamada manual
  // -------------------------------------------------------------------------
  app.post('/api/calls', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseJsonBody(request.body);
    if (!body) {
      reply.code(400).send({ error: 'body_json_invalido' });
      return;
    }

    const headerKey = request.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerKey === 'string' ? headerKey : undefined) ?? body.idempotencyKey;

    if (!idempotencyKey) {
      reply.code(400).send({
        error: 'idempotency_key_requerida',
        detalle:
          'Manda el header Idempotency-Key (o idempotencyKey en el body). Es obligatoria para ' +
          'que un doble click no origine dos llamadas.',
      });
      return;
    }
    if (!body.clientId || !body.orderNumber || !body.phone) {
      reply.code(400).send({
        error: 'campos_requeridos',
        detalle: 'clientId, orderNumber y phone son obligatorios.',
      });
      return;
    }

    const result = await originateManualCall(
      {
        clientId: body.clientId,
        orderNumber: body.orderNumber,
        phone: body.phone,
        idempotencyKey,
        requestedBy: body.requestedBy,
      },
      {
        followupRepository: followupRepository(),
        contactRepository: contactRepository(),
        quotaRepository: quotaRepository(),
        tableroClient: tableroClient(),
        ...deps.manualCallDeps,
      },
    );

    const httpStatus = HTTP_STATUS_BY_MANUAL_CALL_STATUS[result.status] ?? 409;
    logger.info('api_post_calls', {
      status: result.status,
      httpStatus,
      followupId: result.followupId,
      orderNumber: body.orderNumber,
      phone: body.phone,
    });
    reply.code(httpStatus).send(result);
  });
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

/**
 * El server local registra un content-type parser que deja el body de `application/json` como
 * STRING crudo (lo necesitan los webhooks para validar la firma HMAC exacta). Aca hay que
 * parsearlo a mano.
 */
function parseJsonBody(raw: unknown): CreateCallBody | null {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw as CreateCallBody;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as CreateCallBody;
  } catch {
    return null;
  }
}

/** Dias que le quedan al curso (negativo si ya termino). */
function diasRestantes(endCourse: string, now: Date = new Date()): number {
  const end = new Date(`${endCourse}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(end)) return 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - today) / (24 * 60 * 60 * 1000));
}
