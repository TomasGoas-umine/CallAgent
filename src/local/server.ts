/**
 * Servidor local (Fastify) — expone los handlers Lambda como si fueran rutas de API Gateway
 * HTTP v2, para poder probar el flujo completo sin AWS real (prompt §10, punto 4).
 *
 * Los handlers en si (candidate-evaluator, call-dispatcher, webhooks) NO cambian: este
 * servidor solo adapta HTTP <-> las mismas funciones que correrian en Lambda.
 */

import Fastify from 'fastify';
import { registerHistoryRoutes } from './history-routes.js';
import { ConversationArchiveRepository } from '../repositories/conversation-archive-repository.js';
import type { FastifyReply } from 'fastify';
import { runCandidateEvaluator } from '../handlers/candidate-evaluator/handler.js';
import { dispatchFollowup } from '../handlers/call-dispatcher/handler.js';
import { handleElevenLabsPostCall } from '../handlers/webhooks/elevenlabs-post-call/handler.js';
import { handleTwilioStatus } from '../handlers/webhooks/twilio-status/handler.js';
import { FollowupRepository } from '../repositories/followup-repository.js';
import { registerApiRoutes } from './api-routes.js';
import { sharedLocalQueue } from '../services/queue.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../utils/responses.js';

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

// Content-type parsers que preservan el body crudo (necesario para validar firmas HMAC
// exactas — nunca validar contra el objeto ya re-serializado, ver auth/elevenlabs-signature-validator.ts).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  },
);

function send(reply: FastifyReply, result: ApiResponse) {
  reply.code(result.statusCode);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    reply.header(key, value);
  }
  reply.type('application/json').send(result.body);
}

// --- API de operacion del micrositio (ver src/local/api-routes.ts) ---
await app.register(registerApiRoutes);
await app.register(registerHistoryRoutes);
const conversationArchive = new ConversationArchiveRepository();

// --- candidate-evaluator (en AWS real: EventBridge cron; aca: POST manual o local:demo) ---
app.post('/internal/evaluator', async (_request, reply) => {
  const result = await runCandidateEvaluator();
  reply.code(200).send(result);
});

// --- call-dispatcher (en AWS real: consumidor de SQS; aca: drena la cola en memoria) ---
app.post('/internal/dispatcher/run-once', async (_request, reply) => {
  const message = await sharedLocalQueue.receive();
  if (!message) {
    reply.code(200).send({ status: 'empty' });
    return;
  }
  const result = await dispatchFollowup(message.followupId);
  reply.code(200).send(result);
});

app.post('/internal/dispatcher/drain', async (_request, reply) => {
  const results = [];
  let message = await sharedLocalQueue.receive();
  while (message) {
    results.push(await dispatchFollowup(message.followupId));
    message = await sharedLocalQueue.receive();
  }
  reply.code(200).send({ processed: results.length, results });
});

// --- webhooks ---
app.post('/webhooks/elevenlabs/post-call', async (request, reply) => {
  const rawBody = request.body as string;
  const signature = request.headers['elevenlabs-signature'] as string | undefined;
  const result = await handleElevenLabsPostCall(rawBody, signature, {
    archive: conversationArchive,
    agentId: env.elevenlabsAgentId,
  });
  send(reply, result);
});

app.post('/webhooks/twilio/status', async (request, reply) => {
  const params = request.body as Record<string, string>;
  const signature = request.headers['x-twilio-signature'] as string | undefined;
  const url = `http://localhost:${env.localServerPort}/webhooks/twilio/status`;
  const result = await handleTwilioStatus({ url, params, signatureHeader: signature });
  send(reply, result);
});

// --- utilidades de inspeccion para el demo/tests manuales ---
app.get('/internal/followups/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const repo = new FollowupRepository();
  const followup = await repo.getById(id);
  if (!followup) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  reply.code(200).send(followup);
});

app.get('/internal/queue/size', async (_request, reply) => {
  reply.code(200).send({ size: sharedLocalQueue.size() });
});

/** Health minimo historico (lo usa scripts/local-demo.ts). El completo es GET /api/health. */
app.get('/health', async (_request, reply) => {
  reply.code(200).send({ status: 'ok', mockProviders: env.mockProviders, dryRun: env.dryRun });
});

async function main() {
  try {
    await app.listen({ port: env.localServerPort, host: '0.0.0.0' });
    logger.info('local_server_started', { port: env.localServerPort });
  } catch (err) {
    logger.error('local_server_failed_to_start', { error: String(err) });
    process.exit(1);
  }
}

main();
