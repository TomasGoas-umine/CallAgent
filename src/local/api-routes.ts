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
import { HttpTableroApiClient } from '../services/tablero-api-client.http.js';
import {
  readSemaforo,
  readSemaforoSecciones,
  isCourseCallable,
} from '../services/course-lookup.js';
import {
  ESTADOS_EDITABLES,
  evaluateAllMockOrders,
  getCallRules,
  isAutoCallEnabled,
  recordTriggerEvaluation,
  resetMockStore,
  setAutoCallEnabled,
  setCallRules,
  updateMockOrder,
  type MockOrderPatch,
} from '../services/mock-tablero-store.js';
import { defaultCallRules, validarCallRules } from '../services/call-rules.js';
import { maybeTriggerMockCall } from '../services/mock-call-trigger.js';
import { MOCK_TEST_PHONES, testPhoneWhitelist } from '../services/guardrails.js';
import {
  isKillSwitchActive,
  isNumberAllowed,
  isWithinBusinessHours,
} from '../services/guardrails.js';
import { originateManualCall, type ManualCallStatus } from '../services/manual-call.js';
import { syncConversations, syncConversacionForzada } from '../services/conversation-sync.js';
import { buildConversationsClient } from '../services/elevenlabs-conversations-client.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { ContactRepository } from '../repositories/contact-repository.js';
import { QuotaRepository } from '../repositories/quota-repository.js';
import { buildCourseAgentVariables } from '../services/agent-variables.js';
import { ALL_FOLLOWUP_ESTADOS, MOTIVO_RIESGO_CONEXION } from '../domain/followup.js';
import { env } from '../utils/env.js';
import { logger, maskPhone } from '../utils/logger.js';
import type { ManualCallDeps } from '../services/manual-call.js';
import type { TableroApiClient } from '../services/tablero-api-client.js';
import type { ConversationsClient } from '../services/elevenlabs-conversations-client.js';

