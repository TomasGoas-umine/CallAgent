import { redactConversation } from '../services/conversation-redaction.js';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  ConversationArchiveRepository,
  type ConversationArchive,
} from '../repositories/conversation-archive-repository.js';
import {
  RealConversationsClient,
  type ConversationsClient,
} from '../services/elevenlabs-conversations-client.js';
import { historyStats, syncAgentHistory } from '../services/agent-history.js';
import { env } from '../utils/env.js';

export async function registerHistoryRoutes(
  app: FastifyInstance,
  deps: {
    archive?: ConversationArchive;
    client?: ConversationsClient;
    agentId?: string;
  } = {},
) {
  const archive = deps.archive ?? new ConversationArchiveRepository();
  const agentId = deps.agentId ?? env.elevenlabsAgentId;
  let syncing = false;
  app.get('/api/agent-history', async () => {
    const conversations = agentId ? await archive.list(agentId) : [];
    return { agentId, conversations, stats: historyStats(conversations) };
  });
  app.post('/api/agent-history/sync', async (_request, reply) => {
    if (!agentId || (!deps.client && !env.elevenlabsApiKey))
      return reply.code(503).send({ error: 'Configura ELEVENLABS_AGENT_ID y ELEVENLABS_API_KEY' });
    if (syncing) return reply.code(409).send({ error: 'Ya hay una sincronización en curso' });
    syncing = true;
    try {
      return await syncAgentHistory(
        agentId,
        deps.client ?? new RealConversationsClient(env.elevenlabsApiKey),
        archive,
      );
    } catch {
      return reply.code(502).send({
        error: 'Sincronización incompleta. Lo ya importado está guardado; vuelve a intentarlo.',
      });
    } finally {
      syncing = false;
    }
  });
  app.get<{ Params: { id: string } }>('/api/agent-history/:id', async (request, reply) => {
    const detail = await archive.get(agentId, request.params.id);
    if (!detail)
      return reply.code(404).send({ error: 'Conversación no encontrada en el historial local' });
    reply.header('Cache-Control', 'no-store');
    return { ...detail, data: redactConversation(detail.data) };
  });
  app.get<{ Params: { id: string } }>('/api/agent-history/:id/audio', async (request, reply) => {
    const detail = await archive.get(agentId, request.params.id);
    if (!detail?.summary.hasAudio)
      return reply
        .code(404)
        .send({ error: 'ElevenLabs no tiene audio disponible para esta conversación' });
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(request.params.id)}/audio`,
      {
        headers: { 'xi-api-key': env.elevenlabsApiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok || !response.body)
      return reply.code(502).send({ error: 'No se pudo recuperar el audio de ElevenLabs' });
    reply
      .header('Cache-Control', 'no-store')
      .type(response.headers.get('content-type') ?? 'audio/mpeg');
    return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  });
}
