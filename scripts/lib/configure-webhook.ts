import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/utils/env.js';

export function writeEnvValues(values: Record<string, string>) {
  let content = readFileSync('.env', 'utf8');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_]+$/.test(key) || /[\r\n]/.test(value))
      throw new Error('Invalid environment value');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : `${content.trimEnd()}\n${line}\n`;
  }
  const temp = `.env.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, '.env');
}
interface Webhook {
  webhook_id: string;
  webhook_url: string;
  name: string;
  auth_type: string;
  is_disabled?: boolean;
  is_auto_disabled?: boolean;
}
interface Webhooks {
  post_call_webhook_id?: string | null;
  events?: string[];
  transcript_format?: string;
  send_audio?: boolean;
}
interface AgentConfig {
  conversation_config: unknown;
  workflow: unknown;
  platform_settings: { workspace_overrides?: { webhooks?: Webhooks } };
  version_id?: string;
}
export async function configureWebhook(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL debe usar HTTPS');
  if (!env.elevenlabsApiKey || !env.elevenlabsAgentId)
    throw new Error('Faltan ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID');
  const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.elevenlabs.io/v1${path}`, {
      method,
      headers: { 'xi-api-key': env.elevenlabsApiKey, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        detail?: { status?: string; message?: string };
      } | null;
      const permission =
        error?.detail?.status === 'missing_permissions' ? ` ${error.detail.message ?? ''}` : '';
      throw new Error(`ElevenLabs ${method} ${path}: HTTP ${response.status}.${permission}`);
    }
    return (await response.json()) as T;
  };
  const branch = process.env.ELEVENLABS_AGENT_BRANCH_ID;
  const agentPath = `/convai/agents/${encodeURIComponent(env.elevenlabsAgentId)}${branch ? `?branch_id=${encodeURIComponent(branch)}` : ''}`;
  const before = await api<AgentConfig>(agentPath);
  const backup = join(tmpdir(), `callagent-webhook-before-${randomUUID()}.json`);
  writeFileSync(backup, JSON.stringify(before, null, 2), { mode: 0o600 });
  const list = await api<{ webhooks: Webhook[] }>('/workspace/webhooks');
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhooks/elevenlabs/post-call`;
  let registered = list.webhooks.find(
    (w) =>
      w.webhook_id === process.env.ELEVENLABS_WEBHOOK_ID &&
      w.webhook_url === webhookUrl &&
      w.auth_type === 'hmac',
  );
  if (
    !registered ||
    !env.elevenlabsWebhookSecret ||
    env.elevenlabsWebhookSecret === 'demo-local-secret'
  ) {
    const created = await api<{ webhook_id: string; webhook_secret?: string }>(
      '/workspace/webhooks',
      'POST',
      {
        settings: {
          auth_type: 'hmac',
          name: `CallAgent local ${env.elevenlabsAgentId}`,
          webhook_url: webhookUrl,
        },
      },
    );
    if (!created.webhook_secret) throw new Error('ElevenLabs no devolvió el secreto HMAC');
    // Save the one-time secret immediately, before any other request can fail.
    writeEnvValues({
      PUBLIC_BASE_URL: baseUrl,
      ELEVENLABS_WEBHOOK_ID: created.webhook_id,
      ELEVENLABS_WEBHOOK_SECRET: created.webhook_secret,
    });
    registered = {
      webhook_id: created.webhook_id,
      webhook_url: webhookUrl,
      name: `CallAgent local ${env.elevenlabsAgentId}`,
      auth_type: 'hmac',
    };
  } else writeEnvValues({ PUBLIC_BASE_URL: baseUrl });
  await api(`/workspace/webhooks/${registered.webhook_id}`, 'PATCH', {
    is_disabled: false,
    name: registered.name,
    retry_enabled: true,
  });
  const webhooks: Webhooks = {
    post_call_webhook_id: registered.webhook_id,
    events: ['transcript', 'call_initiation_failure'],
    transcript_format: 'json',
    send_audio: false,
  };
  await api(agentPath, 'PATCH', { platform_settings: { workspace_overrides: { webhooks } } });
  const after = await api<AgentConfig>(agentPath);
  if (
    after.platform_settings.workspace_overrides?.webhooks?.post_call_webhook_id !==
      registered.webhook_id ||
    JSON.stringify(after.conversation_config) !== JSON.stringify(before.conversation_config) ||
    JSON.stringify(after.workflow) !== JSON.stringify(before.workflow)
  ) {
    throw new Error(`La verificación del agente requiere revisión. Respaldo privado: ${backup}`);
  }
  console.log(
    `Webhook HMAC configurado y verificado para ${env.elevenlabsAgentId}: ${registered.webhook_id}`,
  );
  console.log(
    'Eventos: transcripción JSON y fallo de inicio. Reintentos activados. Prompt y workflow conservados.',
  );
  console.log(
    'Secreto guardado en .env. Reinicia npm run local:server y ejecuta npm run webhook:selftest.',
  );
}
