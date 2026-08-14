/**
 * Proceso hijo que efectivamente corre dynalite. No lo ejecutes directo — usa
 * `npm run local:up` (scripts/local-dynamo-up.ts), que lo lanza detached.
 */
import dynalite from 'dynalite';
import { env } from '../src/utils/env.js';

function portFromEndpoint(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    return url.port ? Number(url.port) : 8000;
  } catch {
    return 8000;
  }
}

const port = portFromEndpoint(env.dynamodbEndpoint);
const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });

server.listen(port, () => {
  console.log(`dynalite escuchando en :${port} (pid ${process.pid})`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
