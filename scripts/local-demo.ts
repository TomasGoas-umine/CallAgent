/**
 * Demo end-to-end (prompt §10, punto 5) — la prueba de que el esqueleto funciona.
 *
 * Requiere que `npm run local:server` ya este corriendo (en otra terminal o en background)
 * con DYNAMODB_ENDPOINT apuntando a un DynamoDB local ya con tablas creadas
 * (`npm run local:create-tables`), y con las variables de entorno del demo activas:
 * DRY_RUN=false, KILL_SWITCH=false, ALLOWLIST_NUMBERS incluyendo el telefono demo,
 * RETRY_BACKOFF_SECONDS_OVERRIDE seteado (opcional).
 *
 * Flujo probado: dispara el evaluador -> verifica que se creo un FOLLOWUP -> simula el
 * dispatcher -> simula un webhook de ElevenLabs valido -> verifica que el estado final
 * quedo correctamente clasificado y persistido.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { env } from '../src/utils/env.js';
import { computeIdempotencyKey } from '../src/services/idempotency.js';
import { generateTestSignatureHeader } from '../src/auth/elevenlabs-signature-validator.js';

const BASE_URL = `http://localhost:${env.localServerPort}`;

// Representante del grupo SINT-CRITICO-DEMO del fixture (ver test/fixtures/README.md):
// disenado para quedarse en banda CRITICO durante varias semanas alrededor de la fecha de
// referencia del fixture, y para no chocar con ningun otro test/escenario del proyecto.
const DEMO_PHONE = '+56900100141';
const DEMO_ORDER_NUMBER = 'TEST-9600';
const DEMO_MOTIVO = 'riesgo_conexion_critico';

interface EvaluatorResponse {
  killSwitch: boolean;
  dryRun: boolean;
  created: Array<{
    followupId: string;
    destinatarioPhone: string;
    orderNumber: string;
    estado: string;
  }>;
  discarded: Array<{ orderNumber: string; motivo: string }>;
}

interface DispatchResult {
  followupId: string;
  outcome: string;
  conversationId?: string;
  callSid?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> HTTP ${response.status}: ${body}`);
  }
  return body ? (JSON.parse(body) as T) : ({} as T);
}

function step(n: number, message: string) {
  console.log(`\n${n}. ${message}`);
}

/**
 * Permite volver a correr el demo varias veces seguidas sin chocar con dos guardrails que,
 * en produccion, son exactamente el comportamiento deseado (deduplicacion semanal por
 * idempotency_key, y cooldown de 24h tras el ultimo contacto) pero que impedirian repetir el
 * demo en la misma sesion de desarrollo. Solo borra el estado del candidato demo especifico
 * (telefono +56900100141) — no toca ningun otro dato.
 */
