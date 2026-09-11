/**
 * Genera `test/fixtures/tablero_search_sample.json` — la respuesta simulada de
 * `GET /tablero/search` que usa `FixtureTableroApiClient`.
 *
 *   npm run fixture:generate
 *
 * Por que un generador y no un JSON escrito a mano: el fixture tiene ~200 registros (uno por
 * ALUMNO, igual que el dato real de tablero-api) y cada curso tiene que reproducir un
 * `pct_conexion` y una semana de curso exactos para que la clasificacion de urgencia caiga en
 * la banda esperada. A mano eso se desincroniza en el primer cambio.
 *
 * Fuentes:
 *  - `test/fixtures/semaforo_test_samples.csv`, seccion `A_RIESGO_CONEXION` — 9 cursos del
 *    documento de la auditoria previa (3 reales des-identificados + 6 sinteticos). De ahi salen
 *    `client_name`, `course_name`, `order_number`, `inscritos`, `sence_connections` y la
 *    `semana_curso` esperada, TAL CUAL. No se reinterpreta ningun numero de negocio.
 *  - `CURSOS_SINTETICOS` (mas abajo) — 7 cursos que el CSV no cubre: los casos de guardrail
 *    (sin telefono, do_not_call, OC internacional) y variedad de estados para poder operar el
 *    micrositio a mano.
 *
 * Campos SINTETICOS que este generador agrega y que NO existen en tablero-api real
 * (ver docs/context/PROJECT_CONTEXT.md y DECISIONS.md ADR-004):
 *  - `phone_test_only` — tablero-api no expone telefono en ningun punto de la cadena
 *    `po -> pod -> execution-sence -> tablero-api`.
 *  - `contacto_nombre` / `contacto_cargo` — tampoco existen. Van prefijados con `TEST ·` a
 *    proposito: hay cursos con nombre de cliente REAL, y un nombre de persona inventado sin
 *    marca podria leerse como dato real. El CARGO no responde la pregunta abierta UV-023
 *    (a quien se llama: alumno, encargado de capacitacion o ambos) — es solo un valor de
 *    relleno para poder mostrar la columna.
 *  - `_fixture_*` — metadatos de test (tag, nivel esperado, offsets de fecha, slot de allowlist).
 *
 * Fechas: no se copian del CSV. Cada curso declara la semana que debe reproducir y el
 * generador escribe offsets relativos a "hoy" (ver DECISIONS.md ADR-009) — el fixture no
 * envejece.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'test', 'fixtures');
const CSV_PATH = path.join(FIXTURES_DIR, 'semaforo_test_samples.csv');
const OUT_PATH = path.join(FIXTURES_DIR, 'tablero_search_sample.json');

/** Duracion de curso ficticia, y offset de inicio que pone "hoy" en el CENTRO de cada banda. */
const COURSE_DURATION_DAYS = 28;
const INIT_OFFSET_BY_WEEK: Record<number, number> = { 1: -4, 2: -11, 3: -18, 4: -25 };

interface CourseSpec {
  tag: string;
  clientId: string;
  clientName: string;
  courseName: string;
  orderNumber: string;
  orderStatus: string;
  /** Semana de curso (1-4) que este curso debe reproducir. */
  semana: number;
  inscritos: number;
  conexiones: number;
  nivelEsperado: 'NORMAL' | 'ALERTA' | 'CRITICO';
  contactoNombre: string;
  contactoCargo: string;
  /**
   * Telefono base. Los cursos CRITICO llevan numeros que se espera esten en
   * ALLOWLIST_NUMBERS; el resto lleva `+569000000XX`, obviamente falso.
   */
  phoneBase: string | null;
  /** Slot de ALLOWLIST_NUMBERS que reemplaza `phone_test_only` en tiempo de lectura. */
  allowlistSlot?: number;
  /** `true` para el unico curso que existe para probar que groupOrders lo excluye. */
  excluidoPorDisenio?: boolean;
  notas: string;
}

// --- Contactos sinteticos, uno por curso (marcados TEST · a proposito) ---
const CONTACTOS: Array<{ nombre: string; cargo: string }> = [
  { nombre: 'TEST · Carolina Munoz', cargo: 'Encargada de Capacitacion' },
  { nombre: 'TEST · Rodrigo Salas', cargo: 'Jefe de Recursos Humanos' },
  { nombre: 'TEST · Paulina Vergara', cargo: 'Coordinadora SENCE' },
  { nombre: 'TEST · Ignacio Fuentes', cargo: 'Analista de Personas' },
  { nombre: 'TEST · Marcela Bravo', cargo: 'Encargada de Capacitacion' },
  { nombre: 'TEST · Cristian Aguilera', cargo: 'Subgerente de Operaciones' },
  { nombre: 'TEST · Daniela Herrera', cargo: 'Coordinadora de Formacion' },
  { nombre: 'TEST · Felipe Contreras', cargo: 'Jefe de Administracion' },
];

