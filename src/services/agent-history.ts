import type {
  ConversationArchive,
  ConversationData,
  AgentConversation,
} from '../repositories/conversation-archive-repository.js';
import type { ConversationsClient } from './elevenlabs-conversations-client.js';

/** Read-only import, explicitly scoped to one agent. Does not originate calls or create OCs. */
export async function syncAgentHistory(
  agentId: string,
  client: ConversationsClient,
  archive: ConversationArchive,
) {
  if (!agentId) throw new Error('ELEVENLABS_AGENT_ID requerido');
  const result = {
    imported: 0,
    errors: [] as { conversationId: string; error: string }[],
    complete: false,
  };
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 500; page++) {
    const response = await client.listConversations({ agentId, cursor, pageSize: 100 });
    for (const row of response.conversations) {
      try {
        const detail = await client.getConversation(row.conversation_id);
        if (!detail) throw new Error('Conversación no disponible en ElevenLabs');
        if (detail.agent_id !== agentId) throw new Error('El detalle pertenece a otro agente');
        await archive.save(detail as unknown as ConversationData, 'sync');
        result.imported++;
      } catch {
        result.errors.push({
          conversationId: row.conversation_id,
          error: 'No se pudo recuperar o guardar el detalle; reintenta la sincronización.',
        });
      }
    }
    if (!response.has_more) {
      result.complete = result.errors.length === 0;
      return result;
    }
    if (!response.next_cursor || seen.has(response.next_cursor))
      throw new Error('Paginación incompleta de ElevenLabs; vuelve a sincronizar');
    cursor = response.next_cursor;
    seen.add(cursor);
  }
  throw new Error('Se alcanzó el límite de páginas; historial parcial');
}
export function historyStats(rows: AgentConversation[]) {
  const evaluated = rows.filter((row) => ['success', 'failure'].includes(row.success));
  const durations = rows.filter((row) => row.duration !== null);
  return {
    total: rows.length,
    completed: rows.filter((row) => row.status === 'done').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    evaluated: evaluated.length,
    successRate: evaluated.length
      ? evaluated.filter((row) => row.success === 'success').length / evaluated.length
      : null,
    totalMinutes: durations.reduce((sum, row) => sum + row.duration!, 0) / 60,
    averageSeconds: durations.length
      ? durations.reduce((sum, row) => sum + row.duration!, 0) / durations.length
      : null,
    credits: rows.reduce((sum, row) => sum + (row.credits ?? 0), 0),
    callsWithCost: rows.filter((row) => row.credits !== null).length,
  };
}