async function resetDemoState(): Promise<void> {
  const key = computeIdempotencyKey({
    destinatario: DEMO_PHONE,
    motivo: DEMO_MOTIVO,
    orderNumber: DEMO_ORDER_NUMBER,
  });
  const ddb = new DynamoDBClient({
    region: env.awsRegion,
    endpoint: env.dynamodbEndpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(ddb);
  await doc.send(
    new DeleteCommand({ TableName: env.tableName, Key: { PK: `IDEMP#${key}`, SK: 'LOCK' } }),
  );
  await doc.send(
    new DeleteCommand({
      TableName: env.tableName,
      Key: { PK: `CONTACT#${DEMO_PHONE}`, SK: 'META' },
    }),
  );
}

async function main() {
  console.log('== Umine Voice — demo end-to-end local ==');
  console.log(`Server: ${BASE_URL}`);

  const health = await fetchJson<{ status: string; mockProviders: boolean; dryRun: boolean }>(
    `${BASE_URL}/health`,
  );
  console.log('Health check:', health);
  if (!health.mockProviders) {
    throw new Error(
      'MOCK_PROVIDERS=false — el demo NUNCA debe correr contra proveedores reales. Aborta.',
    );
  }

  step(
    1,
    'Reseteando el estado del candidato demo (idempotencia + cooldown) para poder re-correr el demo...',
  );
  await resetDemoState();
  console.log('   OK');

  step(2, 'Disparando candidate-evaluator (POST /internal/evaluator)...');
  const evalResult = await fetchJson<EvaluatorResponse>(`${BASE_URL}/internal/evaluator`, {
    method: 'POST',
  });
  if (evalResult.dryRun) {
    throw new Error(
      'DRY_RUN=true en el server — el demo necesita DRY_RUN=false para crear y encolar de verdad. ' +
        'Reinicia `npm run local:server` con DRY_RUN=false (ver CLAUDE.md).',
    );
  }
  const created = evalResult.created.find((c) => c.destinatarioPhone === DEMO_PHONE);
  if (!created) {
    console.error('Evaluator result:', JSON.stringify(evalResult, null, 2));
    throw new Error(`No se creo un FOLLOWUP para el candidato demo (${DEMO_PHONE}).`);
  }
  console.log(`   FOLLOWUP creado: ${created.followupId} (estado=${created.estado})`);

  step(3, 'Verificando que el FOLLOWUP quedo en estado READY...');
  const followupAfterEval = await fetchJson<{ estado: string }>(
    `${BASE_URL}/internal/followups/${created.followupId}`,
  );
  if (followupAfterEval.estado !== 'READY') {
    throw new Error(`Estado inesperado tras el evaluador: ${followupAfterEval.estado}`);
  }
  console.log('   OK, estado = READY');

  step(4, 'Simulando call-dispatcher (POST /internal/dispatcher/drain)...');
  const dispatchResponse = await fetchJson<{ processed: number; results: DispatchResult[] }>(
    `${BASE_URL}/internal/dispatcher/drain`,
    { method: 'POST' },
  );
  const dispatched = dispatchResponse.results.find((r) => r.followupId === created.followupId);
  if (!dispatched || dispatched.outcome !== 'dialing') {
    console.error('Dispatch result:', JSON.stringify(dispatchResponse, null, 2));
    throw new Error(
      `El dispatcher no dejo el followup en 'dialing': ${JSON.stringify(dispatched)}`,
    );
  }
  console.log(`   conversation_id=${dispatched.conversationId} callSid=${dispatched.callSid}`);

  step(5, 'Simulando webhook post-call de ElevenLabs (firma HMAC valida)...');
  const webhookSecret = env.elevenlabsWebhookSecret || 'demo-local-secret';
  const payload = {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: dispatched.conversationId,
      agent_id: 'agent_demo',
      status: 'done',
      call_successful: 'success',
      transcript: [{ role: 'user', message: 'Listo, me conecto manana sin falta.' }],
      metadata: { call_duration_secs: 45, call_sid: dispatched.callSid },
      analysis: {
        transcript_summary: 'El alumno se compromete a conectarse.',
        data_collection_results: {
          motivo_no_conexion: { value: 'olvido_conectarse' },
          tiene_bloqueo_tecnico: { value: false },
          compromiso_fecha: { value: '2026-08-20' },
          requiere_humano: { value: false },
          necesidad_capacitacion_futura: { value: '' },
        },
        evaluation_criteria_results: {
          obtuvo_compromiso: { result: 'success' },
        },
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const signature = generateTestSignatureHeader(webhookSecret, rawBody);
  const webhookResponse = await fetch(`${BASE_URL}/webhooks/elevenlabs/post-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
    body: rawBody,
  });
  const webhookBody = await webhookResponse.json();
  if (!webhookResponse.ok) {
    throw new Error(`Webhook fallo: HTTP ${webhookResponse.status} ${JSON.stringify(webhookBody)}`);
  }
  console.log('   respuesta del webhook:', webhookBody);

  step(6, 'Verificando el estado final del FOLLOWUP...');
  const finalFollowup = await fetchJson<{ estado: string; intentos: number }>(
    `${BASE_URL}/internal/followups/${created.followupId}`,
  );
  console.log(`   estado final: ${finalFollowup.estado}`);
  if (finalFollowup.estado !== 'RESUELTO') {
    throw new Error(`Estado final inesperado: ${finalFollowup.estado} (se esperaba RESUELTO)`);
  }

  console.log('\n== DEMO OK: flujo completo evaluator -> dispatcher -> webhook -> RESUELTO ==');
}

main().catch((err) => {
  console.error('\n== DEMO FALLIDO ==');
  console.error(err);
  process.exit(1);
});
