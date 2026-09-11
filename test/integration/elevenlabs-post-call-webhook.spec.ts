import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleElevenLabsPostCall } from '../../src/handlers/webhooks/elevenlabs-post-call/handler.js';
import { generateTestSignatureHeader } from '../../src/auth/elevenlabs-signature-validator.js';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import samplePayload from '../fixtures/elevenlabs_post_call_payload.sample.json' with { type: 'json' };
import type { Followup } from '../../src/domain/followup.js';
import type { ElevenLabsPostCallPayload } from '../../src/domain/call.js';

const SECRET = 'test-webhook-secret';
let serverHarness: DynamoServerHarness;

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});

afterAll(async () => {
  await serverHarness.stop();
});

async function freshRepos() {
  const tableName = `webhook-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
  };
}

function makeFollowup(overrides: Partial<Followup> = {}): Followup {
  const now = new Date().toISOString();
  return {
    followupId: randomUUID(),
    motivo: 'riesgo_conexion_critico',
    prioridad: 'ALTA',
    estado: 'DIALING',
    destinatarioId: 'client_x',
    destinatarioPhone: '+56900000001',
    oc: '100',
    curso: 'Curso X',
    intentos: 0,
    nextAttemptAt: null,
    idempotencyKey: `key-${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    contexto: {
      clientId: 'client_x',
      clientName: 'Cliente X',
      courseName: 'Curso X',
      orderNumber: '100',
      initCourse: '2026-06-01',
      endCourse: '2026-09-01',
      nivelDetectado: 'CRITICO',
      seccion: 'A_RIESGO_CONEXION',
    },
    ...overrides,
  };
}

function payloadWithConversation(
  conversationId: string,
  overrides: Partial<ElevenLabsPostCallPayload['data']> = {},
) {
  const base = structuredClone(samplePayload) as ElevenLabsPostCallPayload;
  base.data = { ...base.data, conversation_id: conversationId, ...overrides };
  return base;
}

