import { createWebhookGateway } from '../src/local/webhook-gateway.js';
import { configureWebhook } from './lib/configure-webhook.js';
/**
 * Exposes only the signed post-call webhook through a Cloudflare quick tunnel.
 * npm run webhook:connect also registers it with ElevenLabs and saves the one-time secret.
 * Quick-tunnel URLs change at every restart; restart the local server after configuration.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from '../src/utils/env.js';

const ENV_FILE = '.env';
const PORT = env.localServerPort;
const SERVER_TARGET = `http://127.0.0.1:${PORT}`;
const GATEWAY_PORT = Number(process.env.WEBHOOK_GATEWAY_PORT ?? 3001);
const LOCAL_TARGET = `http://127.0.0.1:${GATEWAY_PORT}`;
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const amarillo = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Escribe (o reemplaza) PUBLIC_BASE_URL en el .env sin tocar el resto del archivo. */
function guardarEnEnv(url: string): void {
  if (!existsSync(ENV_FILE)) {
    console.log(amarillo(`  No hay ${ENV_FILE}: copia .env.example y vuelve a correr esto.`));
    return;
  }
  const contenido = readFileSync(ENV_FILE, 'utf8');
  const linea = `PUBLIC_BASE_URL=${url}`;
  const actualizado = /^PUBLIC_BASE_URL=.*$/m.test(contenido)
    ? contenido.replace(/^PUBLIC_BASE_URL=.*$/m, linea)
    : `${contenido.replace(/\n*$/, '\n')}${linea}\n`;
  writeFileSync(ENV_FILE, actualizado);
  console.log(`  ${ENV_FILE} actualizado: PUBLIC_BASE_URL=${url}`);
}

async function avisarSiElServerNoEstaArriba(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_TARGET}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`  El server local responde en ${SERVER_TARGET}`);
      return;
    }
    console.log(amarillo(`  ${LOCAL_TARGET}/health devolvio HTTP ${res.status}`));
  } catch {
    console.log(
      amarillo(
        `  AVISO: nada escuchando en ${LOCAL_TARGET} — el tunel va a quedar apuntando al vacio.\n` +
          '         Levanta `npm run local:server` en otra terminal (el tunel no hace falta reiniciarlo).',
      ),
    );
  }
}

async function instrucciones(url: string): Promise<void> {
  guardarEnEnv(url);
  console.log(`\n${bold('Túnel activo: solo recibe POST /webhooks/elevenlabs/post-call')}`);
  console.log(`${url} -> ${LOCAL_TARGET} -> ${SERVER_TARGET}`);
  if (process.argv.includes('--configure')) await configureWebhook(url);
  else
    console.log(
      'Ejecuta npm run webhook:configure para registrar y asignar este webhook en ElevenLabs.',
    );
  console.log(
    'Mantén este proceso abierto. Cada reinicio cambia la URL; vuelve a configurar el webhook.',
  );
}

async function main(): Promise<void> {
  console.log('== Umine Voice — tunel publico para el webhook post-call ==');
  const gateway = createWebhookGateway(SERVER_TARGET);
  await gateway.listen({ port: GATEWAY_PORT, host: '127.0.0.1' });
  await avisarSiElServerNoEstaArriba();
  console.log(dim(`\n  cloudflared tunnel --url ${LOCAL_TARGET}\n`));

  const hijo = spawn('cloudflared', ['tunnel', '--url', LOCAL_TARGET], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlEncontrada: string | null = null;
  const mirar = (chunk: Buffer): void => {
    const texto = chunk.toString();
    for (const linea of texto.split('\n')) {
      if (linea.trim()) console.log(dim(`  [cloudflared] ${linea.trim()}`));
    }
    if (urlEncontrada) return;
    const match = TRYCLOUDFLARE_URL.exec(texto);
    if (match) {
      urlEncontrada = match[0];
      void instrucciones(urlEncontrada).catch((err: unknown) => {
        console.error(
          'No se pudo configurar el webhook:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  };
  hijo.stdout.on('data', mirar);
  hijo.stderr.on('data', mirar);

  hijo.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.error(
        '\nNo se encontro `cloudflared` en el PATH. Instalalo sin sudo:\n\n' +
          '  curl -fsSL -o ~/.local/bin/cloudflared \\\n' +
          '    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \\\n' +
          '  && chmod +x ~/.local/bin/cloudflared\n',
      );
    } else {
      console.error('\nFallo al lanzar cloudflared:', err.message);
    }
    process.exit(1);
  });

  hijo.on('exit', (code) => {
    console.log(`\ncloudflared termino (codigo ${code ?? 'null'}). El tunel ya no existe.`);
    process.exit(code ?? 0);
  });

  for (const senal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(senal, () => {
      console.log('\nCerrando el tunel...');
      hijo.kill(senal);
    });
  }
}

main().catch((err) => {
  console.error('El tunel fallo de forma inesperada:', err);
  process.exit(1);
});
