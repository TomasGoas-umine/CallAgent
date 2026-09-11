/**
 * webhook:selftest — verifica el circuito completo del webhook post-call SIN gastar un minuto
 * de llamada.
 *
 *   npm run webhook:selftest                          # sonda: tunel + firma + handler
 *   npm run webhook:selftest -- --local               # igual, pero contra localhost
 *   npm run webhook:selftest -- --conversation-id=X   # reproduce una conversacion REAL
 *
 * Por que existe: sin esto, la unica forma de saber si el webhook esta bien configurado es
 * hacer una llamada real y esperar. Eso cuesta minutos del plan Starter y, si algo esta mal
 * (URL vieja del tunel, secreto equivocado, server caido), no dice QUE esta mal.
 *
 * Modo sonda (default) — dos requests:
 *   1. Payload sintetico firmado con ELEVENLABS_WEBHOOK_SECRET -> se espera 200 con
 *      `ignored / unsupported_event`. El conversation_id es inventado a proposito: eso
 *      prueba alcance de red + parseo + firma valida, sin tocar ningun FOLLOWUP real.
 *   2. El MISMO payload con una firma invalida -> se espera 401. Sin este segundo chequeo, un
 *      endpoint que devuelve 200 a todo pasaria por bueno.
 *
 * Modo reproduccion (`--conversation-id`): lee la conversacion desde la API de ElevenLabs
 * (`GET /v1/convai/conversations/{id}`, solo lectura), la envuelve en la forma del webhook
 * `post_call_transcription`, la firma con nuestro propio secreto y la entrega al endpoint. Sirve
 * para recuperar el resultado de una llamada que ya ocurrio cuando el webhook todavia no estaba
 * configurado (el FOLLOWUP quedo en DIALING). Es idempotente: si esa conversacion ya se
 * proceso, el handler responde `already_processed` y no cambia nada.
 *
 * Nunca origina llamadas.
 */

import { randomUUID } from 'node:crypto';
import { generateTestSignatureHeader } from '../src/auth/elevenlabs-signature-validator.js';
import { ELEVENLABS_API_BASE } from '../src/services/elevenlabs-client.js';
import { env } from '../src/utils/env.js';
import type { ElevenLabsPostCallPayload } from '../src/domain/call.js';

const OK = '  \x1b[32mOK\x1b[0m  ';
const FALLA = '  \x1b[31mFALLA\x1b[0m';
const AVISO = '  \x1b[33mAVISO\x1b[0m';
const WEBHOOK_PATH = '/webhooks/elevenlabs/post-call';

let errores = 0;

function ok(msg: string) {
  console.log(`${OK} ${msg}`);
}
function falla(msg: string) {
  console.log(`${FALLA} ${msg}`);
  errores++;
}
function aviso(msg: string) {
  console.log(`${AVISO} ${msg}`);
}

interface Args {
  conversationId: string | null;
  baseUrl: string;
  origen: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valor = (nombre: string): string | null => {
    const flag = argv.find((a) => a.startsWith(`--${nombre}=`));
    return flag ? flag.slice(nombre.length + 3) : null;
  };
  const local = argv.includes('--local');
  const urlExplicita = valor('url');
  const localBase = `http://localhost:${env.localServerPort}`;

  let baseUrl: string;
  let origen: string;
  if (urlExplicita) {
    baseUrl = urlExplicita;
    origen = '--url';
  } else if (local || !env.publicBaseUrl) {
    baseUrl = localBase;
    origen = local ? '--local' : 'PUBLIC_BASE_URL vacia, se usa localhost';
  } else {
    baseUrl = env.publicBaseUrl;
    origen = 'PUBLIC_BASE_URL';
  }

  return { conversationId: valor('conversation-id'), baseUrl: baseUrl.replace(/\/$/, ''), origen };
}

/** Payload sintetico: conversation_id inventado, para no tocar ningun FOLLOWUP real. */
function payloadSintetico(): ElevenLabsPostCallPayload {
  return {
    type: 'webhook_probe',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: `conv_selftest_${randomUUID()}`,
      agent_id: env.elevenlabsAgentId || 'agent_selftest',
      status: 'done',
      transcript: [],
      metadata: { call_duration_secs: 0 },
      analysis: { transcript_summary: 'sonda de webhook:selftest, no es una llamada real' },
    },
  };
}

async function entregar(
  baseUrl: string,
  payload: unknown,
  opciones: { firmaValida: boolean },
): Promise<{ status: number; body: string }> {
  const rawBody = JSON.stringify(payload);
  const signature = opciones.firmaValida
    ? generateTestSignatureHeader(env.elevenlabsWebhookSecret, rawBody)
    : generateTestSignatureHeader('secreto-que-no-es-el-nuestro', rawBody);

  try {
    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
      body: rawBody,
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 400) };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

