import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { QuotaRepository } from '../../src/repositories/quota-repository.js';
import { MockElevenLabsClient } from '../../src/services/elevenlabs-client.js';
import { FixtureTableroApiClient } from '../../src/services/tablero-api-client.fixture.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import { FIXTURE_REFERENCE_NOW } from '../fixtures/reference-time.js';
import type { Followup } from '../../src/domain/followup.js';

const ORIGINAL_ENV = { ...process.env };
let serverHarness: DynamoServerHarness;

// Grupo SINT-CRITICO-DEMO del fixture (ver test/fixtures/README.md) — se mantiene CRITICO de
// forma robusta durante varias semanas alrededor de FIXTURE_REFERENCE_NOW.
const DEMO_PHONE = '+56900100141';
const DEMO_CLIENT_ID = 'client_test_demo';
const DEMO_ORDER_NUMBER = 'TEST-9600';

// Grupo SINT-NORMAL-S1 — deliberadamente NORMAL, para probar la revalidacion.
const NORMAL_CLIENT_ID = 'client_test_normal_s1';
const NORMAL_ORDER_NUMBER = 'TEST-9104';

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});

afterAll(async () => {
  await serverHarness.stop();
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ALLOWLIST_NUMBERS = DEMO_PHONE;
  process.env.TEST_PHONE_WHITELIST = DEMO_PHONE;
  process.env.KILL_SWITCH = 'false';
  process.env.BUSINESS_HOURS_START = '09:00';
  process.env.BUSINESS_HOURS_END = '19:00';
  process.env.TIMEZONE = 'America/Santiago';
  process.env.MAX_ATTEMPTS = '3';
  process.env.RETRY_BACKOFF_SECONDS_OVERRIDE = '1';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

async function freshDispatcher() {
  vi.resetModules();
  return import('../../src/handlers/call-dispatcher/handler.js');
}

/**
 * Tabla propia por test. Se devuelven TODOS los repositorios que el dispatcher usa
 * (followups y cuota): si alguno no se inyecta, el dispatcher instancia el suyo contra
 * `env.tableName` + `DYNAMODB_ENDPOINT` reales y el test deja de estar aislado.
 */
async function freshRepos(): Promise<{
  followupRepository: FollowupRepository;
  quotaRepository: QuotaRepository;
}> {
  const tableName = `dispatcher-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    quotaRepository: new QuotaRepository(tableName, serverHarness.doc),
  };
}

function makeFollowup(overrides: Partial<Followup> = {}): Followup {
  const now = new Date().toISOString();
  return {
    followupId: randomUUID(),
    motivo: 'riesgo_conexion_critico',
    prioridad: 'ALTA',
    estado: 'READY',
    destinatarioId: DEMO_CLIENT_ID,
    destinatarioPhone: DEMO_PHONE,
    oc: DEMO_ORDER_NUMBER,
    curso: 'Curso Demo',
    intentos: 0,
    nextAttemptAt: now,
    idempotencyKey: `key-${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    contexto: {
      clientId: DEMO_CLIENT_ID,
      clientName: 'Cliente Demo',
      courseName: 'Curso Demo',
      orderNumber: DEMO_ORDER_NUMBER,
      initCourse: '2026-06-01',
      endCourse: '2026-09-01',
      nivelDetectado: 'CRITICO',
      seccion: 'A_RIESGO_CONEXION',
    },
    ...overrides,
  };
}

describe('call-dispatcher', () => {
  it('llama con exito (mock) y guarda conversation_id/callSid, deja el followup en DIALING', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    });

    expect(result.outcome).toBe('dialing');
    expect(result.conversationId).toBeDefined();
    expect(result.callSid).toBeDefined();

    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('DIALING');

    const linkedFollowupId = await followupRepository.findFollowupIdByConversation(
      result.conversationId!,
    );
    expect(linkedFollowupId).toBe(followup.followupId);
  });

  it('revalida contra el Semaforo: si ya no es CRITICO, cierra sin llamar', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup({
      contexto: {
        clientId: NORMAL_CLIENT_ID,
        clientName: 'Cliente Normal',
        courseName: 'Curso Normal',
        orderNumber: NORMAL_ORDER_NUMBER,
        initCourse: '2026-06-01',
        endCourse: '2026-09-01',
        nivelDetectado: 'CRITICO',
        seccion: 'A_RIESGO_CONEXION',
      },
    });
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    });

    expect(result.outcome).toBe('resuelto_sin_llamada');
    expect(result.motivo).toBe('ya_no_es_critico');
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('RESUELTO_SIN_LLAMADA');
  });

  it('revalida contra el Semaforo: si la OC ya no aparece, cierra sin llamar', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup({
      contexto: {
        clientId: 'client_no_existe',
        clientName: 'Cliente Fantasma',
        courseName: 'Curso Fantasma',
        orderNumber: 'OC-NO-EXISTE',
        initCourse: '2026-06-01',
        endCourse: '2026-09-01',
        nivelDetectado: 'CRITICO',
        seccion: 'A_RIESGO_CONEXION',
      },
    });
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    });

    expect(result.outcome).toBe('resuelto_sin_llamada');
    expect(result.motivo).toBe('oc_ya_no_aparece_en_semaforo');
  });

  it('kill switch activo bloquea la llamada', async () => {
    process.env.KILL_SWITCH = 'true';
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    });

    expect(result.outcome).toBe('bloqueado');
    expect(result.motivo).toBe('kill_switch');
  });

  it('numero fuera de la allowlist bloquea la llamada', async () => {
    process.env.ALLOWLIST_NUMBERS = '+56900000000'; // no incluye DEMO_PHONE
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    });

    expect(result.outcome).toBe('bloqueado');
    expect(result.motivo).toBe('no_en_allowlist');
  });

  it('fuera de la ventana horaria reagenda para la proxima ventana habil', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);

    // 03:00 Santiago (07:00 UTC) — fuera de 09:00-19:00.
    const outsideHours = new Date('2026-08-11T07:00:00.000Z');

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
      now: outsideHours,
    });

    expect(result.outcome).toBe('reagendado');
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('DIFERIDO');
    expect(stored?.nextAttemptAt).not.toBeNull();
  });

  it('anti doble disparo: un segundo dispatch sobre el mismo followup ya DIALING es obsoleto', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);

    const deps = {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('success'),
    };

    const first = await dispatchFollowup(followup.followupId, deps);
    const second = await dispatchFollowup(followup.followupId, deps);

    expect(first.outcome).toBe('dialing');
    expect(second.outcome).toBe('obsoleto');
  });

  it('error del proveedor reintenta hasta MAX_ATTEMPTS y luego marca AGOTADO', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();

    // intentos=2 (MAX_ATTEMPTS=3): este es el ultimo intento permitido.
    const followup = makeFollowup({ intentos: 2 });
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('error'),
    });

    expect(result.outcome).toBe('agotado');
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('AGOTADO');
    expect(stored?.intentos).toBe(3);
  });

  it('error del proveedor con intentos restantes programa reintento con backoff', async () => {
    const { dispatchFollowup } = await freshDispatcher();
    const { followupRepository, quotaRepository } = await freshRepos();
    const followup = makeFollowup({ intentos: 0 });
    await followupRepository.create(followup);

    const result = await dispatchFollowup(followup.followupId, {
      followupRepository,
      quotaRepository,
      tableroClient: new FixtureTableroApiClient(),
      elevenLabsClient: new MockElevenLabsClient('error'),
    });

    expect(result.outcome).toBe('error');
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('ERROR');
    expect(stored?.intentos).toBe(1);
    expect(stored?.nextAttemptAt).not.toBeNull();
  });
});
