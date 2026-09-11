/**
 * Ciclo minimo REAL de punta a punta, con MOCK_PROVIDERS=true:
 *
 *   disparo manual -> call-dispatcher -> cliente ElevenLabs mockeado -> webhook post-call
 *   simulado (firma HMAC valida) -> el FOLLOWUP transiciona
 *
 * Es el test que respalda la restriccion central del proyecto: la unica forma de originar una
 * llamada es que un humano invoque el disparo manual. No hay cron, ni scheduler, ni poller, ni
 * reintento automatico en este camino — si este test pasa sin que nadie llame a
 * `originateManualCall`, algo esta disparando solo.
 *
 * Corre contra dynalite real (no mocks del SDK): las escrituras condicionales
 * (idempotencia, READY->DIALING, contador de cuota atomico) son justamente lo que se verifica.
 */

import { randomUUID } from 'node:crypto';
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

const ORIGINAL_ENV = { ...process.env };
let serverHarness: DynamoServerHarness;

// Grupo SINT-CRITICO-DEMO del fixture (ver test/fixtures/README.md).
const DEMO_PHONE = '+56900100141';
const DEMO_CLIENT_ID = 'client_test_demo';
const DEMO_ORDER_NUMBER = 'TEST-9600';

// Grupo SINT-NORMAL-S1 — deliberadamente NORMAL, para probar la revalidacion.
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
  process.env.DAILY_QUOTA = '5';
  process.env.BUSINESS_HOURS_START = '09:00';
  process.env.BUSINESS_HOURS_END = '19:00';
  process.env.TIMEZONE = 'America/Santiago';
  process.env.MAX_ATTEMPTS = '3';
  process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  // Solo se fakea Date: dynalite habla HTTP real y fakear setTimeout/setImmediate cuelga las
  // requests indefinidamente (ver CLAUDE.md).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

