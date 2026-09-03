/**
 * providers:check — valida la configuracion de ElevenLabs y Twilio SIN originar ninguna llamada.
 *
 *   npm run providers:check
 *
 * Existe porque el primer intento real es el mas caro de depurar: si falta el
 * `agent_phone_number_id`, o el numero no esta importado en ElevenLabs, o la API key no tiene
 * permisos, la API responde un 422/401 generico DESPUES de que el dispatcher ya consumio un slot
 * de cuota y dejo un FOLLOWUP colgado en DIALING. Este script hace solo lecturas (GET) y dice
 * exactamente que falta.
 *
 * Lo que NO hace: no llama a nadie, no crea nada, no modifica nada.
 */

import { env } from '../src/utils/env.js';
import { ELEVENLABS_API_BASE } from '../src/services/elevenlabs-client.js';
import { maskPhone } from '../src/utils/logger.js';

const OK = '  \x1b[32mOK\x1b[0m  ';
const FALTA = '  \x1b[31mFALTA\x1b[0m';
const AVISO = '  \x1b[33mAVISO\x1b[0m';

let errores = 0;
let avisos = 0;

function ok(msg: string) {
  console.log(`${OK} ${msg}`);
}
function falta(msg: string) {
  console.log(`${FALTA} ${msg}`);
  errores++;
}
function aviso(msg: string) {
  console.log(`${AVISO} ${msg}`);
  avisos++;
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: T | null; raw: string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const raw = await res.text();
    let body: T | null = null;
    try {
      body = raw ? (JSON.parse(raw) as T) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, raw };
  } catch (err) {
    return { status: 0, body: null, raw: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------

function chequearVariables(): void {
  console.log('\n== 1. Variables de entorno ==');

  const requeridas: Array<[string, string]> = [
    ['ELEVENLABS_API_KEY', env.elevenlabsApiKey],
    ['ELEVENLABS_AGENT_ID', env.elevenlabsAgentId],
    ['ELEVENLABS_AGENT_PHONE_NUMBER_ID', env.elevenlabsAgentPhoneNumberId],
    ['ELEVENLABS_WEBHOOK_SECRET', env.elevenlabsWebhookSecret],
  ];
  for (const [nombre, valor] of requeridas) {
    if (valor) ok(`${nombre} seteada (${valor.length} chars)`);
    else falta(`${nombre} esta vacia`);
  }

  // Twilio: el backend solo las usa para validar la firma del webhook de status. La llamada la
  // origina ElevenLabs con las credenciales que le diste al importar el numero.
  const twilio: Array<[string, string]> = [
    ['TWILIO_ACCOUNT_SID', env.twilioAccountSid],
    ['TWILIO_AUTH_TOKEN', env.twilioAuthToken],
  ];
  for (const [nombre, valor] of twilio) {
    if (valor) ok(`${nombre} seteada (${valor.length} chars)`);
    else
      aviso(
        `${nombre} vacia — solo hace falta para validar la firma del webhook de status de Twilio ` +
          '(opcional: la llamada la origina ElevenLabs, no este backend)',
      );
  }

  if (env.allowlistNumbers.length === 0) {
    falta('ALLOWLIST_NUMBERS vacia — con MOCK_PROVIDERS=false no se puede llamar a nadie');
  } else {
    ok(
      `ALLOWLIST_NUMBERS: ${env.allowlistNumbers.length} numero(s) autorizado(s) ` +
        `(${env.allowlistNumbers.map(maskPhone).join(', ')})`,
    );
    const malFormados = env.allowlistNumbers.filter((n) => !/^\+\d{8,15}$/.test(n));
    if (malFormados.length > 0) {
      falta(
        `estos numeros de la allowlist no estan en formato E.164 (+56...): ${malFormados
          .map(maskPhone)
          .join(', ')}`,
      );
    }
  }
}

function chequearGuardrails(): void {
  console.log('\n== 2. Guardrails (lo que te protege de gastar de mas) ==');

  if (env.mockProviders) {
    aviso(
      'MOCK_PROVIDERS=true — el disparador sigue simulando. Cambialo a false en .env cuando ' +
        'quieras llamar de verdad, y reinicia `npm run local:server`',
    );
  } else {
    aviso('MOCK_PROVIDERS=false — LAS LLAMADAS SON REALES y consumen minutos del plan');
  }

  if (env.killSwitch) aviso('KILL_SWITCH=true — ninguna llamada va a salir hasta que lo apagues');
  else ok('KILL_SWITCH=false');

  ok(`DAILY_QUOTA=${env.dailyQuota} llamadas originadas por dia`);
  ok(`MAX_ATTEMPTS=${env.maxAttempts}`);
  ok(`CALL_RECORDING_ENABLED=${env.callRecordingEnabled} (UV-026: el piloto asume false)`);

  const ventana = `${env.businessHoursStart}-${env.businessHoursEnd} ${env.timezone}`;
  if (env.businessHoursStart === '00:00' && env.businessHoursEnd === '23:59') {
    aviso(
      `ventana horaria ${ventana} — esta abierta 24h. Sirve para probar a cualquier hora, pero ` +
        'con llamadas REALES significa que se puede llamar a las 3am. Volvela a 09:00-19:00 ' +
        'antes de usar esto con alguien que no seas vos',
    );
  } else {
    ok(`ventana horaria ${ventana}`);
  }
}

interface AgentsResponse {
  agents?: Array<{ agent_id: string; name?: string }>;
}
interface PhoneNumber {
  phone_number_id: string;
  phone_number?: string;
  label?: string;
  provider?: string;
  assigned_agent?: { agent_id?: string; agent_name?: string } | null;
}
type PhoneNumbersResponse = PhoneNumber[];

async function chequearElevenLabs(): Promise<void> {
  console.log('\n== 3. ElevenLabs (solo lecturas, no origina ninguna llamada) ==');
  if (!env.elevenlabsApiKey) {
    falta('sin ELEVENLABS_API_KEY no se puede verificar nada de ElevenLabs');
    return;
  }
  const headers = { 'xi-api-key': env.elevenlabsApiKey };

  // --- Agentes ---
  const agentes = await getJson<AgentsResponse>(`${ELEVENLABS_API_BASE}/agents`, headers);
  if (agentes.status === 0) {
    falta(`no se pudo alcanzar la API de ElevenLabs: ${agentes.raw}`);
    return;
  }
  if (agentes.status === 401) {
    falta('ELEVENLABS_API_KEY rechazada (401). Revisa que sea la key correcta y este activa');
    return;
  }
  if (agentes.status !== 200) {
    falta(`GET /convai/agents devolvio HTTP ${agentes.status}: ${agentes.raw.slice(0, 200)}`);
    return;
  }

  const lista = agentes.body?.agents ?? [];
  ok(`API key valida. ${lista.length} agente(s) en la cuenta:`);
  for (const a of lista) {
    const marca = a.agent_id === env.elevenlabsAgentId ? ' <- el configurado' : '';
    console.log(`         ${a.agent_id}  ${a.name ?? '(sin nombre)'}${marca}`);
  }
  if (lista.length === 0) {
    falta('no hay ningun agente creado en la cuenta: crea uno en el panel de ElevenLabs');
  } else if (!env.elevenlabsAgentId) {
    falta('ELEVENLABS_AGENT_ID vacia: copia uno de los agent_id de arriba al .env');
  } else if (!lista.some((a) => a.agent_id === env.elevenlabsAgentId)) {
    falta(
      `ELEVENLABS_AGENT_ID no corresponde a ningun agente de esta cuenta ` +
        `(configurado: ${env.elevenlabsAgentId})`,
    );
  } else {
    ok('ELEVENLABS_AGENT_ID existe en la cuenta');
  }

  // --- Numeros de telefono importados ---
  const numeros = await getJson<PhoneNumbersResponse>(
    `${ELEVENLABS_API_BASE}/phone-numbers`,
    headers,
  );
  if (numeros.status !== 200) {
    falta(
      `GET /convai/phone-numbers devolvio HTTP ${numeros.status}: ${numeros.raw.slice(0, 200)}`,
    );
    return;
  }
  const nums = Array.isArray(numeros.body) ? numeros.body : [];
  ok(`${nums.length} numero(s) de telefono importado(s) en ElevenLabs:`);
  for (const n of nums) {
    const marca =
      n.phone_number_id === env.elevenlabsAgentPhoneNumberId ? ' <- el configurado' : '';
    const agente = n.assigned_agent?.agent_name ?? n.assigned_agent?.agent_id ?? 'sin agente';
    console.log(
      `         ${n.phone_number_id}  ${maskPhone(n.phone_number ?? '')}  ` +
        `${n.provider ?? '?'}  [${agente}]${marca}`,
    );
  }
  if (nums.length === 0) {
    falta(
      'no hay ningun numero importado en ElevenLabs. En el panel: Agents Platform -> Phone ' +
        'Numbers -> Import from Twilio (te va a pedir el Account SID y el Auth Token de Twilio)',
    );
  } else if (!env.elevenlabsAgentPhoneNumberId) {
    falta('ELEVENLABS_AGENT_PHONE_NUMBER_ID vacia: copia uno de los phone_number_id de arriba');
  } else if (!nums.some((n) => n.phone_number_id === env.elevenlabsAgentPhoneNumberId)) {
    falta(
      'ELEVENLABS_AGENT_PHONE_NUMBER_ID no corresponde a ningun numero importado ' +
        `(configurado: ${env.elevenlabsAgentPhoneNumberId})`,
    );
  } else {
    ok('ELEVENLABS_AGENT_PHONE_NUMBER_ID existe y esta importado');
  }
}

async function chequearTwilio(): Promise<void> {
  console.log('\n== 4. Twilio (solo lectura de la cuenta) ==');
  if (!env.twilioAccountSid || !env.twilioAuthToken) {
    aviso(
      'sin TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN no se puede verificar. No es bloqueante para ' +
        'llamar (ElevenLabs usa sus propias credenciales de Twilio, las que le diste al ' +
        'importar el numero), pero si lo es para validar la firma del webhook de status',
    );
    return;
  }
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString('base64');
  const res = await getJson<{ friendly_name?: string; status?: string; type?: string }>(
    `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}.json`,
    { authorization: `Basic ${auth}` },
  );
  if (res.status === 200) {
    ok(
      `credenciales de Twilio validas — cuenta "${res.body?.friendly_name ?? '?'}" ` +
        `(estado: ${res.body?.status ?? '?'}, tipo: ${res.body?.type ?? '?'})`,
    );
    if (res.body?.type === 'Trial') {
      aviso(
        'la cuenta de Twilio es Trial: solo puede llamar a numeros VERIFICADOS en Twilio. ' +
          'Verifica tus dos numeros en Twilio Console -> Phone Numbers -> Verified Caller IDs',
      );
    }
    await chequearGeoPermissions(auth);
  } else if (res.status === 401) {
    falta('Twilio rechazo las credenciales (401): revisa el Account SID y el Auth Token');
  } else {
    falta(`Twilio devolvio HTTP ${res.status}: ${res.raw.slice(0, 200)}`);
  }
}

/**
 * Geo Permissions de Twilio: por defecto Twilio BLOQUEA los destinos internacionales. Un numero
 * de EE.UU. llamando a un movil chileno falla con error 21215 si Chile no esta habilitado — y
 * ese fallo ocurre DESPUES de que el dispatcher consumio un slot de cuota. Se chequean los
 * paises de la allowlist, deducidos del prefijo.
 */
const PREFIJO_A_ISO: Array<[string, string]> = [
  ['+56', 'CL'],
  ['+54', 'AR'],
  ['+51', 'PE'],
  ['+57', 'CO'],
  ['+52', 'MX'],
  ['+34', 'ES'],
  ['+1', 'US'],
];

function isoDeNumero(numero: string): string | null {
  for (const [prefijo, iso] of PREFIJO_A_ISO) {
    if (numero.startsWith(prefijo)) return iso;
  }
  return null;
}

async function chequearGeoPermissions(auth: string): Promise<void> {
  const isos = [...new Set(env.allowlistNumbers.map(isoDeNumero).filter((x): x is string => !!x))];
  if (isos.length === 0) {
    aviso(
      'no se pudo deducir el pais de los numeros de la allowlist: revisa los Geo Permissions a mano',
    );
    return;
  }
  for (const iso of isos) {
    const res = await getJson<{
      name?: string;
      low_risk_numbers_enabled?: boolean;
      high_risk_special_numbers_enabled?: boolean;
    }>(`https://voice.twilio.com/v1/DialingPermissions/Countries/${iso}`, {
      authorization: `Basic ${auth}`,
    });
    if (res.status !== 200) {
      aviso(
        `no se pudo leer los Geo Permissions de ${iso} (HTTP ${res.status}). Revisalos a mano en ` +
          'Twilio Console -> Voice -> Settings -> Geographic Permissions',
      );
      continue;
    }
    if (res.body?.low_risk_numbers_enabled) {
      ok(`Twilio Geo Permissions: llamadas a ${res.body.name ?? iso} HABILITADAS`);
    } else {
      falta(
        `Twilio tiene BLOQUEADAS las llamadas a ${res.body?.name ?? iso}. Tu numero es de otro ` +
          'pais, asi que la llamada va a fallar con error 21215 despues de consumir cuota. ' +
          'Habilitalo en Twilio Console -> Voice -> Settings -> Geographic Permissions',
      );
    }
  }
}

function chequearWebhook(): void {
  console.log('\n== 5. Webhook post-call (sin esto no llega el resultado de la llamada) ==');
  if (!env.publicBaseUrl) {
    // DIFERIDO a proposito (UV-051): la fase actual es validar que la llamada suene y converse.
    // No es bloqueante para eso, asi que se reporta como aviso y no como FALTA.
    aviso(
      'PUBLIC_BASE_URL vacia — el webhook post-call NO esta configurado (diferido a proposito, ' +
        'UV-051). Consecuencia esperada: la llamada suena y conversa, pero el resultado nunca ' +
        'vuelve; el FOLLOWUP se queda en DIALING y el dashboard no muestra transcripcion ni ' +
        'clasificacion. Para cerrar el ciclo hace falta un tunel (ver README, "Llamadas reales")',
    );
    return;
  }
  if (!env.publicBaseUrl.startsWith('https://')) {
    falta(`PUBLIC_BASE_URL debe ser https:// (tiene: ${env.publicBaseUrl})`);
    return;
  }
  ok(`PUBLIC_BASE_URL = ${env.publicBaseUrl}`);
  console.log('\n  Registra estas URLs en los paneles:');
  console.log(
    `    ElevenLabs (Settings -> Webhooks, post-call):  ${env.publicBaseUrl}/webhooks/elevenlabs/post-call`,
  );
  console.log(
    `    Twilio (opcional, status callback):            ${env.publicBaseUrl}/webhooks/twilio/status`,
  );
  aviso(
    'el secreto que te muestra ElevenLabs al crear el webhook va en ELEVENLABS_WEBHOOK_SECRET ' +
      '(se muestra UNA sola vez)',
  );
}

async function main(): Promise<void> {
  console.log('== Umine Voice — chequeo de proveedores ==');
  console.log('Este script NO origina ninguna llamada: solo hace lecturas.');

  chequearVariables();
  chequearGuardrails();
  await chequearElevenLabs();
  await chequearTwilio();
  chequearWebhook();

  console.log('\n== Resumen ==');
  if (errores === 0) {
    console.log(`  Sin bloqueantes. ${avisos} aviso(s) para revisar.`);
    if (env.mockProviders) {
      console.log('  Siguiente paso: MOCK_PROVIDERS=false en .env + reiniciar local:server.');
    } else {
      console.log('  Todo listo para llamar de verdad. La primera llamada, a tu propio numero.');
    }
  } else {
    console.log(`  ${errores} bloqueante(s) y ${avisos} aviso(s). Resolve los FALTA de arriba.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nEl chequeo fallo de forma inesperada:', err);
  process.exit(1);
});
