import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  ConversationArchiveRepository,
  type ConversationData,
} from '../../src/repositories/conversation-archive-repository.js';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { syncAgentHistory, historyStats } from '../../src/services/agent-history.js';
import { handleElevenLabsPostCall } from '../../src/handlers/webhooks/elevenlabs-post-call/handler.js';
import { generateTestSignatureHeader } from '../../src/auth/elevenlabs-signature-validator.js';
import { createWebhookGateway } from '../../src/local/webhook-gateway.js';
import { redactConversation } from '../../src/services/conversation-redaction.js';
import { esConversacionFinal } from '../../src/services/call-result-recorder.js';
import { registerHistoryRoutes } from '../../src/local/history-routes.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
let harness: DynamoServerHarness;
beforeAll(async () => {
  harness = await startDynamoServerHarness();
});
afterAll(async () => {
  await harness.stop();
});
async function repos() {
  const table = `history-${randomUUID()}`;
  await createTestTable(harness.client, table);
  return {
    archive: new ConversationArchiveRepository(table, harness.doc),
    followupRepository: new FollowupRepository(table, harness.doc),
  };
}
function data(id = 'conv_panel'): ConversationData {
  return {
    conversation_id: id,
    agent_id: 'agent_test',
    status: 'done',
    has_audio: true,
    metadata: { start_time_unix_secs: 1_780_000_000, call_duration_secs: 60, cost: 10 },
    analysis: { call_successful: 'success', transcript_summary: 'Prueba del panel' },
    transcript: [
      {
        role: 'agent',
        message: 'Hola',
        tool_calls: [{ id: 'tool_1' }],
        llm_usage: { tokens: 123 },
      },
    ],
  };
}
const secret = 'test-secret-history';
async function deliver(
  payload: unknown,
  deps: Awaited<ReturnType<typeof repos>>,
  signature?: string,
) {
  const raw = JSON.stringify(payload);
  return handleElevenLabsPostCall(raw, signature ?? generateTestSignatureHeader(secret, raw), {
    ...deps,
    webhookSecret: secret,
    agentId: 'agent_test',
  });
}
describe('historial completo del agente', () => {
  it('no interpreta estados desconocidos como resultados finales y oculta secretos en los registros servidos', () => {
    expect(esConversacionFinal(undefined)).toBe(false);
    expect(esConversacionFinal('unknown')).toBe(false);
    expect(esConversacionFinal('done')).toBe(true);
    expect(
      redactConversation({
        metadata: { phone_call: { external_number: '+56900001234' } },
        conversation_initiation_client_data: { dynamic_variables: { secret_token: 'sensitive' } },
        transcript: [{ message: 'Hola', llm_usage: { total_tokens: 123 } }],
      }),
    ).toEqual({
      metadata: { phone_call: { external_number: '***1234' } },
      conversation_initiation_client_data: { dynamic_variables: { secret_token: '[redacted]' } },
      transcript: [{ message: 'Hola', llm_usage: { total_tokens: 123 } }],
    });
  });
  it('guarda una conversación sin FOLLOWUP y conserva logs; duplicados no inflan las estadísticas', async () => {
    const deps = await repos();
    const payload = { type: 'post_call_transcription', event_timestamp: 1, data: data() };
    expect((await deliver(payload, deps)).body).toContain('archived');
    await deliver(payload, deps);
    const rows = await deps.archive.list('agent_test');
    expect(rows).toHaveLength(1);
    expect(historyStats(rows)).toMatchObject({
      total: 1,
      totalMinutes: 1,
      credits: 10,
      successRate: 1,
    });
    expect((await deps.archive.get('agent_test', 'conv_panel'))?.data.transcript).toEqual(
      data().transcript,
    );
    expect(await deps.followupRepository.findFollowupIdByConversation('conv_panel')).toBeNull();
  });
  it('rechaza firmas inválidas e ignora audio y otros agentes sin contaminar el historial', async () => {
    const deps = await repos();
    expect(
      (await deliver({ type: 'post_call_transcription', data: data() }, deps, 'invalid'))
        .statusCode,
    ).toBe(401);
    expect((await deliver({ type: 'post_call_audio', data: data() }, deps)).body).toContain(
      'unsupported_event',
    );
    expect(
      (
        await deliver(
          { type: 'post_call_transcription', data: { ...data(), agent_id: 'other' } },
          deps,
        )
      ).body,
    ).toContain('other_agent');
    expect(await deps.archive.list('agent_test')).toEqual([]);
  });
  it('archiva fallos de inicio sin fabricar una transcripción o evaluación', async () => {
    const deps = await repos();
    await deliver(
      {
        type: 'call_initiation_failure',
        event_timestamp: 123,
        data: {
          conversation_id: 'conv_fail',
          agent_id: 'agent_test',
          failure_reason: 'busy',
          metadata: { body: { CallStatus: 'busy' } },
        },
      },
      deps,
    );
    const detail = await deps.archive.get('agent_test', 'conv_fail');
    expect(detail?.summary).toMatchObject({ status: 'failed', success: 'unknown', credits: null });
    expect(detail?.data.failure_reason).toBe('busy');
  });
  it('permite que el webhook final complete una conversación activa importada; un webhook tardío conserva los logs ricos', async () => {
    const { archive } = await repos();
    await archive.save({ ...data(), status: 'in-progress', transcript: [] }, 'sync');
    await archive.save(data(), 'webhook');
    expect((await archive.get('agent_test', 'conv_panel'))?.summary.status).toBe('done');
    await archive.save(data(), 'sync');
    await archive.save({ ...data(), status: 'processing', transcript: [] }, 'webhook');
    const detail = await archive.get('agent_test', 'conv_panel');
    expect(detail?.summary.status).toBe('done');
    expect(detail?.data.transcript).toEqual(data().transcript);
  });
  it('recorre todas las páginas, incluye activas y reporta fallos parciales', async () => {
    const { archive } = await repos();
    const client = {
      listConversations: vi
        .fn()
        .mockResolvedValueOnce({
          conversations: [{ conversation_id: 'a' }],
          has_more: true,
          next_cursor: 'next',
        })
        .mockResolvedValueOnce({
          conversations: [{ conversation_id: 'b' }, { conversation_id: 'missing' }],
          has_more: false,
        }),
      getConversation: vi.fn(async (id: string) =>
        id === 'missing' ? null : { ...data(id), status: id === 'a' ? 'in-progress' : 'done' },
      ),
    };
    const result = await syncAgentHistory('agent_test', client, archive);
    expect(result).toMatchObject({ imported: 2, complete: false });
    expect(result.errors).toHaveLength(1);
    expect(client.listConversations).toHaveBeenLastCalledWith({
      agentId: 'agent_test',
      cursor: 'next',
      pageSize: 100,
    });
    expect(await archive.list('agent_test')).toHaveLength(2);
  });
  it('no mezcla agentes y detecta cursores repetidos', async () => {
    const { archive } = await repos();
    const client = {
      listConversations: vi.fn().mockResolvedValue({
        conversations: [{ conversation_id: 'a' }],
        has_more: true,
        next_cursor: 'same',
      }),
      getConversation: vi.fn().mockResolvedValue({ ...data(), agent_id: 'other' }),
    };
    await expect(syncAgentHistory('agent_test', client, archive)).rejects.toThrow(
      'Paginación incompleta',
    );
    expect(await archive.list('agent_test')).toEqual([]);
  });
  it('expone el historial y detalle local sin contaminarlo con otro agente', async () => {
    const { archive } = await repos();
    await archive.save(data(), 'sync');
    const app = Fastify();
    await registerHistoryRoutes(app, { archive, agentId: 'agent_test' });
    expect((await app.inject('/api/agent-history')).json().stats.total).toBe(1);
    expect((await app.inject('/api/agent-history/conv_panel')).json().data.transcript).toEqual(
      data().transcript,
    );
    expect((await app.inject('/api/agent-history/unknown')).statusCode).toBe(404);
    await app.close();
  });
});
describe('límite público del túnel', () => {
  it('expone solo el webhook, preserva body y firma exactos y propaga el resultado', async () => {
    const target = Fastify();
    target.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    const raw = '{ "hello":  "world" }';
    target.post('/webhooks/elevenlabs/post-call', async (req, reply) => {
      expect(req.body).toBe(raw);
      expect(req.headers['elevenlabs-signature']).toBe('exact');
      return reply.code(401).send({ error: 'invalid_signature' });
    });
    await target.listen({ port: 0, host: '127.0.0.1' });
    const gateway = createWebhookGateway(target.listeningOrigin);
    for (const path of [
      '/api/agent-history',
      '/api/calls',
      '/internal/dispatcher/drain',
      '/health',
    ]) {
      expect((await gateway.inject({ method: 'POST', url: path })).statusCode).toBe(404);
      expect((await gateway.inject(path)).statusCode).toBe(404);
    }
    const response = await gateway.inject({
      method: 'POST',
      url: '/webhooks/elevenlabs/post-call',
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': 'exact' },
      payload: raw,
    });
    expect(response.statusCode).toBe(401);
    await gateway.close();
    await target.close();
  });
});
