/**
 * Tests de la API de operacion (`/api/*`), con `fastify.inject()` — sin abrir un puerto real.
 *
 * El foco esta en los codigos de rechazo de `POST /api/calls`: son la barrera que protege la
 * cuota del plan Starter, y tienen que fallar RUIDOSAMENTE (403 / 429 / 503) en vez de
 * originar una llamada. Todo corre con `MOCK_PROVIDERS=true` y contra dynalite real.
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import { IdempotencyRepository } from '../../src/repositories/idempotency-repository.js';
import { QuotaRepository } from '../../src/repositories/quota-repository.js';
import { MockElevenLabsClient } from '../../src/services/elevenlabs-client.js';
import { FixtureTableroApiClient } from '../../src/services/tablero-api-client.fixture.js';
import { generateTestSignatureHeader } from '../../src/auth/elevenlabs-signature-validator.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import { FIXTURE_REFERENCE_NOW } from '../fixtures/reference-time.js';
import type { ElevenLabsClient } from '../../src/services/elevenlabs-client.js';

const ORIGINAL_ENV = { ...process.env };
let serverHarness: DynamoServerHarness;

const DEMO_PHONE = '+56900100141';
const DEMO_CLIENT_ID = 'client_test_demo';
const DEMO_ORDER_NUMBER = 'TEST-9600';

const FUERA_DE_ALLOWLIST = '+56900000013';

const NORMAL_CLIENT_ID = 'client_test_normal_s1';
const NORMAL_ORDER_NUMBER = 'TEST-9104';

const WEBHOOK_SECRET = 'secreto-de-test-solo-local';

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});

afterAll(async () => {
  await serverHarness.stop();
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.MOCK_PROVIDERS = 'true';
  process.env.ALLOWLIST_NUMBERS = DEMO_PHONE;
  process.env.KILL_SWITCH = 'false';
  process.env.DRY_RUN = 'false';
  process.env.DAILY_QUOTA = '5';
  process.env.BUSINESS_HOURS_START = '09:00';
  process.env.BUSINESS_HOURS_END = '19:00';
  process.env.TIMEZONE = 'America/Santiago';
  process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  // Solo Date: dynalite habla HTTP real (ver CLAUDE.md). FIXTURE_REFERENCE_NOW cae un jueves
  // a las 12:00 de Santiago, o sea dentro de la ventana horaria.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

interface TestApp {
  app: FastifyInstance;
  followupRepository: FollowupRepository;
  contactRepository: ContactRepository;
  quotaRepository: QuotaRepository;
  /** Cuenta cuantas veces se intento originar una llamada de verdad. */
  llamadasOriginadas: () => number;
}

/**
 * Server Fastify aislado + tabla propia por test. `vi.resetModules()` antes del import es lo
 * que hace que `env` (congelado al importar) recoja el `process.env` de ESTE test.
 */
