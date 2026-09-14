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
import { resetMockStore } from '../../src/services/mock-tablero-store.js';
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
  process.env.TEST_PHONE_WHITELIST = DEMO_PHONE;
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
    // Sin PUBLIC_BASE_URL el webhook post-call no puede llegar: el micrositio lo avisa en vez
    // de dejar que un followup en DIALING parezca un bug (UV-051). El campo se llama
    // `urlConfigurada` y NO `configurado` a proposito: solo mira el .env, no prueba que la URL
    // resuelva ni que el webhook este registrado en ElevenLabs (UV-058).
    expect(body.webhookPostCall).toEqual({
      urlConfigurada: false,
      registroConfigurado: false,
      url: null,
      verificadoCon: 'npm run providers:check && npm run webhook:selftest',
    });
    // El camino por API es el que no depende de nada de eso.
    expect(body.sincronizacionPorApi).toMatchObject({ endpoint: 'POST /api/calls/sync' });
    await app.close();
  });

  it('con PUBLIC_BASE_URL informa la url del webhook, sin afirmar que este verificada', async () => {
    process.env.PUBLIC_BASE_URL = 'https://tunel-de-prueba.test';
    const { app } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(body.webhookPostCall).toEqual({
      urlConfigurada: true,
      registroConfigurado: false,
      url: 'https://tunel-de-prueba.test/webhooks/elevenlabs/post-call',
      verificadoCon: 'npm run providers:check && npm run webhook:selftest',
    });
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
  it('devuelve las OCs de la seccion A con urgencia, contacto y telefono enmascarado', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/tablero' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // 15 OCs agrupadas, 14 en seccion A: el gate descarta la que ya esta al 100% de conexion
    // (StatusCursosPage.tsx:535 — `pctConexion < 1`). El endpoint entrega solo la seccion A.
    expect(body.stats.ocsAgrupadas).toBe(15);
    expect(body.stats.ocsFueraDeSeccionA.conexion_completa).toBe(1);
    expect(body.total).toBe(14);
    expect(body.cursos).toHaveLength(14);
    expect(body.cursos.every((c: { pctConexion: number }) => c.pctConexion < 100)).toBe(true);

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

// ---------------------------------------------------------------------------
// Tablero Mock y Tablero Original — endpoints separados, modos que no se mezclan
// ---------------------------------------------------------------------------

describe('GET/PATCH /api/tablero/mock', () => {
  beforeEach(() => {
    // El store del Mock es un singleton de modulo: cada test arranca del fixture.
    resetMockStore();
  });

  it('devuelve las OCs editables ya evaluadas, con las llamadas automaticas APAGADAS', async () => {
    const { app } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/tablero/mock' })).json();

    expect(body.autoCallEnabled).toEqual({ A_RIESGO_CONEXION: false, B_RIESGO_DJ: false });
    // Los numeros asignables llegan con su estado resuelto; el front no los conoce de antemano.
    expect(body.telefonos.map((t: { valor: string }) => t.valor)).toEqual([
      '+56956194817',
      '+56955326503',
    ]);
    // Toda OC arranca en el numero por defecto, y siempre en uno de los autorizados.
    expect(body.ordenes[0].order.phone).toBe('+56956194817');
    expect(body.ordenes.length).toBeGreaterThan(10);
    // Semana, % y nivel llegan calculados: el micrositio no recalcula nada.
    expect(body.ordenes[0]).toHaveProperty('semana');
    expect(body.ordenes[0]).toHaveProperty('pctConexion');
    expect(body.ordenes[0]).toHaveProperty('nivel');
    expect(body.ordenes[0].regla).toHaveProperty('dispara');
  });

  it('un PATCH valido recalcula la OC y devuelve el tablero completo', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104',
      payload: { inscritos: 10, conexiones: 1 },
    });

    expect(response.statusCode).toBe(200);
    const oc = response
      .json()
      .ordenes.find((o: { order: { orderNumber: string } }) => o.order.orderNumber === 'TEST-9104');
    expect(oc.inscritosActivos).toBe(10);
    expect(oc.conectados).toBe(1);
    expect(oc.pctConexion).toBe(10);
  });

  it('un PATCH invalido devuelve 400 y no cambia nada (la validacion vive en el backend)', async () => {
    const { app } = await buildTestApp();
    const antes = (await app.inject({ method: 'GET', url: '/api/tablero/mock' })).json();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104',
      payload: { inscritos: 2, conexiones: 5 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detalle).toMatch(/conexiones no puede superar/);
    const despues = (await app.inject({ method: 'GET', url: '/api/tablero/mock' })).json();
    expect(despues.ordenes).toEqual(antes.ordenes);
  });

  it('marcar NO INICIADA un curso ya arrancado devuelve 400 y deja la OC intacta', async () => {
    const { app } = await buildTestApp();
    const antes = (await app.inject({ method: 'GET', url: '/api/tablero/mock' })).json();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104',
      payload: { orderStatus: 'NO INICIADA' },
    });

    expect(response.statusCode).toBe(400);
    // El mensaje que ve el operador dice que estado va a usar el Semaforo y que fecha mover.
    expect(response.json().detalle).toMatch(/CURSO EN OPERACIÓN/);
    expect(response.json().detalle).toMatch(/fechas mandan/);
    const despues = (await app.inject({ method: 'GET', url: '/api/tablero/mock' })).json();
    expect(despues.ordenes).toEqual(antes.ordenes);
  });

  it('mover el inicio al futuro si deja la OC NO INICIADA, y lo avisa', async () => {
    const { app } = await buildTestApp();
    const futuro = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104',
      payload: { initCourse: futuro },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().aviso).toMatch(/NO INICIADA/);
    const oc = response
      .json()
      .ordenes.find((o: { order: { orderNumber: string } }) => o.order.orderNumber === 'TEST-9104');
    expect(oc.order.orderStatus).toBe('NO INICIADA');
    // Y sale de la seccion A de verdad, no solo en la pantalla.
    expect(oc.enSeccionA).toBe(false);
  });

  it('editar con las llamadas apagadas nunca origina una llamada', async () => {
    const { app, llamadasOriginadas, followupRepository } = await buildTestApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104',
      payload: { conexiones: 0 },
    });

    expect(response.json().trigger.motivo).toBe('auto_call_desactivado');
    expect(llamadasOriginadas()).toBe(0);
    expect(await followupRepository.listByEstados(['READY', 'DIALING'], 10)).toHaveLength(0);
  });

  it('los umbrales de llamada se editan y se restauran, y cambiarlos NO llama', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();

    const puesto = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/call-rules',
      payload: { llamarSiPctMenorA: { 3: 95 } },
    });
    expect(puesto.statusCode).toBe(200);
    expect(puesto.json().callRules.llamarSiPctMenorA['3']).toBe(95);
    expect(llamadasOriginadas()).toBe(0);

    const restaurado = await app.inject({
      method: 'POST',
      url: '/api/tablero/mock/call-rules/reset',
    });
    expect(restaurado.json().callRules).toEqual(restaurado.json().callRulesDefault);
  });

  it('configurar/restaurar DJ con B encendido no llama ni cambia el semáforo y conserva A', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const endCourse = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
    const path = '/api/tablero/mock/orders/client_test_normal_s1/TEST-9104';
    const prepared = await app.inject({
      method: 'PATCH',
      url: path,
      payload: { initCourse: '2026-01-01', endCourse, conexiones: 8, djs: 2 },
    });
    const before = prepared
      .json()
      .ordenes.find((e: { order: { orderNumber: string } }) => e.order.orderNumber === 'TEST-9104');
    expect(before.dj.nivel).toBe('ALERTA');
    await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/auto-call',
      payload: { seccion: 'B_RIESGO_DJ', enabled: true },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/call-rules',
      payload: { llamarSiPctMenorA: { 2: 70 } },
    });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/call-rules',
      payload: { dj: { llamarSiDiasMayorA: 3, nivelesQueLlaman: ['ALERTA'] } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().callRules.llamarSiPctMenorA[2]).toBe(70);
    const after = saved
      .json()
      .ordenes.find((e: { order: { orderNumber: string } }) => e.order.orderNumber === 'TEST-9104');
    expect(after.dj).toEqual(before.dj);
    expect(after.regla.dispara).toBe(true);
    const same = await app.inject({ method: 'PATCH', url: path, payload: { djs: 2 } });
    expect(same.json().trigger.motivo).toBe('sin_transicion');
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/call-rules',
      payload: { dj: { llamarSiDiasMayorA: -1 } },
    });
    expect(invalid.statusCode).toBe(400);
    const reset = await app.inject({ method: 'POST', url: '/api/tablero/mock/call-rules/reset' });
    expect(reset.json().callRules.dj).toEqual({
      llamarSiDiasMayorA: 7,
      nivelesQueLlaman: ['CRITICO'],
    });
    expect(llamadasOriginadas()).toBe(0);
  });

  it('rechaza umbrales invalidos con 400', async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/call-rules',
      payload: { llamarSiPctMenorA: { 2: 500 } },
    });
    expect(r.statusCode).toBe(400);
  });

  it('encender el toggle de una seccion NO llama por si solo, ni enciende la otra', async () => {
    const { app, llamadasOriginadas } = await buildTestApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/auto-call',
      payload: { seccion: 'B_RIESGO_DJ', enabled: true },
    });
    expect(r.json().autoCallEnabled).toEqual({ A_RIESGO_CONEXION: false, B_RIESGO_DJ: true });
    expect(llamadasOriginadas()).toBe(0);
  });

  it('rechaza un toggle que no sea booleano', async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/tablero/mock/auto-call',
      payload: { seccion: 'A_RIESGO_CONEXION', enabled: 'si' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('exige la seccion y rechaza la que no puede llamar', async () => {
    // Sin seccion no se adivina: con dos interruptores, elegir por el operador es como se
    // termina llamando por el criterio equivocado. Y C no llama, asi que no tiene interruptor.
    const { app } = await buildTestApp();
    for (const payload of [
      { enabled: true },
      { seccion: 'C_RECTIFICACION', enabled: true },
      { seccion: 'otra', enabled: true },
    ]) {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/tablero/mock/auto-call',
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('seccion_invalida');
    }
  });
});