function contacto(index: number): { nombre: string; cargo: string } {
  return CONTACTOS[index % CONTACTOS.length]!;
}

// ---------------------------------------------------------------------------
// 1. Cursos que vienen del CSV de la auditoria (seccion A_RIESGO_CONEXION)
// ---------------------------------------------------------------------------

function parseCsv(raw: string): Array<Record<string, string>> {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = cells[i] ?? '';
    });
    return row;
  });
}

/** Split minimo que respeta comillas dobles (el CSV tiene comas dentro de `notas`). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function slugId(clientName: string): string {
  return (
    'client_' +
    clientName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
  );
}

/**
 * Los tags de los cursos del CSV se fijan a mano (no se derivan del texto de `notas`) porque
 * los tests y `scripts/local-demo.ts` los referencian por nombre.
 */
const CSV_TAGS: Record<string, string> = {
  '1309833': 'REAL-1',
  '2127020': 'REAL-2',
  '1309834': 'REAL-3',
  'TEST-9101': 'SINT-ALERTA-S2',
  'TEST-9102': 'SINT-ALERTA-S3',
  'TEST-9103': 'SINT-ALERTA-S4',
  'TEST-9104': 'SINT-NORMAL-S1',
  'TEST-9105': 'SINT-NORMAL-S2',
  'TEST-9106': 'SINT-NORMAL-S4',
};

/** Los cursos CRITICO del CSV (los 3 reales) reciben slots de allowlist. */
const CSV_ALLOWLIST_SLOTS: Record<string, number> = {
  '1309833': 0,
  '2127020': 1,
  '1309834': 2,
};

/** Ids de cliente estables para los cursos del CSV (los tests los usan como identificador). */
const CSV_CLIENT_IDS: Record<string, string> = {
  'TEST-9101': 'client_test_alerta_s2',
  'TEST-9102': 'client_test_alerta_s3',
  'TEST-9103': 'client_test_alerta_s4',
  'TEST-9104': 'client_test_normal_s1',
  'TEST-9105': 'client_test_normal_s2',
  'TEST-9106': 'client_test_normal_s4',
};

