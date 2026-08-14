/**
 * Levanta un DynamoDB local para desarrollo.
 *
 * El prompt original (§10) pide `docker-compose -f docker-compose.local.yml up -d`
 * (dynamodb-local real, via Docker) — esa es la forma "oficial" para el equipo, documentada
 * en docker-compose.local.yml y CLAUDE.md.
 *
 * Este sandbox de esta sesion NO tiene Docker disponible, asi que este script es un fallback
 * verificable: levanta `dynalite` (implementacion pura JS de la API de DynamoDB, sin
 * Docker/Java) como proceso hijo detached, escuchando en el mismo DYNAMODB_ENDPOINT del
 * .env. Ambos exponen el mismo protocolo (AWS SDK DynamoDB), por lo que el resto del
 * codigo (BaseRepository, scripts/create-local-tables.ts, etc.) no distingue cual esta corriendo.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, '..', '.dynalite.pid');

if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(pid, 0);
    console.log(`dynalite ya esta corriendo (pid ${pid}). Usa 'npm run local:down' primero si quieres reiniciarlo.`);
    process.exit(0);
  } catch {
    // pid muerto, sigue y relanza
  }
}

const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx'), path.resolve(__dirname, 'dynalite-server.ts')], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
writeFileSync(PID_FILE, String(child.pid));
console.log(`dynalite lanzado en background (pid ${child.pid}). Ver DYNAMODB_ENDPOINT en .env.`);
