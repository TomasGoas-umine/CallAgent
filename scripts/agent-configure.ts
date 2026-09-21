/** Actualiza solo la configuración conversacional versionada. Nunca origina llamadas. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { env } from '../src/utils/env.js';
import { ELEVENLABS_API_BASE } from '../src/services/elevenlabs-client.js';
import { buildSenceAgentPatch } from './lib/sence-agent-config.js';

// Preserva identidad de voz, modelo, turnos, webhooks y ajustes ajenos al patch.
function merge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge((base[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>)
        : value;
  }
  return result;
}

async function main() {
  if (!env.elevenlabsApiKey || !env.elevenlabsAgentId || !env.elevenlabsAgentBranchId)
    throw new Error('Se requieren API key, agente y rama explícita.');
  const url = new URL(`${ELEVENLABS_API_BASE}/agents/${env.elevenlabsAgentId}`);
  url.searchParams.set('branch_id', env.elevenlabsAgentBranchId);
  async function request(body?: unknown) {
    const response = await fetch(url, {
      method: body ? 'PATCH' : 'GET',
      headers: { 'xi-api-key': env.elevenlabsApiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Agente: HTTP ${response.status}`);
    return (await response.json()) as ReturnType<typeof buildSenceAgentPatch> & {
      version_id: string;
      branch_id: string;
    };
  }
  const before = await request();
  if (before.branch_id !== env.elevenlabsAgentBranchId) throw new Error('Rama inesperada');
  const local = buildSenceAgentPatch();
  const platform = merge(before.platform_settings, local.platform_settings);
  // La API reconstruye las referencias nativas desde data_collection/evaluation.
  delete platform.analysis_items;
  const patch = {
    conversation_config: merge(before.conversation_config, local.conversation_config),
    platform_settings: platform,
    workflow: local.workflow,
  };
  const backupDir = mkdtempSync(join(tmpdir(), 'umine-agent-'));
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(backupDir, 'before.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
  writeFileSync(join(backupDir, 'patch.json'), JSON.stringify(patch, null, 2), { mode: 0o600 });
  console.log(`Respaldo: ${backupDir}; versión: ${before.version_id}`);
  console.log(
    `Prompt general: ${before.conversation_config.agent.prompt.prompt.length} → ${local.conversation_config.agent.prompt.prompt.length} caracteres; nodos: ${Object.keys(local.workflow.nodes).length}`,
  );
  if (!process.argv.includes('--apply')) {
    console.log('Vista previa creada. --apply aplica esta configuración a la rama seleccionada.');
    return;
  }
  const current = await request();
  if (current.version_id !== before.version_id)
    throw new Error('La versión cambió; no se aplicó el patch');
  await request(patch);
  const verified = await request();
  writeFileSync(join(backupDir, 'verified.json'), JSON.stringify(verified, null, 2), {
    mode: 0o600,
  });
  if (
    verified.conversation_config.agent.first_message !==
      local.conversation_config.agent.first_message ||
    verified.conversation_config.tts?.speed !== local.conversation_config.tts.speed ||
    !isDeepStrictEqual(
      verified.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders,
      local.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders,
    ) ||
    !isDeepStrictEqual(
      verified.conversation_config.agent.prompt.prompt,
      local.conversation_config.agent.prompt.prompt,
    ) ||
    Object.entries(local.workflow.nodes).some(
      ([id, node]) => verified.workflow.nodes[id]?.additional_prompt !== node.additional_prompt,
    )
  )
    throw new Error('La configuración guardada difiere; revisar respaldo y versión remota');
  console.log(
    `Verificado: ${verified.version_id}. Ejecutar npm run agent:check para revisar el contrato.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Error de configuración');
  process.exitCode = 1;
});
