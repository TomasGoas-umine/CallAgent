/** Lecturas y comparación del contrato; nunca origina llamadas ni modifica al agente. */
import { env } from '../src/utils/env.js';
import { ELEVENLABS_API_BASE } from '../src/services/elevenlabs-client.js';
import { buildAgentDynamicVariables } from '../src/services/agent-variables.js';
import { buildSenceAgentPatch } from './lib/sence-agent-config.js';
import { evaluateAllMockOrders } from '../src/services/mock-tablero-store.js';

function references(value: unknown): string[] {
  return [
    ...new Set([...JSON.stringify(value).matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]!)),
  ].sort();
}

async function main() {
  if (!env.elevenlabsApiKey || !env.elevenlabsAgentId)
    throw new Error('Falta ELEVENLABS_API_KEY o ELEVENLABS_AGENT_ID');
  const url = new URL(`${ELEVENLABS_API_BASE}/agents/${encodeURIComponent(env.elevenlabsAgentId)}`);
  if (env.elevenlabsAgentBranchId) url.searchParams.set('branch_id', env.elevenlabsAgentBranchId);
  const response = await fetch(url, {
    headers: { 'xi-api-key': env.elevenlabsApiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GET agente: HTTP ${response.status}`);
  const remote = (await response.json()) as ReturnType<typeof buildSenceAgentPatch> & {
    branch_id: string;
    version_id: string;
  };
  const local = buildSenceAgentPatch();
  const keys = Object.keys(
    buildAgentDynamicVariables({ clientName: '', courseName: '', orderNumber: '', motivo: '' }),
  ).sort();
  let errors = 0;
  function check(label: string, valid: boolean) {
    console.log(`${valid ? 'OK' : 'FALTA'} ${label}`);
    if (!valid) errors++;
  }
  console.log(
    `Agente ${env.elevenlabsAgentId}, rama ${remote.branch_id}, versión ${remote.version_id}`,
  );
  check(
    'Variables referenciadas coinciden con el backend',
    JSON.stringify(references(remote)) === JSON.stringify(keys),
  );
  check(
    'Placeholders declarados coinciden',
    JSON.stringify(
      Object.keys(
        remote.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders,
      ).sort(),
    ) === JSON.stringify(keys),
  );
  check(
    'Saludo coincide con la configuración versionada',
    remote.conversation_config.agent.first_message ===
      local.conversation_config.agent.first_message,
  );
  check(
    'Prompt general coincide',
    remote.conversation_config.agent.prompt.prompt ===
      local.conversation_config.agent.prompt.prompt,
  );
  check(
    'Instrucciones de todas las etapas coinciden',
    Object.entries(local.workflow.nodes).every(
      ([id, node]) =>
        remote.workflow.nodes[id]?.additional_prompt === node.additional_prompt &&
        JSON.stringify(remote.workflow.nodes[id]?.edge_order) === JSON.stringify(node.edge_order),
    ),
  );
  check(
    'Transiciones de ambos criterios coinciden',
    Object.entries(local.workflow.edges).every(([id, edge]) => {
      const actual = remote.workflow.edges[id];
      return (
        actual?.source === edge.source &&
        actual?.target === edge.target &&
        actual?.forward_condition.condition === edge.forward_condition.condition &&
        actual?.backward_condition?.condition === edge.backward_condition?.condition
      );
    }),
  );
  if (env.elevenlabsAgentBranchId)
    check('Rama seleccionada coincide', remote.branch_id === env.elevenlabsAgentBranchId);
  const cases = evaluateAllMockOrders();
  check(
    `Los ${cases.length} casos del mock producen las ${keys.length} variables sin plantillas pendientes`,
    cases.every(
      (c) =>
        JSON.stringify(Object.keys(c.variablesAgente).sort()) === JSON.stringify(keys) &&
        !references(c.variablesAgente).length,
    ),
  );
  console.table(
    cases.map((c) => ({
      oc: c.order.orderNumber,
      contacto: c.variablesAgente.nombre_interlocutor,
      dias: c.variablesAgente.dias_restantes,
      conexion: c.variablesAgente.pct_conexion,
      nivel: c.nivel,
      cumpleRegla: c.regla.dispara,
    })),
  );
  console.log(
    'Comprobación sin llamadas. Los casos son la siembra del mock; las ediciones de un servidor en ejecución se consultan en el tablero.',
  );
  process.exitCode = errors ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Error de comprobación');
  process.exitCode = 1;
});