describe('GET /api/tablero/original', () => {
  it('cachea la lectura y `?refresh=1` la saltea', async () => {
    // Leer el dataset real tarda ~22s; sin cache, cada visita a la pestana lo repetia.
    process.env.TABLERO_API_BASE_URL = 'https://tablero.ejemplo.test';
    let lecturas = 0;
    const fetchSpy = vi.fn(async () => {
      lecturas++;
      return new Response(
        JSON.stringify({ items: [], total: 0, nextCursor: null, hasMore: false }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { app } = await buildTestApp();

    expect(
      (await app.inject({ method: 'GET', url: '/api/tablero/original' })).json().desdeCache,
    ).toBe(false);
    expect(lecturas).toBe(1);

    // Segunda visita: sale de cache, no vuelve a leer tablero-api.
    expect(
      (await app.inject({ method: 'GET', url: '/api/tablero/original' })).json().desdeCache,
    ).toBe(true);
    expect(lecturas).toBe(1);

    // El boton Recargar fuerza lectura fresca.
    expect(
      (await app.inject({ method: 'GET', url: '/api/tablero/original?refresh=1' })).json()
        .desdeCache,
    ).toBe(false);
    expect(lecturas).toBe(2);

    vi.unstubAllGlobals();
  });

  it('devuelve las TRES secciones del Semaforo, cada una con su escala, sin originar nada', async () => {
    // El reloj esta pineado en 2026-08-13. Las tres OCs estan armadas para caer una en cada
    // seccion y en ninguna otra: son criterios independientes, no un ranking.
    process.env.TABLERO_API_BASE_URL = 'https://tablero.ejemplo.test';

    const alumno = (over: Record<string, unknown>) => ({
      client_name: 'CLIENTE DE PRUEBA',
      course_name: 'CURSO DE PRUEBA',
      init_course: '2026-08-01',
      end_course: '2026-08-31',
      rut: '11111111-1',
      sence_connections: 0,
      dj: 0,
      order_status: '',
      student_email: '',
      first_name: 'A',
      last_name: 'B',
      updated_at: '2026-08-12T00:00:00.000Z',
      ...over,
    });

    const items = [
      // A - Riesgo Conexion: en operacion, semana 2, 0% conectado -> CRITICO (<55%).
      alumno({ client_id: 'cA', order_number: 'OC-A', order_status: 'CURSO EN OPERACIÓN' }),
      alumno({ client_id: 'cA', order_number: 'OC-A', order_status: 'CURSO EN OPERACIÓN' }),
      // B - Riesgo DJ: cerrado el 1 de agosto (13 dias > 7 -> CRITICO), 2 conectados y 1 DJ.
      alumno({
        client_id: 'cB',
        order_number: 'OC-B',
        end_course: '2026-08-01',
        sence_connections: 1,
        dj: 1,
      }),
      alumno({
        client_id: 'cB',
        order_number: 'OC-B',
        end_course: '2026-08-01',
        sence_connections: 1,
        dj: 0,
      }),
      // C - Rectificacion: esperando al OTIC desde el 10 de julio (35 dias > 30 -> CRITICO).
      // Sin conectados, asi que no entra ademas en la seccion B.
      alumno({
        client_id: 'cC',
        order_number: 'OC-C',
        order_status: 'ESPERA OC FINAL',
        otic: 'ALIANZA PYME',
        end_course: '2026-06-30',
        updated_at: '2026-07-10T00:00:00.000Z',
      }),
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ items, total: items.length, nextCursor: null, hasMore: false }),
            { status: 200 },
          ),
      ),
    );

    const { app, llamadasOriginadas, followupRepository } = await buildTestApp();
    const body = (await app.inject({ method: 'GET', url: '/api/tablero/original' })).json();

    expect(body.cursos).toHaveLength(1);
    expect(body.cursos[0]).toMatchObject({ orderNumber: 'OC-A', nivel: 'CRITICO', semana: 2 });

    // La escala de B son DIAS desde el cierre, no el porcentaje de DJ: 13 dias -> CRITICO
    // aunque la mitad de las DJ ya este.
    expect(body.riesgoDj).toHaveLength(1);
    expect(body.riesgoDj[0]).toMatchObject({
      orderNumber: 'OC-B',
      nivel: 'CRITICO',
      conDj: 1,
      conectados: 2,
      pendientes: 1,
      pctDj: 50,
    });

    expect(body.rectificacion).toHaveLength(1);
    expect(body.rectificacion[0]).toMatchObject({
      orderNumber: 'OC-C',
      nivel: 'CRITICO',
      otic: 'ALIANZA PYME',
      diasPendiente: 35,
    });

    // Solo lectura: leer las tres secciones no origina ni encola nada.
    expect(llamadasOriginadas()).toBe(0);
    expect(await followupRepository.listByEstados(['READY', 'DIALING'], 10)).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('sin TABLERO_API_BASE_URL responde 503 y no intenta nada', async () => {
    delete process.env.TABLERO_API_BASE_URL;
    const { app, llamadasOriginadas, followupRepository } = await buildTestApp();

    const r = await app.inject({ method: 'GET', url: '/api/tablero/original' });

    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('tablero_api_no_configurada');
    // Solo lectura: pase lo que pase, esta vista nunca crea nada.
    expect(llamadasOriginadas()).toBe(0);
    expect(await followupRepository.listByEstados(['READY', 'DIALING'], 10)).toHaveLength(0);
  });
});
