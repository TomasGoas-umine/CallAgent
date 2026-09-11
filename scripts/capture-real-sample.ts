/**
 * Captura una respuesta REAL de `GET /tablero/search` y la escribe anonimizada en
 * `test/fixtures/tablero_search_real_anonymized.json`.
 *
 *   npx tsx scripts/capture-real-sample.ts --base-url https://<gateway> --pages 2 --limit 200
 *
 * Por que existe: el fixture sintetico (`tablero_search_sample.json`) prueba la CLASIFICACION,
 * pero no prueba el CONTRATO — nombres de campos, sobre de paginacion, tipos mezclados. Cuatro
 * incompatibilidades reales entre CallAgent y tablero-api sobrevivieron porque ningun test
 * miraba una respuesta de verdad (ver docs/SEMAFORO_INTEGRACION.md §9).
 *
 * Anonimizacion (deterministica, por hash — el mismo input da el mismo alias en cada corrida,
 * asi que las relaciones entre registros se conservan y el diff del fixture es estable):
 *   - PII de personas: rut, first_name, last_name, student_name, student_email.
 *   - Personal de Umine: coordinator, commercial_owner.
 *   - Identificadores de negocio: client_name, client_id, order_number, id_sence, cod_sence,
 *     po_id, invoice_number, original_order_number, final_oc_number.
 * Se conservan TAL CUAL (son lo que los tests necesitan ejercitar): fechas, montos,
 * sence_connections, dj, order_status, otic, y la forma exacta del sobre de la respuesta.
 *
 * El archivo generado NO se regenera en CI ni en los tests: es un snapshot congelado con su
 * `captured_at`, y los tests pinean el reloj a esa fecha.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(
  __dirname,
  '..',
  'test',
  'fixtures',
  'tablero_search_real_anonymized.json',
);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta --${name}`);
  }
  return v;
}

function h(value: string, salt: string, mod: number): number {
  const digest = createHash('sha256').update(`${salt}::${value}`).digest();
  return digest.readUInt32BE(0) % mod;
}

const NOMBRES = [
  'Ana',
  'Luis',
  'Carmen',
  'Diego',
  'Rosa',
  'Mario',
  'Elena',
  'Pablo',
  'Sofia',
  'Hugo',
];
const APELLIDOS = [
  'Rojas',
  'Munoz',
  'Silva',
  'Castro',
  'Reyes',
  'Vega',
  'Pinto',
  'Bravo',
  'Salas',
  'Nunez',
];

function fakeRut(rut: string): string {
  const body = 10_000_000 + h(rut, 'rut', 9_000_000);
  const dv = 'K0123456789'[h(rut, 'dv', 11)];
  return `${body}-${dv}`;
}

function fakeDigits(value: string, len: number, salt: string): string {
  const base = 10 ** (len - 1);
  return String(base + h(value, salt, 9 * base));
}

/** Campos que se anonimizan; el resto pasa tal cual. */
function anonymizeItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  const str = (k: string): string | null =>
    typeof item[k] === 'string' ? (item[k] as string) : null;

  const rut = str('rut');
  if (rut) out.rut = fakeRut(rut);

  const first = str('first_name');
  if (first) out.first_name = NOMBRES[h(first, 'first', NOMBRES.length)];
  const last = str('last_name');
  if (last) out.last_name = APELLIDOS[h(last, 'last', APELLIDOS.length)];
  if (str('student_name'))
    out.student_name = `${out.first_name ?? 'Ana'} ${out.last_name ?? 'Rojas'}`;
  if (str('student_email'))
    out.student_email = `alumno${h(str('student_email')!, 'mail', 9999)}@ejemplo.cl`;

  const coord = str('coordinator');
  if (coord) out.coordinator = `Coordinador ${h(coord, 'coord', 20)}`;
  const owner = str('commercial_owner');
  if (owner) out.commercial_owner = `Comercial ${h(owner, 'owner', 20)}`;

  const cliente = str('client_name');
  if (cliente)
    out.client_name = `CLIENTE ${String.fromCharCode(65 + h(cliente, 'cli', 26))}${h(cliente, 'cli2', 100)}`;
  const clientId = str('client_id');
  if (clientId) out.client_id = fakeDigits(clientId, 4, 'clid');

  for (const [k, len, salt] of [
    ['order_number', 7, 'oc'],
    ['id_sence', 7, 'ids'],
    ['cod_sence', 10, 'cods'],
    ['original_order_number', 7, 'ooc'],
    ['final_oc_number', 7, 'foc'],
    ['invoice_number', 6, 'inv'],
  ] as Array<[string, number, string]>) {
    const v = str(k);
    if (v) out[k] = fakeDigits(v, len, salt);
  }

  const poId = str('po_id');
  if (poId) out.po_id = createHash('sha256').update(poId).digest('hex').slice(0, 36);

  // pk/sk incrustan id_sence y rut — se rearman con los valores ya anonimizados.
  if (typeof item.pk === 'string') out.pk = `SENCE#${out.id_sence ?? '0000000'}`;
  if (typeof item.sk === 'string') out.sk = `STUDENT#${out.rut ?? '10000000-0'}`;

  return out;
}

async function main(): Promise<void> {
  const baseUrl = arg('base-url');
  const pages = Number(arg('pages', '2'));
  const limit = arg('limit', '200');

  const capturedPages: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  for (let i = 0; i < pages; i++) {
    const url = new URL('/tablero/search', baseUrl);
    url.searchParams.set('limit', limit);
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`tablero-api respondio ${response.status}`);
    const payload = (await response.json()) as {
      items?: Array<Record<string, unknown>>;
      total?: number;
      nextCursor?: string | null;
      hasMore?: boolean;
    };

    capturedPages.push({
      items: (payload.items ?? []).map(anonymizeItem),
      total: payload.total ?? 0,
      nextCursor: payload.nextCursor ?? null,
      hasMore: payload.hasMore ?? false,
    });

    console.log(
      `pagina ${i + 1}: ${payload.items?.length ?? 0} items · hasMore=${payload.hasMore} · nextCursor=${payload.nextCursor}`,
    );

    cursor = payload.nextCursor ?? null;
    if (!payload.hasMore || !cursor) break;
  }

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        _README:
          'Snapshot ANONIMIZADO de GET /tablero/search (prod). Generado por scripts/capture-real-sample.ts. No editar a mano. Los tests pinean el reloj a captured_at.',
        captured_at: new Date().toISOString(),
        pages: capturedPages,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nescrito: ${OUT}`);
}

void main();