/** Cada test pide su propia tabla: idempotencia y cuota son justamente lo que se prueba. */
async function freshDeps() {
  const tableName = `manual-call-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    tableName,
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
    idempotencyRepository: new IdempotencyRepository(tableName, serverHarness.doc),
    quotaRepository: new QuotaRepository(tableName, serverHarness.doc),
    tableroClient: new FixtureTableroApiClient(undefined, [DEMO_PHONE]),
  };
}

async function freshManualCall() {
  vi.resetModules();
  return import('../../src/services/manual-call.js');
}

async function freshWebhook() {
  vi.resetModules();
  return import('../../src/handlers/webhooks/elevenlabs-post-call/handler.js');
}

/** Payload post-call de ElevenLabs con la forma real, firmado como lo firmaria el proveedor. */
function buildSignedWebhook(
  conversationId: string,
  overrides: {
    status?: string;
    dataCollection?: Record<string, { value: unknown }>;
    transcript?: Array<{ role: string; message: string }>;
  } = {},
) {
  const payload = {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: conversationId,
      agent_id: 'agent_test',
      status: overrides.status ?? 'done',
      call_successful: 'success',
      transcript: overrides.transcript ?? [
        { role: 'agent', message: 'Le llamo de Umine por el curso SENCE.' },
        { role: 'user', message: 'Listo, me conecto manana sin falta.' },
      ],
      metadata: { call_duration_secs: 42, call_sid: 'CA_test_manual' },
      analysis: {
        transcript_summary: 'La persona se compromete a conectarse manana.',
        data_collection_results: overrides.dataCollection ?? {
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
  return { rawBody, signature: generateTestSignatureHeader(WEBHOOK_SECRET, rawBody) };
}

describe('ciclo minimo: disparo manual -> dispatcher -> mock -> webhook -> transicion', () => {
  it('el camino completo deja el FOLLOWUP en RESUELTO y consume exactamente 1 de cuota', async () => {
    const deps = await freshDeps();
    const { originateManualCall } = await freshManualCall();

    const result = await originateManualCall(
      {
        clientId: DEMO_CLIENT_ID,
        orderNumber: DEMO_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
        requestedBy: 'test@umine.com',
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );

    expect(result.status).toBe('dialing');
    expect(result.conversationId).toBeTruthy();
    expect(result.cuota).toMatchObject({ usados: 1, limite: 5, restantes: 4 });
    expect(result.curso).toMatchObject({ nivel: 'CRITICO', orderNumber: DEMO_ORDER_NUMBER });

    // El dispatcher dejo el FOLLOWUP en DIALING con la escritura condicional READY->DIALING.
    const dialing = await deps.followupRepository.getById(result.followupId!);
    expect(dialing?.estado).toBe('DIALING');
    expect(dialing?.origen).toBe('manual');
    expect(dialing?.requestedBy).toBe('test@umine.com');

    // El mapeo CONVERSATION#<id> -> followupId es lo que permite correlacionar el webhook.
    const linked = await deps.followupRepository.findFollowupIdByConversation(
      result.conversationId!,
    );
    expect(linked).toBe(result.followupId);

    // --- Webhook post-call simulado, con firma valida ---
    const { rawBody, signature } = buildSignedWebhook(result.conversationId!);
    const { handleElevenLabsPostCall } = await freshWebhook();
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository: deps.followupRepository,
      contactRepository: deps.contactRepository,
      webhookSecret: WEBHOOK_SECRET,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'processed',
      followupId: result.followupId,
      outcome: 'resolved',
    });

    const final = await deps.followupRepository.getById(result.followupId!);
    expect(final?.estado).toBe('RESUELTO');

    // La llamada quedo registrada con su transcripcion, para poder mostrarla en el micrositio.
    const call = await deps.followupRepository.getCall(result.followupId!, result.conversationId!);
    expect(call?.outcome).toBe('resolved');
    expect(call?.durationSeconds).toBe(42);
    expect(call?.transcript?.length).toBe(2);
    expect(call?.transcriptSummary).toContain('compromete');

    // Y el contacto quedo marcado como contactado (base del cooldown del flujo automatico).
    const contact = await deps.contactRepository.getByPhone(DEMO_PHONE);
    expect(contact?.lastContactedAt).toBeTruthy();

    // La cuota no se movio con el webhook: solo la originacion consume.
    const cuota = await deps.quotaRepository.peek(5);
    expect(cuota.usados).toBe(1);
  });

  it('un resultado de "no contesta" reprograma el intento sin consumir cuota extra', async () => {
    const deps = await freshDeps();
    const { originateManualCall } = await freshManualCall();

    const result = await originateManualCall(
      {
        clientId: DEMO_CLIENT_ID,
        orderNumber: DEMO_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('no_answer') },
    );
    expect(result.status).toBe('dialing');

    const { rawBody, signature } = buildSignedWebhook(result.conversationId!, {
      status: 'no-answer',
    });
    const { handleElevenLabsPostCall } = await freshWebhook();
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository: deps.followupRepository,
      contactRepository: deps.contactRepository,
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(JSON.parse(response.body)).toMatchObject({ outcome: 'no_answer', isNotAnswered: true });

    // Vuelve a READY con un intento mas: queda LISTO para que un humano lo vuelva a disparar,
    // pero nada lo va a reintentar por si solo (no hay worker ni cron en este camino).
    const followup = await deps.followupRepository.getById(result.followupId!);
    expect(followup?.estado).toBe('READY');
    expect(followup?.intentos).toBe(1);

    expect((await deps.quotaRepository.peek(5)).usados).toBe(1);
  });

  it('la misma idempotency key dos veces origina UNA sola llamada', async () => {
    const deps = await freshDeps();
    const { originateManualCall } = await freshManualCall();
    const idempotencyKey = `test-${randomUUID()}`;
    const input = {
      clientId: DEMO_CLIENT_ID,
      orderNumber: DEMO_ORDER_NUMBER,
      phone: DEMO_PHONE,
      idempotencyKey,
    };

    let llamadasOriginadas = 0;
    const countingClient = {
      startOutboundCall: async (
        params: Parameters<MockElevenLabsClient['startOutboundCall']>[0],
      ) => {
        llamadasOriginadas++;
        return new MockElevenLabsClient('success').startOutboundCall(params);
      },
    };

    const first = await originateManualCall(input, { ...deps, elevenLabsClient: countingClient });
    const second = await originateManualCall(input, { ...deps, elevenLabsClient: countingClient });

    expect(first.status).toBe('dialing');
    expect(second.status).toBe('already_processed');
    expect(second.followupId).toBe(first.followupId);
    expect(llamadasOriginadas).toBe(1);
    expect((await deps.quotaRepository.peek(5)).usados).toBe(1);
  });

  it('revalida contra el Semaforo: un curso que no es CRITICO no se llama', async () => {
    const deps = await freshDeps();
    const { originateManualCall } = await freshManualCall();

    const result = await originateManualCall(
      {
        clientId: NORMAL_CLIENT_ID,
        orderNumber: NORMAL_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );

    expect(result.status).toBe('curso_no_critico');
    expect(result.followupId).toBeUndefined();
    expect((await deps.quotaRepository.peek(5)).usados).toBe(0);
  });

  it('un curso que ya no aparece en el Semaforo no se llama', async () => {
    const deps = await freshDeps();
    const { originateManualCall } = await freshManualCall();

    const result = await originateManualCall(
      {
        clientId: 'client_que_no_existe',
        orderNumber: 'OC-INEXISTENTE',
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );

    expect(result.status).toBe('curso_no_encontrado');
    expect((await deps.quotaRepository.peek(5)).usados).toBe(0);
  });

  it('respeta do_not_call aunque el disparo sea manual', async () => {
    const deps = await freshDeps();
    await deps.contactRepository.markDoNotCall(DEMO_PHONE);
    const { originateManualCall } = await freshManualCall();

    const result = await originateManualCall(
      {
        clientId: DEMO_CLIENT_ID,
        orderNumber: DEMO_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );

    expect(result.status).toBe('do_not_call');
    expect((await deps.quotaRepository.peek(5)).usados).toBe(0);
  });

  it('el contador de cuota es atomico y persistente (sobrevive al proceso)', async () => {
    const deps = await freshDeps();
    await deps.quotaRepository.setUsadosForTesting(4);

    const { originateManualCall } = await freshManualCall();
    const ok = await originateManualCall(
      {
        clientId: DEMO_CLIENT_ID,
        orderNumber: DEMO_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );
    expect(ok.status).toBe('dialing');
    expect(ok.cuota).toMatchObject({ usados: 5, restantes: 0 });

    const blocked = await originateManualCall(
      {
        clientId: DEMO_CLIENT_ID,
        orderNumber: DEMO_ORDER_NUMBER,
        phone: DEMO_PHONE,
        idempotencyKey: `test-${randomUUID()}`,
      },
      { ...deps, elevenLabsClient: new MockElevenLabsClient('success') },
    );
    expect(blocked.status).toBe('cuota_diaria_alcanzada');
    expect((await deps.quotaRepository.peek(5)).usados).toBe(5);
  });
});