/** Inyectables — en produccion/local se usan los defaults; los tests pasan los suyos. */
export interface ApiDeps {
  followupRepository?: FollowupRepository;
  contactRepository?: ContactRepository;
  quotaRepository?: QuotaRepository;
  tableroClient?: TableroApiClient;
  /** Se pasa tal cual a `originateManualCall` (permite inyectar el cliente mockeado). */
  manualCallDeps?: ManualCallDeps;
  /** Lector de conversaciones de ElevenLabs (solo GET). Los tests inyectan uno falso. */
  conversationsClient?: ConversationsClient;
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
  fuera_de_whitelist_pruebas: 403,
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

/**
 * Vigencia de la cache del Tablero Original. El SENCE Sync corre cada 30 min, asi que 5 minutos
 * no puede mostrar nada "viejo" que no lo estuviera igual sin cache.
 */
const ORIGINAL_CACHE_TTL_MS = 5 * 60 * 1000;

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
       * Estado del camino PUSH (ElevenLabs nos entrega el resultado).
       *
       * `urlConfigurada` dice solo que hay una PUBLIC_BASE_URL en el .env: no prueba que la URL
       * resuelva, ni que exista un webhook registrado apuntando a ella, ni que el secreto sea el
       * correcto. Comprobar eso exige salir a la red, y este endpoint lo consulta el micrositio
       * a cada rato — la verificacion de verdad vive en `npm run providers:check` (§5) y
       * `npm run webhook:selftest`. Antes este campo se llamaba `configurado` y afirmaba de mas.
       */
      webhookPostCall: {
        urlConfigurada: Boolean(env.publicBaseUrl),
        registroConfigurado: Boolean(
          process.env.ELEVENLABS_WEBHOOK_ID &&
          env.elevenlabsWebhookSecret &&
          env.elevenlabsWebhookSecret !== 'demo-local-secret',
        ),
        url: env.publicBaseUrl ? `${env.publicBaseUrl}/webhooks/elevenlabs/post-call` : null,
        verificadoCon: 'npm run providers:check && npm run webhook:selftest',
      },
      /**
       * Camino PULL: el proyecto va a buscar el resultado a la API de ElevenLabs. No depende de
       * URL publica, tunel, webhook registrado ni secreto — solo de la API key. Es el que hace
       * que el registro de llamadas no dependa de que el push funcione.
       */
      sincronizacionPorApi: {
        disponible: Boolean(env.elevenlabsApiKey),
        endpoint: 'POST /api/calls/sync',
        comando: 'npm run calls:sync',
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/tablero — las OCs de la seccion A del Semaforo, ya agregadas y clasificadas.
  //
  // Este endpoint ES el adaptador: hace del lado del backend exactamente el trabajo que el
  // frontend del Semaforo hace en el browser (agregar por OC, promover estado, clasificar), y
  // lo entrega ya resuelto para que el micrositio de CallAgent no reimplemente ni una regla.
  // Si algun dia `tablero-api` entrega OCs agregadas y clasificadas, este adaptador desaparece
  // sin tocar el front (ver docs/SEMAFORO_INTEGRACION.md §10).
  // -------------------------------------------------------------------------
  app.get('/api/tablero', async (_request, reply) => {
    const { evaluaciones: evaluations, stats } = await readSemaforo(tableroClient());
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
          /**
           * `true` si el Semaforo real lo listaria en su seccion A (descarta NORMAL, igual que
           * `StatusCursosPage.tsx:568`). El micrositio lo usa para mostrar por defecto la misma
           * seleccion que el tablero original, sin decidir el criterio por su cuenta.
           */
          visibleEnSemaforo: e.visibleEnSemaforo,
          pctConexion: Number(e.group.pctConexion.toFixed(1)),
          inscritos: e.group.enrolledCount,
          conectados: e.group.totalConnections,
          diasRestantes: e.diasRestantes,
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
           * `true` si el CURSO califica para una llamada: seccion A del Semaforo Y nivel
           * CRITICO (unico caso de uso del MVP). Los gates que dependen del NUMERO elegido
           * (allowlist) o del estado global (cuota, kill switch, ventana horaria) no se evaluan
           * aca: el numero lo elige el operador en el desplegable de la allowlist, y el estado
           * global sale de GET /api/health.
           */
          llamable: isCourseCallable(tableroClient(), e),
          /**
           * Exactamente las dynamic_variables que recibiria el agente si se dispara esta
           * llamada. Salen del mismo modulo que usa el dispatcher, para que el modal de
           * confirmacion no muestre algo distinto de lo que se envia.
           */
          variablesAgente: buildCourseAgentVariables(e, MOTIVO_RIESGO_CONEXION),
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

    // `stats` viaja al micrositio para que el operador pueda ver de un vistazo si la lectura
    // fue completa (paginas, registros, truncado) o si el Semaforo devolvio menos de lo
    // esperado. Sin esto, "0 candidatos" y "la lectura fallo" se ven exactamente igual.
    reply.code(200).send({ total: cursos.length, cursos, stats });
  });

  // =========================================================================
  // TABLERO MOCK — datos simulados, EDITABLES, y el unico camino automatico que puede llamar
  // =========================================================================

  /**
   * Arma la respuesta del Mock. Toda la clasificacion viene del store; el front no calcula.
   *
   * Los datos de telefono van POR NUMERO, no globales: cada OC elige a cual de los numeros de
   * la etapa de pruebas se llama, asi que `do_not_call` y la allowlist se resuelven para cada
   * uno. El front cruza `orden.order.phone` contra esta lista.
   */
  async function mockPayload() {
    const telefonos = await Promise.all(
      MOCK_TEST_PHONES.map(async (valor) => {
        const contacto = await contactRepository().getByPhone(valor);
        return {
          valor,
          masked: maskPhone(valor),
          /**
           * `do_not_call` es permanente por diseno (consentimiento, ver ContactRepository): no
           * hay endpoint que lo revierta. Se expone para que el micrositio lo avise en vez de
           * que la llamada falle sin explicacion.
           */
          doNotCall: contacto?.doNotCall ?? false,
          ultimoContactoAt: contacto?.lastContactedAt ?? null,
          enAllowlist: isNumberAllowed(valor),
        };
      }),
    );
    return {
      /** Los numeros que el editor puede asignar a una OC, con el estado de cada uno. */
      telefonos,
      whitelistPruebas: testPhoneWhitelist(),
      autoCallEnabled: isAutoCallEnabled(),
      cooldownSegundos: env.mockCallCooldownSeconds,
      estadosEditables: ESTADOS_EDITABLES,
      callRules: getCallRules(),
      callRulesDefault: defaultCallRules(),
      ordenes: evaluateAllMockOrders(),
    };
  }

  app.get('/api/tablero/mock', async (_request, reply) => {
    reply.code(200).send(await mockPayload());
  });

  /**
   * PATCH de UNA OC. Valida en el backend (nunca en el front), recalcula semana/%/nivel con los
   * mismos modulos espejo del Semaforo, y —si la edicion produjo una transicion hacia la
   * condicion configurada para llamar— origina la llamada REAL por el mismo camino que el
   * Disparador.
   */
  app.patch<{ Params: { clientId: string; orderNumber: string }; Body: MockOrderPatch }>(
    '/api/tablero/mock/orders/:clientId/:orderNumber',
    async (request, reply) => {
      const { clientId, orderNumber } = request.params;
      // El server local deja el body de application/json como string crudo (HMAC): parsear aca.
      const body = parseJsonBodyRaw(request.body);
      if (!body.ok) {
        reply.code(400).send({ error: 'json_invalido', detalle: 'El cuerpo no es JSON valido.' });
        return;
      }
      const patch = (body.value ?? {}) as MockOrderPatch;

      const resultado = updateMockOrder(clientId, orderNumber, patch);
      if (!resultado.ok) {
        reply.code(400).send({ error: 'patch_invalido', detalle: resultado.error });
        return;
      }

      const trigger = await maybeTriggerMockCall(clientId, orderNumber, deps.manualCallDeps ?? {});
      // `aviso`: el store corrigio algo que el operador no pidio (el estado, cuando las fechas
      // lo contradecian). La edicion se guardo — no es un error, pero tiene que verse.
      reply.code(200).send({ ...(await mockPayload()), trigger, aviso: resultado.aviso });
    },
  );

  /** Restaura datos, umbrales, toggle y memoria de disparos al fixture original. */
  app.post('/api/tablero/mock/reset', async (_request, reply) => {
    resetMockStore();
    logger.info('mock_store_reset');
    reply.code(200).send(await mockPayload());
  });

  /**
   * Umbrales que disparan LLAMADAS (no la criticidad del Semaforo, que no es configurable).
   *
   * Cambiar los umbrales NO llama: se re-linea el latch de cada OC con las reglas nuevas. Si no
   * fuera asi, bajar un umbral originaria de golpe una llamada por cada OC que quedo en
   * condicion — todas al mismo unico telefono de pruebas.
   */
  app.put<{ Body: unknown }>('/api/tablero/mock/call-rules', async (request, reply) => {
    const body = parseJsonBodyRaw(request.body);
    if (!body.ok) {
      reply.code(400).send({ error: 'json_invalido', detalle: 'El cuerpo no es JSON valido.' });
      return;
    }
    const validado = validarCallRules(body.value);
    if (!validado.ok) {
      reply.code(400).send({ error: 'call_rules_invalidas', detalle: validado.error });
      return;
    }
    setCallRules(validado.rules);
    rebaselineTriggers();
    reply.code(200).send(await mockPayload());
  });

  app.post('/api/tablero/mock/call-rules/reset', async (_request, reply) => {
    setCallRules(defaultCallRules());
    rebaselineTriggers();
    reply.code(200).send(await mockPayload());
  });

  /**
   * Encender/apagar las llamadas automaticas del Mock. Apagado por defecto.
   * Encenderlo tampoco llama por si solo, por la misma razon que los umbrales: se re-linea el
   * latch primero. Hace falta una edicion posterior que produzca la transicion.
   */
  app.put<{ Body: { enabled?: unknown } }>(
    '/api/tablero/mock/auto-call',
    async (request, reply) => {
      const body = parseJsonBodyRaw(request.body);
      const enabled = body.ok ? (body.value as { enabled?: unknown })?.enabled : undefined;
      if (typeof enabled !== 'boolean') {
        reply.code(400).send({ error: 'body_invalido', detalle: 'enabled debe ser booleano' });
        return;
      }
      rebaselineTriggers();
      setAutoCallEnabled(enabled);
      logger.warn('mock_auto_call_toggled', { enabled });
      reply.code(200).send(await mockPayload());
    },
  );

  /** Re-linea el latch de todas las OCs sin llamar: evita rafagas al cambiar configuracion. */
  function rebaselineTriggers(): void {
    for (const e of evaluateAllMockOrders()) {
      recordTriggerEvaluation(e.order.clientId, e.order.orderNumber, e.regla.dispara);
    }
  }

  // =========================================================================
  // TABLERO ORIGINAL — dato real de tablero-api, SOLO LECTURA
  // =========================================================================

  /** Cache de la ultima lectura real. Ver el comentario en la ruta. */
  let cacheOriginal: { at: number; payload: Record<string, unknown> } | null = null;

  /**
   * Lee `tablero-api` de verdad y devuelve lo que el adaptador ya calcula, para las TRES
   * secciones del Semaforo: A (Riesgo Conexion), B (Riesgo DJ) y C (Rectificacion). Es
   * estrictamente de lectura: no crea candidatos, no crea FOLLOWUPs, no encola y no llama.
   * Construye su propio `HttpTableroApiClient` en vez de usar `buildTableroApiClient()`
   * justamente para que este cliente no pueda terminar en un camino de originacion.
   *
   * B y C solo existen aca. Ni el disparador ni el Tablero Mock ni `call-rules.ts` las miran:
   * una DJ que falta o una OC Final que no llega se resuelven con el OTIC, no llamando al
   * alumno (ADR-011).
   */
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/tablero/original',
    async (request, reply) => {
      if (!env.tableroApiBaseUrl) {
        reply.code(503).send({
          error: 'tablero_api_no_configurada',
          detalle:
            'Falta TABLERO_API_BASE_URL en el .env — el Tablero Original necesita la URL del API Gateway de tablero-api.',
        });
        return;
      }

      // Cache corta: leer el dataset real son ~6.000 registros en 3 paginas y tarda ~22s. El dato
      // de fondo solo cambia cada 30 min (cron del SENCE Sync), asi que releerlo en cada visita a
      // la pestana no aporta nada y hace la vista inusable. `?refresh=1` (boton Recargar) lo saltea.
      const forzarRefresh = request.query?.refresh === '1';
      const ahora = Date.now();
      if (!forzarRefresh && cacheOriginal && ahora - cacheOriginal.at < ORIGINAL_CACHE_TTL_MS) {
        reply.code(200).send({ ...cacheOriginal.payload, desdeCache: true });
        return;
      }

      const inicio = Date.now();
      try {
        const client = new HttpTableroApiClient(env.tableroApiBaseUrl, env.tableroApiToken);
        // Las TRES secciones del Semaforo, de una sola lectura. B y C viajan para MOSTRARSE:
        // este payload no entra en ningun camino de originacion (ver cabecera de la ruta).
        const { evaluaciones, seccionB, seccionC, stats } = await readSemaforoSecciones(client);

        const payload = {
          soloLectura: true,
          fuente: `${env.tableroApiBaseUrl}/tablero/search`,
          actualizadoAt: new Date().toISOString(),
          duracionMs: Date.now() - inicio,
          stats,
          total: evaluaciones.length,
          cursos: evaluaciones.map((e) => ({
            clientId: e.group.clientId,
            clientName: e.group.clientName,
            orderNumber: e.group.orderNumber,
            courseName: e.group.courseName,
            orderStatus: e.group.promotedOrderStatus,
            initCourse: e.group.initCourse,
            endCourse: e.group.endCourse,
            semana: e.semana,
            nivel: e.nivel,
            visibleEnSemaforo: e.visibleEnSemaforo,
            pctConexion: Number(e.group.pctConexion.toFixed(1)),
            inscritos: e.group.enrolledCount,
            conectados: e.group.totalConnections,
            diasRestantes: e.diasRestantes,
          })),
          // Seccion B - Riesgo DJ. Ya viene filtrada por el gate (curso cerrado hace >3 dias,
          // con conectados y DJ incompleta): el front no descarta nada, solo ordena y pinta.
          riesgoDj: seccionB.map((e) => ({
            clientId: e.group.clientId,
            clientName: e.group.clientName,
            orderNumber: e.group.orderNumber,
            courseName: e.group.courseName,
            orderStatus: e.group.promotedOrderStatus,
            initCourse: e.group.initCourse,
            endCourse: e.group.endCourse,
            nivel: e.nivel,
            diasDesdeCierre: e.diasDesdeCierre,
            conDj: e.conDj,
            conectados: e.base,
            pendientes: e.pendientes,
            pctDj: Number(e.pctDj.toFixed(1)),
          })),
          // Seccion C - Rectificacion. Idem: el gate ya dejo solo las que llevan >3 dias
          // esperando la OC Final del OTIC.
          rectificacion: seccionC.map((e) => ({
            clientId: e.group.clientId,
            clientName: e.group.clientName,
            orderNumber: e.group.orderNumber,
            courseName: e.group.courseName,
            orderStatus: e.group.promotedOrderStatus,
            otic: e.group.otic,
            nivel: e.nivel,
            diasPendiente: e.diasPendiente,
            ultimaActualizacion: e.group.lastUpdatedAt,
          })),
        };

        cacheOriginal = { at: Date.now(), payload };
        reply.code(200).send({ ...payload, desdeCache: false });
      } catch (err: unknown) {
        const detalle = err instanceof Error ? err.message : String(err);
        logger.error('tablero_original_error', { detalle });
        reply.code(502).send({ error: 'tablero_api_error', detalle });
      }
    },
  );

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
        startedAt: c.startedAt ?? null,
        endedAt: c.endedAt,
        camposExtraidos: c.dataCollection ?? {},
        /** Los mismos campos, con el `rationale` del modelo: la evidencia de cada extraccion. */
        camposExtraidosDetalle: c.dataCollectionDetail ?? {},
        evaluacion: c.evaluation ?? {},
        /** Costo en creditos de ElevenLabs y por que corto la llamada el proveedor. */
        cost: c.cost ?? null,
        terminationReason: c.terminationReason ?? null,
        /** `webhook` = ElevenLabs lo entrego; `sync` = lo fue a buscar `calls:sync`. */
        fuente: c.fuente ?? 'webhook',
        transcriptSummary: c.transcriptSummary ?? null,
        transcript: c.transcript ?? [],
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/calls/sync — trae los resultados de llamada desde la API de ElevenLabs
  //
  // NO origina ninguna llamada: solo hace GET contra ElevenLabs y escribe en la base local.
  // Se registra ANTES de `POST /api/calls` a proposito: Fastify hace match exacto de ruta, pero
  // dejarlos juntos deja claro que son cosas distintas — este no gasta minutos.
  // -------------------------------------------------------------------------
  app.post('/api/calls/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!env.elevenlabsApiKey) {
      reply.code(503).send({
        error: 'sin_api_key',
        detalle:
          'ELEVENLABS_API_KEY vacia. Es lo unico que necesita la sincronizacion (no hace falta ' +
          'URL publica ni webhook registrado).',
      });
      return;
    }

