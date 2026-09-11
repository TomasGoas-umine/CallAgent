/**
 * semaforo-probe — lee el Semaforo y reporta que veria CallAgent, sin tocar nada.
 *
 *   npm run semaforo:probe
 *   npm run semaforo:probe -- --http --base-url https://<gateway>
 *
 * Es ESTRICTAMENTE de solo lectura: no abre DynamoDB, no crea FOLLOWUPs, no encola, no llama.
 * No importa ni el dispatcher ni los repositorios — no puede disparar una llamada aunque se
 * configure mal el entorno, porque el codigo que llama no esta en el grafo de imports.
 *
 * Para que sirve: separar "hoy no hay candidatos" de "la lectura esta rota". Los dos casos se
 * ven igual desde afuera (cero llamadas) y esa ambiguedad es la que dejo pasar cuatro
 * incompatibilidades de contrato durante meses.
 */

import { readSemaforo } from '../src/services/course-lookup.js';
import { FixtureTableroApiClient } from '../src/services/tablero-api-client.fixture.js';
import { HttpTableroApiClient } from '../src/services/tablero-api-client.http.js';
import type { TableroApiClient } from '../src/services/tablero-api-client.js';
import { env } from '../src/utils/env.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function buildClient(): { client: TableroApiClient; modo: string; fuente: string } {
  const usarHttp = flag('http') || env.tableroApiMode === 'http';
  if (!usarHttp) {
    return {
      client: new FixtureTableroApiClient(),
      modo: 'fixture',
      fuente: 'test/fixtures/tablero_search_sample.json',
    };
  }
  const baseUrl = arg('base-url', env.tableroApiBaseUrl);
  if (!baseUrl) {
    throw new Error('Modo http sin URL: pasa --base-url o setea TABLERO_API_BASE_URL en .env');
  }
  return {
    client: new HttpTableroApiClient(baseUrl, env.tableroApiToken),
    modo: 'http',
    fuente: `${baseUrl}/tablero/search`,
  };
}

function fila(label: string, valor: string | number): string {
  return `  ${label.padEnd(34, '.')} ${valor}`;
}

async function main(): Promise<void> {
  const { client, modo, fuente } = buildClient();

  console.log('\n=== SEMAFORO PROBE (solo lectura, no dispara nada) ===');
  console.log(fila('modo', modo));
  console.log(fila('fuente', fuente));
  console.log(fila('DRY_RUN del entorno', String(env.dryRun)));

  const inicio = Date.now();
  const { evaluaciones, stats } = await readSemaforo(client);
  const ms = Date.now() - inicio;

  console.log('\n--- Lectura ---');
  console.log(fila('paginas leidas', stats.paginas));
  console.log(fila('truncado', String(stats.truncado)));
  console.log(fila('registros recibidos', stats.registrosRecibidos));
  console.log(fila('tiempo', `${ms} ms`));

  console.log('\n--- Registros descartados ---');
  console.log(fila('estado muerto (DEAD_ESTADOS)', stats.registrosDescartados.estadoMuerto));
  console.log(fila('sin order_number', stats.registrosDescartados.sinOrderNumber));
  console.log(fila('OC de otro equipo (INT)', stats.registrosDescartados.ocExcluida));
  console.log(fila('alumno inactivo (REVISAR/BAJA)', stats.registrosDescartados.alumnoInactivo));
  console.log(fila('registros agregados', stats.registrosAgregados));

  console.log('\n--- Agregacion por OC ---');
  console.log(fila('OCs agrupadas', stats.ocsAgrupadas));
  console.log(fila('fuera: no en ejecucion', stats.ocsFueraDeSeccionA.no_en_ejecucion));
  console.log(fila('fuera: curso terminado', stats.ocsFueraDeSeccionA.curso_terminado));
  console.log(fila('fuera: conexion completa', stats.ocsFueraDeSeccionA.conexion_completa));
  console.log(fila('OCs en seccion A', stats.ocsSeccionA));

  console.log('\n--- Clasificacion (seccion A) ---');
  console.log(fila('NORMAL', stats.porNivel.NORMAL));
  console.log(fila('ALERTA', stats.porNivel.ALERTA));
  console.log(fila('CRITICO', stats.porNivel.CRITICO));
  console.log(fila('visibles en el Semaforo', stats.ocsVisiblesEnSemaforo));

  const criticos = evaluaciones.filter((e) => e.candidatoALlamada);
  const conTelefono = criticos.filter((e) => e.group.records.some((r) => r.phone_test_only));

  console.log('\n--- Candidatos a llamada ---');
  console.log(fila('CRITICOS en seccion A', criticos.length));
  console.log(fila('...con telefono disponible', conTelefono.length));
  console.log(fila('...sin telefono (UV-023)', criticos.length - conTelefono.length));

  if (criticos.length > 0) {
    console.log('\n  OC          semana  %conex  inscritos  dias  telefono  estado');
    for (const e of criticos.slice(0, 20)) {
      const tel = e.group.records.some((r) => r.phone_test_only) ? 'si' : 'NO';
      console.log(
        `  ${e.group.orderNumber.padEnd(11)} ${String(e.semana).padEnd(7)} ` +
          `${e.group.pctConexion.toFixed(0).padStart(5)}%  ${String(e.group.totalConnections + '/' + e.group.enrolledCount).padEnd(10)} ` +
          `${String(e.diasRestantes).padStart(4)}  ${tel.padEnd(9)} ${e.group.promotedOrderStatus}`,
      );
    }
  }

  console.log('\nNo se creo ningun FOLLOWUP, no se encolo nada y no se origino ninguna llamada.\n');
}

void main().catch((err: unknown) => {
  console.error('\nprobe fallo:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
