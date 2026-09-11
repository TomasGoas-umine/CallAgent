/**
 * Lectura centralizada de variables de entorno. Un solo lugar para defaults y parseo —
 * evita que cada handler reinvente su propio `process.env.X ?? 'default'`.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true';
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Los unicos telefonos autorizados a sonar en la etapa de pruebas de llamadas reales.
 *
 * Es el default de la whitelist DURA (`TEST_PHONE_WHITELIST`) y tambien la lista que el Tablero
 * Mock ofrece por OC — un solo literal para las dos cosas, para que el Mock no pueda ofrecer un
 * numero que el guardrail despues rechace.
 *
 * Sigue siendo un cerrojo de etapa, no configuracion de operacion: agregar un numero aca es una
 * decision explicita (ver CLAUDE.md, regla 0-bis).
 */
export const TELEFONOS_ETAPA_PRUEBAS = ['+56956194817', '+56955326503'] as const;

export const env = {
  nodeEnv: str('NODE_ENV', 'local'),
  awsRegion: str('AWS_REGION', 'us-east-1'),
  dynamodbEndpoint: str('DYNAMODB_ENDPOINT', 'http://localhost:8000'),
  tableName: str('TABLE_NAME', 'umine-voice-local'),

  tableroApiMode: str('TABLERO_API_MODE', 'fixture') as 'fixture' | 'http',
  tableroApiBaseUrl: str('TABLERO_API_BASE_URL', ''),
  tableroApiToken: str('TABLERO_API_TOKEN', ''),

  mockProviders: bool('MOCK_PROVIDERS', true),
  elevenlabsApiKey: str('ELEVENLABS_API_KEY', ''),
  elevenlabsAgentId: str('ELEVENLABS_AGENT_ID', ''),
  elevenlabsAgentBranchId: str('ELEVENLABS_AGENT_BRANCH_ID', ''),
  elevenlabsAgentPhoneNumberId: str('ELEVENLABS_AGENT_PHONE_NUMBER_ID', ''),
  elevenlabsWebhookSecret: str('ELEVENLABS_WEBHOOK_SECRET', ''),

  twilioAccountSid: str('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken: str('TWILIO_AUTH_TOKEN', ''),
  twilioPhoneNumber: str('TWILIO_PHONE_NUMBER', ''),

  /**
   * Grabacion de la llamada. Default `false` (ADR-006 / UV-026: el piloto asume que no se
   * graba). Se manda explicito en cada request a ElevenLabs.
   */
  callRecordingEnabled: bool('CALL_RECORDING_ENABLED', false),
  /**
   * URL publica base por la que ElevenLabs/Twilio pueden alcanzar los webhooks de este server
   * (ej. la de un tunel cloudflared/ngrok). Solo informativa: la usa `providers:check` para
   * decirte que URL registrar en el panel. Vacia = el webhook post-call no va a llegar y los
   * FOLLOWUP se quedan en DIALING.
   */
  publicBaseUrl: str('PUBLIC_BASE_URL', ''),

  killSwitch: bool('KILL_SWITCH', false),
  dryRun: bool('DRY_RUN', true),
  dailyQuota: num('DAILY_QUOTA', 5),
  businessHoursStart: str('BUSINESS_HOURS_START', '09:00'),
  businessHoursEnd: str('BUSINESS_HOURS_END', '19:00'),
  timezone: str('TIMEZONE', 'America/Santiago'),
  maxAttempts: num('MAX_ATTEMPTS', 3),
  cooldownHours: num('COOLDOWN_HOURS', 24),
  allowlistNumbers: str('ALLOWLIST_NUMBERS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Whitelist dura de la etapa de pruebas de llamadas reales. El default son los unicos numeros
   * autorizados a sonar; se sobreescribe solo en tests. Ver `services/guardrails.ts`.
   */
  testPhoneWhitelist: str('TEST_PHONE_WHITELIST', TELEFONOS_ETAPA_PRUEBAS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Enfriamiento entre disparos automaticos del Tablero Mock, POR OC. Es independiente del
   * `COOLDOWN_HOURS` de contacto: las OCs del Mock comparten un punado de telefonos, asi que un
   * cooldown por contacto bloquearia el tablero entero tras la primera llamada.
   */
  mockCallCooldownSeconds: num('MOCK_CALL_COOLDOWN_SECONDS', 300),

  retryBackoffSecondsOverride: process.env.RETRY_BACKOFF_SECONDS_OVERRIDE
    ? num('RETRY_BACKOFF_SECONDS_OVERRIDE', 0)
    : null,

  localServerPort: num('LOCAL_SERVER_PORT', 3000),
};

export type Env = typeof env;