async function buildTestApp(
  options: { escenarioMock?: 'success' | 'error' } = {},
): Promise<TestApp> {
  vi.resetModules();
  const { registerApiRoutes } = await import('../../src/local/api-routes.js');

  const tableName = `api-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);

  const followupRepository = new FollowupRepository(tableName, serverHarness.doc);
  const contactRepository = new ContactRepository(tableName, serverHarness.doc);
  const idempotencyRepository = new IdempotencyRepository(tableName, serverHarness.doc);
  const quotaRepository = new QuotaRepository(tableName, serverHarness.doc);

  let originadas = 0;
  const mock = new MockElevenLabsClient(options.escenarioMock ?? 'success');
  const countingClient: ElevenLabsClient = {
    startOutboundCall: async (params) => {
      originadas++;
      return mock.startOutboundCall(params);
    },
  };

  const app = Fastify({ logger: false });
  await app.register(registerApiRoutes, {
    followupRepository,
    contactRepository,
    quotaRepository,
    tableroClient: new FixtureTableroApiClient(undefined, [DEMO_PHONE]),
    manualCallDeps: { idempotencyRepository, elevenLabsClient: countingClient },
  });
  await app.ready();

  return {
    app,
    followupRepository,
    contactRepository,
    quotaRepository,
    llamadasOriginadas: () => originadas,
  };
}

function postCall(
  app: FastifyInstance,
  body: Record<string, unknown>,
  idempotencyKey?: string | null,
) {
  return app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey ?? randomUUID() },
    payload: body,
  });
}

const disparoDemo = {
  clientId: DEMO_CLIENT_ID,
  orderNumber: DEMO_ORDER_NUMBER,
  phone: DEMO_PHONE,
  requestedBy: 'test@umine.com',
};

describe('GET /api/health', () => {
  it('reporta kill switch, DRY_RUN, MOCK_PROVIDERS y la cuota usada/restante', async () => {
    const { app, quotaRepository } = await buildTestApp();
    await quotaRepository.setUsadosForTesting(2);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toMatchObject({
      status: 'ok',
      killSwitch: false,
      dryRun: false,
      mockProviders: true,
      tableroApiMode: 'fixture',
      disparoAutomatico: false,
    });
    expect(body.cuota).toMatchObject({ usados: 2, limite: 5, restantes: 3 });
    expect(body.ventanaHoraria).toMatchObject({ abiertaAhora: true });
    expect(body.allowlist).toEqual([{ value: DEMO_PHONE, masked: '***0141' }]);
    await app.close();
  });

  it('refleja el kill switch activo', async () => {
    process.env.KILL_SWITCH = 'true';
    const { app } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(body.killSwitch).toBe(true);
    await app.close();
  });
});

describe('GET /api/tablero', () => {
  it('devuelve los 15 cursos con urgencia, contacto y telefono enmascarado', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/tablero' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.total).toBe(15);
    expect(body.cursos).toHaveLength(15);

    const demo = body.cursos.find(
      (c: { orderNumber: string }) => c.orderNumber === DEMO_ORDER_NUMBER,
    );
    expect(demo).toMatchObject({
      nivel: 'CRITICO',
      llamable: true,
      clientId: DEMO_CLIENT_ID,
    });
    expect(demo.contacto.nombre).toBeTruthy();
    expect(demo.contacto.cargo).toBeTruthy();
    // `masked` es lo que el TABLERO muestra; `valor` existe para que el disparador pueda
    // ofrecer el numero del curso como opcion y el operador pueda corregirlo a mano.
    expect(demo.telefono).toMatchObject({
      masked: '***0141',
      enAllowlist: true,
      valor: DEMO_PHONE,
    });
    expect(demo.variablesAgente).toMatchObject({
      orden_compra: DEMO_ORDER_NUMBER,
      motivo: 'riesgo_conexion_critico',
    });

    // Estan los tres niveles y las cuatro semanas de curso.
    const niveles = new Set(body.cursos.map((c: { nivel: string }) => c.nivel));
    expect(niveles).toEqual(new Set(['CRITICO', 'ALERTA', 'NORMAL']));
    const semanas = new Set(body.cursos.map((c: { semana: number }) => c.semana));
    expect(semanas).toEqual(new Set([1, 2, 3, 4]));
    await app.close();
  });

  it('en modo http NO expone el telefono completo: solo el enmascarado', async () => {
    // Los telefonos del fixture son sinteticos, por eso se pueden entregar completos. Con un
    // Semaforo real, exponer telefonos de terceros es una decision de privacidad que hay que
    // tomar aparte (UV-024 / UV-046), asi que el campo llega en null a proposito.
    process.env.TABLERO_API_MODE = 'http';
    const { app } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/tablero' })).json();

    const demo = body.cursos.find(
      (c: { orderNumber: string }) => c.orderNumber === DEMO_ORDER_NUMBER,
    );
    expect(demo.telefono.masked).toBe('***0141');
    expect(demo.telefono.valor).toBeNull();
    // Y el numero completo no aparece en ninguna parte de la respuesta.
    expect(JSON.stringify(body)).not.toContain(DEMO_PHONE);
    await app.close();
  });

  it('marca do_not_call y la falta de telefono como advertencias, sin ocultar el curso', async () => {
    const { app } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/tablero' })).json();

    const sinTelefono = body.cursos.find(
      (c: { orderNumber: string }) => c.orderNumber === 'TEST-9500',
    );
    expect(sinTelefono.telefono.disponible).toBe(false);
    expect(sinTelefono.advertencias.join(' ')).toContain('no trae telefono');
    await app.close();
  });
});

describe('POST /api/calls — rechazos que protegen la cuota', () => {
  it('sin Idempotency-Key devuelve 400 y no origina nada', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const response = await postCall(app, disparoDemo, null);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('idempotency_key_requerida');
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('un numero fuera de la allowlist devuelve 403', async () => {
    const { app, llamadasOriginadas, quotaRepository } = await buildTestApp();
    const response = await postCall(app, { ...disparoDemo, phone: FUERA_DE_ALLOWLIST });

    expect(response.statusCode).toBe(403);
    expect(response.json().status).toBe('no_en_allowlist');
    expect(llamadasOriginadas()).toBe(0);
    expect((await quotaRepository.peek(5)).usados).toBe(0);
    await app.close();
  });

  it('con la cuota diaria agotada devuelve 429', async () => {
    const { app, llamadasOriginadas, quotaRepository } = await buildTestApp();
    await quotaRepository.setUsadosForTesting(5);

    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(429);
    expect(response.json().status).toBe('cuota_diaria_alcanzada');
    expect(response.json().cuota).toMatchObject({ usados: 5, limite: 5, restantes: 0 });
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('con el kill switch activo devuelve 503', async () => {
    process.env.KILL_SWITCH = 'true';
    const { app, llamadasOriginadas, quotaRepository } = await buildTestApp();

    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('kill_switch');
    expect(llamadasOriginadas()).toBe(0);
    expect((await quotaRepository.peek(5)).usados).toBe(0);
    await app.close();
  });

  it('fuera de la ventana horaria devuelve 409 sin originar la llamada', async () => {
    // 03:00 Santiago (07:00 UTC) de un martes.
    vi.setSystemTime(new Date('2026-08-11T07:00:00.000Z'));
    const { app, llamadasOriginadas } = await buildTestApp();

    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(409);
    expect(response.json().status).toBe('fuera_de_ventana_horaria');
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('un curso que no es CRITICO devuelve 409', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const response = await postCall(app, {
      clientId: NORMAL_CLIENT_ID,
      orderNumber: NORMAL_ORDER_NUMBER,
      phone: DEMO_PHONE,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().status).toBe('curso_no_critico');
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('un curso que no existe en el Semaforo devuelve 404', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const response = await postCall(app, {
      clientId: 'client_inexistente',
      orderNumber: 'OC-INEXISTENTE',
      phone: DEMO_PHONE,
    });

    expect(response.statusCode).toBe(404);
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('un destinatario marcado do_not_call devuelve 403', async () => {
    const { app, contactRepository, llamadasOriginadas } = await buildTestApp();
    await contactRepository.markDoNotCall(DEMO_PHONE);

    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(403);
    expect(response.json().status).toBe('do_not_call');
    expect(llamadasOriginadas()).toBe(0);
    await app.close();
  });

  it('si el proveedor rechaza la llamada devuelve 502', async () => {
    const { app } = await buildTestApp({ escenarioMock: 'error' });
    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(502);
    expect(response.json().status).toBe('error_proveedor');
    await app.close();
  });
});

describe('POST /api/calls — camino feliz e idempotencia', () => {
  it('devuelve 201 y consume exactamente un slot de cuota', async () => {
    const { app, llamadasOriginadas, quotaRepository, followupRepository } = await buildTestApp();
    const response = await postCall(app, disparoDemo);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: 'dialing', followupEstado: 'DIALING' });
    expect(body.conversationId).toBeTruthy();
    expect(body.cuota).toMatchObject({ usados: 1, restantes: 4 });
    expect(llamadasOriginadas()).toBe(1);

    const followup = await followupRepository.getById(body.followupId);
    expect(followup).toMatchObject({
      estado: 'DIALING',
      origen: 'manual',
      requestedBy: 'test@umine.com',
    });
    expect((await quotaRepository.peek(5)).usados).toBe(1);
    await app.close();
  });

  it('la misma idempotency key dos veces origina UNA sola llamada', async () => {
    const { app, llamadasOriginadas, quotaRepository } = await buildTestApp();
    const key = `doble-click-${randomUUID()}`;

    const primera = await postCall(app, disparoDemo, key);
    const segunda = await postCall(app, disparoDemo, key);

    expect(primera.statusCode).toBe(201);
    expect(primera.json().status).toBe('dialing');

    expect(segunda.statusCode).toBe(200);
    expect(segunda.json().status).toBe('already_processed');
    expect(segunda.json().followupId).toBe(primera.json().followupId);

    // Lo que importa: el proveedor se llamo una sola vez y la cuota se movio una sola vez.
    expect(llamadasOriginadas()).toBe(1);
    expect((await quotaRepository.peek(5)).usados).toBe(1);
    await app.close();
  });

  it('acepta la idempotency key en el body si no viene el header', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const key = `en-el-body-${randomUUID()}`;

    const primera = await postCall(app, { ...disparoDemo, idempotencyKey: key }, null);
    const segunda = await postCall(app, { ...disparoDemo, idempotencyKey: key }, null);

    expect(primera.statusCode).toBe(201);
    expect(segunda.statusCode).toBe(200);
    expect(llamadasOriginadas()).toBe(1);
    await app.close();
  });
});

describe('GET /api/calls y /api/calls/:id', () => {
  it('listan el followup disparado y, tras el webhook, su transcripcion', async () => {
    const { app, followupRepository, contactRepository } = await buildTestApp();
    const disparo = (await postCall(app, disparoDemo)).json();

    // --- Antes del webhook: aparece en la lista, todavia sin resultado ---
    const listaInicial = (await app.inject({ method: 'GET', url: '/api/calls' })).json();
    expect(listaInicial.total).toBe(1);
    expect(listaInicial.llamadas[0]).toMatchObject({
      followupId: disparo.followupId,
      estado: 'DIALING',
      origen: 'manual',
      telefonoMasked: '***0141',
      resultado: null,
    });

    // --- Webhook post-call de ElevenLabs, firmado ---
    const payload = {
      type: 'post_call_transcription',
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        conversation_id: disparo.conversationId,
        agent_id: 'agent_test',
        status: 'done',
        call_successful: 'success',
        transcript: [
          { role: 'agent', message: 'Le llamo de Umine por el curso SENCE.' },
          { role: 'user', message: 'Me conecto manana sin falta.' },
        ],
        metadata: { call_duration_secs: 37, call_sid: 'CA_test_api' },
        analysis: {
          transcript_summary: 'Se compromete a conectarse manana.',
          data_collection_results: {
            motivo_no_conexion: { value: 'olvido_conectarse' },
            tiene_bloqueo_tecnico: { value: false },
            compromiso_fecha: { value: '2026-08-20' },
            requiere_humano: { value: false },
            necesidad_capacitacion_futura: { value: '' },
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    vi.resetModules();
    const { handleElevenLabsPostCall } =
      await import('../../src/handlers/webhooks/elevenlabs-post-call/handler.js');
    const webhookResponse = await handleElevenLabsPostCall(
      rawBody,
      generateTestSignatureHeader(WEBHOOK_SECRET, rawBody),
      { followupRepository, contactRepository, webhookSecret: WEBHOOK_SECRET },
    );
    expect(webhookResponse.statusCode).toBe(200);

    // --- Despues del webhook: la lista trae el resultado clasificado ---
    const lista = (await app.inject({ method: 'GET', url: '/api/calls' })).json();
    expect(lista.llamadas[0]).toMatchObject({ estado: 'RESUELTO', totalLlamadas: 1 });
    expect(lista.llamadas[0].resultado).toMatchObject({
      outcome: 'resolved',
      durationSeconds: 37,
    });
    expect(lista.llamadas[0].resultado.camposExtraidos).toMatchObject({
      motivo_no_conexion: 'olvido_conectarse',
    });

    // --- Y el detalle trae la transcripcion completa ---
    const detalle = (
      await app.inject({ method: 'GET', url: `/api/calls/${disparo.followupId}` })
    ).json();
    expect(detalle.followup).toMatchObject({ estado: 'RESUELTO', origen: 'manual' });
    expect(detalle.llamadas).toHaveLength(1);
    expect(detalle.llamadas[0].transcript).toHaveLength(2);
    expect(detalle.llamadas[0].transcriptSummary).toContain('compromete');
    expect(detalle.llamadas[0].evaluacion).toBeDefined();
    await app.close();
  });

  it('un followup inexistente devuelve 404', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/calls/no-existe' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
