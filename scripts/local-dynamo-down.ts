import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, '..', '.dynalite.pid');

if (!existsSync(PID_FILE)) {
  console.log('No hay dynalite corriendo (no existe .dynalite.pid).');
  process.exit(0);
}

const pid = Number(readFileSync(PID_FILE, 'utf-8').trim());
try {
  process.kill(pid, 'SIGTERM');
  console.log(`dynalite (pid ${pid}) detenido.`);
} catch {
  console.log(`No se pudo detener el pid ${pid} (¿ya estaba caido?).`);
}
unlinkSync(PID_FILE);
