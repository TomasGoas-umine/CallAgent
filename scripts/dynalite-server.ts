/**
 * Proceso hijo que efectivamente corre dynalite. No lo ejecutes directo — usa
 * `npm run local:up` (scripts/local-dynamo-up.ts), que lo lanza detached.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dynalite from 'dynalite';
import { env } from '../src/utils/env.js';

/**
 * Directorio del store LevelDB. Sin `path`, dynalite guarda TODO en memoria y cada reinicio
 * borra la base entera — incluidos los items `CONVERSATION#<id> META`, que son los que ligan
 * el `conversation_id` del webhook post-call con nuestro `followup_id`. Perder eso significa
 * que el resultado de una llamada ya hecha se vuelve irrecuperable: el webhook llega, no
 * encuentra a quien atribuirlo y responde `ignored/unknown_conversation_id` (paso de verdad,
 * ver UV-056).
 *
 * `docker-compose.local.yml` se alineo al mismo comportamiento (monta un volumen en este mismo
 * directorio en vez de `-inMemory`), para que los dos caminos locales se comporten igual.
 * El directorio ya esta en `.gitignore`. Para empezar de cero:
 * `npm run local:down && rm -rf .dynamo-local-data`.
 */
const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.dynamo-local-data',
);

function portFromEndpoint(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    return url.port ? Number(url.port) : 8000;
  } catch {
    return 8000;
  }
}

const port = portFromEndpoint(env.dynamodbEndpoint);
const server = dynalite({ path: DATA_DIR, createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });

server.listen(port, () => {
  console.log(`dynalite escuchando en :${port} (pid ${process.pid}), datos en ${DATA_DIR}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