async function sonda(baseUrl: string): Promise<void> {
  console.log('\n== 1. Firma valida (se espera 200 + ignored/unsupported_event) ==');
  const valida = await entregar(baseUrl, payloadSintetico(), { firmaValida: true });
  if (valida.status === 0) {
    falla(
      `no se pudo alcanzar ${baseUrl}${WEBHOOK_PATH}: ${valida.body}\n` +
        '         Revisa que `npm run local:server` este arriba y que el tunel siga abierto.',
    );
    return;
  }
  if (valida.status === 401) {
    falla(
      'el endpoint rechazo la firma (401). ELEVENLABS_WEBHOOK_SECRET del .env no es el que ' +
        'esta usando el server: reinicia `npm run local:server` despues de cambiarlo.',
    );
  } else if (valida.status === 200 && valida.body.includes('unsupported_event')) {
    ok('el webhook llega, se parsea y la firma se valida correctamente');
  } else if (valida.status === 200) {
    aviso(`200 pero con un cuerpo inesperado: ${valida.body}`);
  } else {
    falla(`HTTP ${valida.status}: ${valida.body}`);
  }

  console.log('\n== 2. Firma invalida (se espera 401 — que el secreto se este exigiendo) ==');
  const invalida = await entregar(baseUrl, payloadSintetico(), { firmaValida: false });
  if (invalida.status === 401) {
    ok('una firma que no cuadra se rechaza con 401');
  } else if (invalida.status === 0) {
    falla(`no se pudo alcanzar el endpoint: ${invalida.body}`);
  } else {
    falla(
      `se esperaba 401 y llego HTTP ${invalida.status}. El endpoint esta aceptando webhooks sin ` +
        `validar la firma — cualquiera podria inventar resultados de llamada. Cuerpo: ${invalida.body}`,
    );
  }
}

interface ConversacionElevenLabs {
  conversation_id?: string;
  agent_id?: string;
  status?: string;
  transcript?: ElevenLabsPostCallPayload['data']['transcript'];
  metadata?: ElevenLabsPostCallPayload['data']['metadata'];
  analysis?: ElevenLabsPostCallPayload['data']['analysis'];
}

async function reproducir(baseUrl: string, conversationId: string): Promise<void> {
  console.log(`\n== Reproduciendo la conversacion real ${conversationId} ==`);
  if (!env.elevenlabsApiKey) {
    falla('sin ELEVENLABS_API_KEY no se puede leer la conversacion desde ElevenLabs');
    return;
  }

  const res = await fetch(`${ELEVENLABS_API_BASE}/conversations/${conversationId}`, {
    headers: { 'xi-api-key': env.elevenlabsApiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    falla(
      `GET /convai/conversations/${conversationId} devolvio HTTP ${res.status}: ${raw.slice(0, 300)}`,
    );
    return;
  }

  const conversacion = JSON.parse(raw) as ConversacionElevenLabs;
  if (conversacion.status !== 'done') {
    aviso(
      `la conversacion esta en estado "${conversacion.status}" — si no es "done", el analysis ` +
        'todavia puede estar incompleto y la clasificacion va a salir pobre.',
    );
  }
  ok(
    `leida: status=${conversacion.status}, ` +
      `${conversacion.transcript?.length ?? 0} turnos de transcripcion, ` +
      `analysis=${conversacion.analysis ? 'si' : 'no'}`,
  );

  // La forma del webhook es un sobre alrededor del MISMO objeto conversacion.
  const payload: ElevenLabsPostCallPayload = {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: conversacion.conversation_id ?? conversationId,
      agent_id: conversacion.agent_id ?? '',
      status: conversacion.status ?? 'done',
      transcript: conversacion.transcript ?? [],
      metadata: conversacion.metadata ?? {},
      analysis: conversacion.analysis ?? {},
    },
  };

  const entrega = await entregar(baseUrl, payload, { firmaValida: true });
  if (entrega.status === 200 && entrega.body.includes('unsupported_event')) {
    falla(
      'el endpoint no conoce este conversation_id: no existe el item CONVERSATION#<id> que lo ' +
        'liga a un FOLLOWUP. Pasa si la llamada se origino contra otra base de datos local ' +
        '(dynalite se reinicia vacio) o desde otro entorno.',
    );
  } else if (entrega.status === 200) {
    ok(`procesado: ${entrega.body}`);
  } else {
    falla(`HTTP ${entrega.status}: ${entrega.body}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log('== Umine Voice — selftest del webhook post-call ==');
  console.log('Este script NO origina ninguna llamada.');
  console.log(`\n  destino: ${args.baseUrl}${WEBHOOK_PATH}  (${args.origen})`);
  console.log(
    `  secreto: ELEVENLABS_WEBHOOK_SECRET ${
      env.elevenlabsWebhookSecret
        ? `seteado (${env.elevenlabsWebhookSecret.length} chars)`
        : 'VACIO'
    }`,
  );
  if (!env.elevenlabsWebhookSecret) {
    falla('ELEVENLABS_WEBHOOK_SECRET esta vacia: el handler no puede validar ninguna firma');
    process.exitCode = 1;
    return;
  }
  if (env.elevenlabsWebhookSecret === 'demo-local-secret')
    aviso(
      'El secreto sigue siendo un placeholder: la sonda valida el transporte, pero falta configurar el webhook real.',
    );
  if (args.baseUrl.startsWith('http://localhost')) {
    aviso(
      'estas probando contra localhost: esto valida el handler y el secreto, pero NO que ' +
        'ElevenLabs pueda alcanzarte. Para eso corre `npm run tunnel:up` y repite sin --local.',
    );
  }

  if (args.conversationId) {
    await reproducir(args.baseUrl, args.conversationId);
  } else {
    await sonda(args.baseUrl);
  }

  console.log('\n== Resumen ==');
  if (errores === 0) {
    console.log(
      '  Transporte y HMAC verificados. Esta sonda NO verifica registro, asignación o entregas de ElevenLabs: ejecuta npm run providers:check.',
    );
  } else {
    console.log(`  ${errores} problema(s). Resolvelos antes de gastar un minuto de llamada.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('El selftest fallo de forma inesperada:', err);
  process.exit(1);
});