    const body = (parseJsonBody(request.body) ?? {}) as {
      conversationId?: string;
      followupId?: string;
      sinceUnixSecs?: number;
    };
    const conversationsClient =
      deps.conversationsClient ?? buildConversationsClient(env.elevenlabsApiKey);
    const syncDeps = {
      conversationsClient,
      followupRepository: followupRepository(),
      contactRepository: contactRepository(),
    };

    // Atribucion manual explicita: un humano afirma que esta conversacion es de este followup.
    if (body.conversationId || body.followupId) {
      if (!body.conversationId || !body.followupId) {
        reply.code(400).send({
          error: 'atribucion_incompleta',
          detalle: 'La atribucion manual necesita conversationId Y followupId.',
        });
        return;
      }
      const item = await syncConversacionForzada(body.conversationId, body.followupId, syncDeps);
      reply.code(item.estado === 'error' ? 409 : 200).send({ modo: 'forzada', item });
      return;
    }

    const summary = await syncConversations(
      { agentId: env.elevenlabsAgentId || undefined, sinceUnixSecs: body.sinceUnixSecs },
      syncDeps,
    );
    logger.info('api_post_calls_sync', {
      total: summary.total,
      registradas: summary.registradas,
      noAtribuibles: summary.noAtribuibles,
      errores: summary.errores,
    });
    reply.code(200).send(summary);
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
function parseJsonBodyRaw(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} };
  if (typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function parseJsonBody(raw: unknown): CreateCallBody | null {
  const parsed = parseJsonBodyRaw(raw);
  return parsed.ok ? (parsed.value as CreateCallBody) : null;
}