describe('webhooks/elevenlabs-post-call', () => {
  it('conserva la revisión humana y bloquea contacto si también pidió no volver a llamar', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);
    const conversationId = 'conv-humano-y-no-contactar';
    await followupRepository.linkConversation(conversationId, followup.followupId);
    const rawBody = JSON.stringify(
      payloadWithConversation(conversationId, {
        analysis: {
          data_collection_results: {
            requiere_humano: { value: true },
            motivo_no_conexion: { value: 'no_contactar' },
          },
        },
      }),
    );
    const response = await handleElevenLabsPostCall(
      rawBody,
      generateTestSignatureHeader(SECRET, rawBody),
      { followupRepository, contactRepository, webhookSecret: SECRET },
    );
    expect(response.statusCode).toBe(200);
    expect((await followupRepository.getById(followup.followupId))?.estado).toBe('ESCALADO');
    expect((await contactRepository.getByPhone(followup.destinatarioPhone))?.doNotCall).toBe(true);
  });

  it('rechaza con 401 si la firma es invalida', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const rawBody = JSON.stringify(payloadWithConversation('conv-x'));
    const response = await handleElevenLabsPostCall(rawBody, 'firma-invalida', {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rechaza con 401 si el timestamp esta fuera de tolerancia (30 min)', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const rawBody = JSON.stringify(payloadWithConversation('conv-x'));
    const oldTimestamp = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // hace 1h
    const signature = generateTestSignatureHeader(SECRET, rawBody, oldTimestamp);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });
    expect(response.statusCode).toBe(401);
  });

  it('llamada resuelta (compromiso_fecha, sin bloqueo tecnico) marca el followup como RESUELTO y actualiza CONTACT', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup({ destinatarioPhone: '+56911112222' });
    await followupRepository.create(followup);
    const conversationId = 'conv-resuelto-1';
    await followupRepository.linkConversation(conversationId, followup.followupId);

    // El sample trae tiene_bloqueo_tecnico=true, que en la taxonomia precede a "resolved"
    // (ver call-outcome-classifier.ts) — se limpia aca para aislar el caso "resuelto por
    // compromiso de fecha, sin bloqueo tecnico".
    const payload = payloadWithConversation(conversationId, {
      analysis: {
        data_collection_results: {
          compromiso_fecha: { value: '2026-08-20' },
          tiene_bloqueo_tecnico: { value: false },
        },
      },
    });
    const rawBody = JSON.stringify(payload);
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });

    expect(response.statusCode).toBe(200);
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('RESUELTO');
    const contact = await contactRepository.getByPhone('+56911112222');
    expect(contact?.lastContactedAt).not.toBeNull();
  });

  it('requiere_humano=true escala y bloquea reintentos automaticos', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);
    const conversationId = 'conv-escalation-1';
    await followupRepository.linkConversation(conversationId, followup.followupId);

    const payload = payloadWithConversation(conversationId, {
      analysis: {
        data_collection_results: {
          requiere_humano: { value: true },
        },
      },
    });
    const rawBody = JSON.stringify(payload);
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.outcome).toBe('human_escalation');
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('ESCALADO');
  });

  it('no contesta (no-answer) reprograma reintento sin agotar intentos', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup({ intentos: 0 });
    await followupRepository.create(followup);
    const conversationId = 'conv-no-answer-1';
    await followupRepository.linkConversation(conversationId, followup.followupId);

    const payload = payloadWithConversation(conversationId, {
      status: 'no-answer',
      analysis: { data_collection_results: {}, evaluation_criteria_results: {} },
    });
    const rawBody = JSON.stringify(payload);
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });

    expect(response.statusCode).toBe(200);
    const stored = await followupRepository.getById(followup.followupId);
    expect(stored?.estado).toBe('READY'); // vuelve a READY para que flujo-2 reintente
    expect(stored?.intentos).toBe(1);
    expect(stored?.nextAttemptAt).not.toBeNull();
  });

  it('webhook duplicado (mismo conversation_id) no procesa dos veces (idempotencia)', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);
    const conversationId = 'conv-duplicado-1';
    await followupRepository.linkConversation(conversationId, followup.followupId);

    const rawBody = JSON.stringify(payloadWithConversation(conversationId));
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const deps = { followupRepository, contactRepository, webhookSecret: SECRET };

    const first = await handleElevenLabsPostCall(rawBody, signature, deps);
    const stateAfterFirst = await followupRepository.getById(followup.followupId);

    const second = await handleElevenLabsPostCall(rawBody, signature, deps);
    const stateAfterSecond = await followupRepository.getById(followup.followupId);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).status).toBe('already_processed');
    // El estado no debe haber cambiado entre el primer y segundo procesamiento.
    expect(stateAfterSecond?.updatedAt).toBe(stateAfterFirst?.updatedAt);
  });

  it('conversation_id desconocido responde 200 sin fallar (evita el auto-disable de ElevenLabs)', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const rawBody = JSON.stringify(payloadWithConversation('conv-desconocido'));
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe('ignored');
  });

  it('payload invalido (JSON malformado) responde 400', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const rawBody = '{ esto no es json valido';
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });
    expect(response.statusCode).toBe(400);
  });

  it('toma el call_sid de metadata.phone_call y el inicio de start_time_unix_secs (forma real del webhook)', async () => {
    const { followupRepository, contactRepository } = await freshRepos();
    const followup = makeFollowup();
    await followupRepository.create(followup);
    const conversationId = 'conv-forma-real-1';
    await followupRepository.linkConversation(conversationId, followup.followupId);

    // El webhook REAL de ElevenLabs no manda `metadata.call_sid` plano (eso es la forma del
    // fixture/mock): para una llamada telefonica el SID de Twilio viaja en
    // `metadata.phone_call.call_sid`, y el inicio en `start_time_unix_secs`. Antes de leer
    // ambos, toda llamada real quedaba registrada con callSid y startedAt en null.
    const startTimeUnix = 1_757_000_000;
    const payload = payloadWithConversation(conversationId, {
      metadata: {
        call_duration_secs: 42,
        start_time_unix_secs: startTimeUnix,
        termination_reason: '',
        phone_call: {
          type: 'twilio',
          call_sid: 'CAreal0001',
          external_number: '+56900100141',
          direction: 'outbound',
        },
      },
    });
    const rawBody = JSON.stringify(payload);
    const signature = generateTestSignatureHeader(SECRET, rawBody);
    const response = await handleElevenLabsPostCall(rawBody, signature, {
      followupRepository,
      contactRepository,
      webhookSecret: SECRET,
    });

    expect(response.statusCode).toBe(200);
    const call = await followupRepository.getCall(followup.followupId, conversationId);
    expect(call?.callSid).toBe('CAreal0001');
    expect(call?.startedAt).toBe(new Date(startTimeUnix * 1000).toISOString());
    expect(call?.durationSeconds).toBe(42);
  });
});
