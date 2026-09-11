import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BaseRepository, ConditionalCheckFailedError } from './base-repository.js';

export interface AgentConversation {
  conversationId: string;
  agentId: string;
  status: string;
  startedAt: number | null;
  duration: number | null;
  credits: number | null;
  success: string;
  messages: number;
  channel: string;
  direction: string | null;
  summary: string;
  source: 'sync' | 'webhook';
  updatedAt: string;
  hasAudio: boolean;
}
export type ConversationData = Record<string, unknown> & {
  conversation_id: string;
  agent_id: string;
};
interface StoredConversation extends AgentConversation {
  PK: string;
  SK: string;
  revision: string;
  compressed: Uint8Array;
}
export interface ConversationArchive {
  save(data: ConversationData, source: 'sync' | 'webhook'): Promise<void>;
  list(agentId: string): Promise<AgentConversation[]>;
  get(
    agentId: string,
    id: string,
  ): Promise<{ summary: AgentConversation; data: ConversationData } | null>;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function summary(data: ConversationData, source: 'sync' | 'webhook'): AgentConversation {
  const metadata = object(data.metadata);
  const analysis = object(data.analysis);
  const phone = object(metadata.phone_call);
  return {
    conversationId: data.conversation_id,
    agentId: data.agent_id,
    status: typeof data.status === 'string' ? data.status : 'unknown',
    startedAt: numeric(metadata.start_time_unix_secs ?? data.start_time_unix_secs),
    duration: numeric(metadata.call_duration_secs ?? data.call_duration_secs),
    credits: numeric(metadata.cost),
    success: String(analysis.call_successful ?? data.call_successful ?? 'unknown'),
    messages: Array.isArray(data.transcript)
      ? data.transcript.length
      : Number(data.message_count ?? 0),
    channel: Object.keys(phone).length ? 'phone' : metadata.text_only === true ? 'text' : 'web',
    direction: typeof phone.direction === 'string' ? phone.direction : null,
    summary: String(analysis.transcript_summary ?? data.failure_reason ?? '').slice(0, 4000),
    source,
    updatedAt: new Date().toISOString(),
    hasAudio: data.has_audio === true,
  };
}
function publicSummary(item: StoredConversation): AgentConversation {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !['PK', 'SK', 'revision', 'compressed'].includes(key)),
  ) as unknown as AgentConversation;
}
/** Independent of FOLLOWUP: panel tests and failed initiations also belong in the agent history. */
export class ConversationArchiveRepository extends BaseRepository implements ConversationArchive {
  private key(agentId: string, id: string) {
    return { PK: `AGENT_CALLS#${agentId}`, SK: `CONVERSATION#${id}` };
  }
  async save(incoming: ConversationData, source: 'sync' | 'webhook'): Promise<void> {
    if (!incoming.agent_id || !incoming.conversation_id)
      throw new Error('Missing conversation identity');
    const key = this.key(incoming.agent_id, incoming.conversation_id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.getItem<StoredConversation>(key);
      const old: ConversationData | undefined = previous
        ? (JSON.parse(gunzipSync(previous.compressed).toString('utf8')) as ConversationData)
        : undefined;
      // A delayed webhook must not replace the richer API logs or revert a final conversation.
      const preferOld =
        old &&
        ((previous?.source === 'sync' &&
          source === 'webhook' &&
          ['done', 'failed'].includes(String(old.status))) ||
          (['done', 'failed'].includes(String(old.status)) &&
            !['done', 'failed'].includes(String(incoming.status))));
      const first = preferOld ? incoming : old;
      const last = preferOld ? old : incoming;
      const data = {
        ...first,
        ...last,
        metadata: { ...object(first?.metadata), ...object(last?.metadata) },
        analysis: { ...object(first?.analysis), ...object(last?.analysis) },
      } as ConversationData;
      const compressed = gzipSync(JSON.stringify(data));
      // Fail explicitly and let the sender retry; never acknowledge a silently truncated log.
      if (compressed.byteLength > 340_000)
        throw new Error('Conversation exceeds archive item limit');
      const item = {
        ...key,
        ...summary(data, preferOld ? previous!.source : source),
        revision: randomUUID(),
        compressed,
      };
      try {
        await this.putItemConditional(
          item,
          previous ? 'revision = :revision' : 'attribute_not_exists(PK)',
          previous ? { ':revision': previous.revision } : undefined,
        );
        return;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedError) || attempt === 4) throw error;
      }
    }
  }
  async list(agentId: string): Promise<AgentConversation[]> {
    const rows: AgentConversation[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `AGENT_CALLS#${agentId}` },
          ExclusiveStartKey: cursor,
          ProjectionExpression:
            'conversationId, agentId, #status, startedAt, #duration, credits, success, messages, channel, direction, summary, #source, updatedAt, hasAudio',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#source': 'source',
            '#duration': 'duration',
          },
        }),
      );
      rows.push(...((page.Items ?? []) as AgentConversation[]));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
  async get(agentId: string, id: string) {
    const item = await this.getItem<StoredConversation>(this.key(agentId, id));
    if (!item) return null;
    return {
      summary: publicSummary(item),
      data: JSON.parse(gunzipSync(item.compressed).toString('utf8')) as ConversationData,
    };
  }
}