function specsFromCsv(): CourseSpec[] {
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf-8')).filter(
    (r) => r.seccion === 'A_RIESGO_CONEXION',
  );

  return rows.map((row, index) => {
    const orderNumber = row.order_number!;
    const nivelEsperado = row.estado_esperado!.startsWith('NORMAL')
      ? 'NORMAL'
      : (row.estado_esperado as 'ALERTA' | 'CRITICO');
    const c = contacto(index);
    const slot = CSV_ALLOWLIST_SLOTS[orderNumber];
    return {
      tag: CSV_TAGS[orderNumber] ?? `CSV-${orderNumber}`,
      clientId: CSV_CLIENT_IDS[orderNumber] ?? slugId(row.client_name!),
      clientName: row.client_name!,
      courseName: row.course_name!,
      orderNumber,
      orderStatus: row.order_status_raw!,
      semana: Number(row.semana_curso),
      inscritos: Number(row.inscritos),
      conexiones: Number(row.sence_connections),
      nivelEsperado,
      contactoNombre: c.nombre,
      contactoCargo: c.cargo,
      // Los CRITICO llevan numero de allowlist (resuelto en tiempo de lectura), con un
      // fallback del rango de prueba del proyecto; los NORMAL/ALERTA llevan `+569000000XX`,
      // obviamente falso — asi el operador ve un telefono en el tablero pero el guardrail de
      // allowlist lo rechaza si alguien intenta llamarlo.
      phoneBase:
        slot !== undefined
          ? `+5690010${String(1 + index).padStart(4, '0')}`
          : `+56900000${String(10 + index).padStart(3, '0')}`,
      allowlistSlot: slot,
      notas: row.notas!,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Cursos sinteticos que el CSV no cubre
// ---------------------------------------------------------------------------

const CURSOS_SINTETICOS: CourseSpec[] = [
  {
    tag: 'SINT-CRITICO-DEMO',
    clientId: 'client_test_demo',
    clientName: 'TEST DEMO · CLIENTE DUMMY',
    courseName: 'CURSO DUMMY TEST DEMO CONEXION',
    orderNumber: 'TEST-9600',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 3,
    inscritos: 10,
    conexiones: 0,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Marcela Bravo',
    contactoCargo: 'Encargada de Capacitacion',
    phoneBase: '+56900100141',
    allowlistSlot: 0,
    notas: 'Curso del demo end-to-end y de los tests de dispatcher/disparo manual.',
  },
  {
    tag: 'SINT-CRITICO-S2',
    clientId: 'client_test_critico_s2',
    clientName: 'TEST CRITICO · CLIENTE DUMMY S2',
    courseName: 'CURSO DUMMY TEST CRITICO CONEXION',
    orderNumber: 'TEST-9601',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 2,
    inscritos: 10,
    conexiones: 3,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Cristian Aguilera',
    contactoCargo: 'Subgerente de Operaciones',
    phoneBase: '+56900100142',
    allowlistSlot: 1,
    notas: 'CRITICO en semana 2 (pct=30% < 55%): variedad de banda para el micrositio.',
  },
  {
    tag: 'SINT-CRITICO-S4',
    clientId: 'client_test_critico_s4',
    clientName: 'TEST CRITICO · CLIENTE DUMMY S4',
    courseName: 'CURSO DUMMY TEST CRITICO CONEXION TARDIA',
    orderNumber: 'TEST-9602',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 4,
    inscritos: 10,
    conexiones: 7,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Daniela Herrera',
    contactoCargo: 'Coordinadora de Formacion',
    phoneBase: '+56900100143',
    allowlistSlot: 2,
    notas: 'CRITICO en semana 4 (pct=70% < 90%): el caso mas urgente, curso por terminar.',
  },
  {
    tag: 'SINT-ALERTA-S3-BIS',
    clientId: 'client_test_alerta_s3_bis',
    clientName: 'TEST ALERTA · CLIENTE DUMMY S3 BIS',
    courseName: 'CURSO DUMMY TEST ALERTA CONEXION BIS',
    orderNumber: 'TEST-9603',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 3,
    inscritos: 10,
    conexiones: 8,
    nivelEsperado: 'ALERTA',
    contactoNombre: 'TEST · Felipe Contreras',
    contactoCargo: 'Jefe de Administracion',
    phoneBase: '+56900000004',
    notas: 'ALERTA justo en el umbral de semana 3 (pct=80% = alertaMin).',
  },
  {
    tag: 'SINT-CRITICO-SIN-TELEFONO',
    clientId: 'client_test_sin_telefono',
    clientName: 'TEST CRITICO SIN TELEFONO · CLIENTE DUMMY',
    courseName: 'CURSO DUMMY TEST SIN TELEFONO',
    orderNumber: 'TEST-9500',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 3,
    inscritos: 10,
    conexiones: 0,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Carolina Munoz',
    contactoCargo: 'Encargada de Capacitacion',
    phoneBase: null,
    notas: 'CRITICO pero sin phone_test_only — ejercita el guardrail "descartar sin telefono".',
  },
  {
    tag: 'SINT-CRITICO-DO-NOT-CALL',
    clientId: 'client_test_do_not_call',
    clientName: 'TEST CRITICO DO NOT CALL · CLIENTE DUMMY',
    courseName: 'CURSO DUMMY TEST DO NOT CALL',
    orderNumber: 'TEST-9501',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 3,
    inscritos: 10,
    conexiones: 0,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Rodrigo Salas',
    contactoCargo: 'Jefe de Recursos Humanos',
    // A proposito NO recibe slot de allowlist: mostrarle al operador su propio numero de
    // prueba como "no contactar" seria confuso y peligroso.
    phoneBase: '+56900100137',
    notas: 'Su telefono se siembra con do_not_call=true via scripts/seed-local.ts.',
  },
  {
    tag: 'SINT-CRITICO-OC-INTERNACIONAL',
    clientId: 'client_test_internacional',
    clientName: 'TEST CRITICO OC INTERNACIONAL · CLIENTE DUMMY',
    courseName: 'CURSO DUMMY TEST OC INTERNACIONAL',
    orderNumber: 'INT-9502',
    orderStatus: 'CURSO EN OPERACIÓN',
    semana: 3,
    inscritos: 10,
    conexiones: 0,
    nivelEsperado: 'CRITICO',
    contactoNombre: 'TEST · Paulina Vergara',
    contactoCargo: 'Coordinadora SENCE',
    phoneBase: '+56900000009',
    excluidoPorDisenio: true,
    notas:
      'OC que empieza con INT: groupOrders la excluye, asi que NO aparece entre los 15 cursos ' +
      'del tablero. Existe solo para verificar esa exclusion.',
  },
];

// ---------------------------------------------------------------------------
// 3. Expansion a registros por alumno
// ---------------------------------------------------------------------------

interface FixtureRecordOut {
  client_name: string;
  client_id: string;
  course_name: string;
  order_number: string;
  init_course: string;
  end_course: string;
  rut: string;
  sence_connections: number;
  order_status: string;
  student_email: string;
  first_name: string;
  last_name: string;
  updated_at: string;
  contacto_nombre: string;
  contacto_cargo: string;
  phone_test_only?: string;
  _fixture_tag: string;
  _fixture_esperado_nivel: string;
  _fixture_semana_objetivo: number;
  _fixture_offset_init_days: number;
  _fixture_offset_end_days: number;
  _fixture_offset_updated_days: number;
  _fixture_allowlist_slot?: number;
  _fixture_excluido_por_disenio?: boolean;
  _fixture_notas: string;
}

/** Fecha absoluta de referencia (informativa): los offsets son la fuente de verdad. */
const REFERENCE_TODAY = '2026-09-03';

function referenceDate(offsetDays: number): string {
  const base = new Date(`${REFERENCE_TODAY}T00:00:00.000Z`).getTime();
  return new Date(base + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function expand(spec: CourseSpec, courseIndex: number): FixtureRecordOut[] {
  const initOffset = INIT_OFFSET_BY_WEEK[spec.semana];
  if (initOffset === undefined) {
    throw new Error(`Curso ${spec.tag}: semana ${spec.semana} fuera de rango (1-4)`);
  }
  const endOffset = initOffset + COURSE_DURATION_DAYS;

  return Array.from({ length: spec.inscritos }, (_, i) => {
    const studentNumber = courseIndex * 100 + i + 1;
    const record: FixtureRecordOut = {
      client_name: spec.clientName,
      client_id: spec.clientId,
      course_name: spec.courseName,
      order_number: spec.orderNumber,
      init_course: referenceDate(initOffset),
      end_course: referenceDate(endOffset),
      rut: `${10000000 + studentNumber}-0`,
      // Los primeros `conexiones` alumnos del curso estan conectados: reproduce el
      // pct_conexion exacto del CSV cuando groupOrders agrega el curso.
      sence_connections: i < spec.conexiones ? 1 : 0,
      order_status: spec.orderStatus,
      student_email: `alumno.test.${studentNumber}@correo-test.umine.dev`,
      first_name: `Alumno${studentNumber}`,
      last_name: `Prueba${studentNumber}`,
      updated_at: `${referenceDate(-1)}T09:30:00.000Z`,
      contacto_nombre: spec.contactoNombre,
      contacto_cargo: spec.contactoCargo,
      _fixture_tag: spec.tag,
      _fixture_esperado_nivel: spec.nivelEsperado,
      _fixture_semana_objetivo: spec.semana,
      _fixture_offset_init_days: initOffset,
      _fixture_offset_end_days: endOffset,
      _fixture_offset_updated_days: -1,
      _fixture_notas: spec.notas,
    };

    // Solo el PRIMER alumno del curso lleva telefono: el evaluador y el micrositio eligen ese
    // registro como representante del curso (`records.find(r => r.phone_test_only)`), asi que
    // el telefono del curso queda univoco.
    if (spec.phoneBase && i === 0) {
      record.phone_test_only = spec.phoneBase;
      if (spec.allowlistSlot !== undefined) {
        record._fixture_allowlist_slot = spec.allowlistSlot;
      }
    }
    if (spec.excluidoPorDisenio) {
      record._fixture_excluido_por_disenio = true;
    }
    return record;
  });
}

// ---------------------------------------------------------------------------
// 4. Generar y verificar
// ---------------------------------------------------------------------------

function main() {
  const specs = [...specsFromCsv(), ...CURSOS_SINTETICOS];
  const visibles = specs.filter((s) => !s.excluidoPorDisenio);

  if (visibles.length !== 15) {
    throw new Error(
      `Se esperaban 15 cursos visibles en el tablero, hay ${visibles.length}. ` +
        'Ajusta CURSOS_SINTETICOS (ver test/fixtures/README.md).',
    );
  }

  const records = specs.flatMap((spec, i) => expand(spec, i));
  writeFileSync(OUT_PATH, JSON.stringify(records, null, 2) + '\n');

  const porNivel = visibles.reduce<Record<string, number>>((acc, s) => {
    acc[s.nivelEsperado] = (acc[s.nivelEsperado] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Fixture escrito: ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log(`  cursos visibles en el tablero: ${visibles.length}`);
  console.log(`  + excluidos por disenio (OC internacional): ${specs.length - visibles.length}`);
  console.log(`  registros (alumnos): ${records.length}`);
  console.log(`  por nivel esperado: ${JSON.stringify(porNivel)}`);
  console.log('\n  tag                            nivel     sem  pct     telefono');
  for (const spec of specs) {
    const pct = ((spec.conexiones / spec.inscritos) * 100).toFixed(1);
    const slot = spec.allowlistSlot !== undefined ? ` (allowlist[${spec.allowlistSlot}])` : '';
    console.log(
      `  ${spec.tag.padEnd(31)}${spec.nivelEsperado.padEnd(10)}${String(spec.semana).padEnd(5)}` +
        `${pct.padStart(6)}  ${spec.phoneBase ?? '(sin telefono)'}${slot}`,
    );
  }
}

main();
