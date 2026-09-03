# Fixtures

## `tablero_search_sample.json` — NO editar a mano

**Este archivo se genera.** Para cambiarlo, edita `scripts/generate-fixture.ts` y corre:

```bash
npm run fixture:generate
```

Simula la respuesta de `GET /tablero/search` (tablero-api / "el Semaforo"), y es lo que usa
`FixtureTableroApiClient` (`TABLERO_API_MODE=fixture`, el default en local).

Se genera a partir de dos fuentes:

1. **`semaforo_test_samples.csv`** (en esta misma carpeta) — el documento de la auditoria previa
   de `micrositio-operaciones-tablero-sence`. De su seccion `A_RIESGO_CONEXION` salen 9 cursos
   con sus `client_name`, `course_name`, `order_number`, `inscritos`, `sence_connections` y
   `semana_curso` **tal cual**. Las secciones B (Riesgo DJ) y C (Rectificacion) no se portaron:
   estan fuera del alcance del MVP (prompt §5.1).
2. **`CURSOS_SINTETICOS`** en el generador — 7 cursos que el CSV no cubre: los casos de
   guardrail y variedad de estados para poder operar el micrositio a mano.

Cada registro representa un ALUMNO (igual que el dato real), con `enrolled_count: 1` y
`sence_connections` en `0|1`. `groupOrders()` (en `order-status-promoter.ts`) agrega por
`client_id + order_number` para reconstruir el `pct_conexion` del curso, tal como lo hace el
Semaforo real. Los primeros `sence_connections` alumnos de cada curso son los conectados, para
reproducir el `pct_conexion` exacto del CSV.

### Los 15 cursos del tablero (+1 excluido por disenio)

| Tag                             | Nivel   | Semana | pct    | Telefono                        | Notas                                                      |
| ------------------------------- | ------- | ------ | ------ | ------------------------------- | ---------------------------------------------------------- |
| `REAL-1`                        | CRITICO | 3      | 0.0%   | `allowlist[0]` / `…0001`        | Dato real des-identificado (CSV)                           |
| `REAL-2`                        | CRITICO | 4      | 12.5%  | `allowlist[1]` / `…0002`        | Dato real des-identificado (CSV)                           |
| `REAL-3`                        | CRITICO | 3      | 0.0%   | `allowlist[2]` / `…0003`        | Dato real des-identificado (CSV)                           |
| `SINT-ALERTA-S2`                | ALERTA  | 2      | 55.0%  | `+56900000013` (falso)          | CSV                                                        |
| `SINT-ALERTA-S3`                | ALERTA  | 3      | 85.0%  | `+56900000014` (falso)          | CSV                                                        |
| `SINT-ALERTA-S4`                | ALERTA  | 4      | 95.0%  | `+56900000015` (falso)          | CSV                                                        |
| `SINT-NORMAL-S1`                | NORMAL  | 1      | 25.0%  | `+56900000016` (falso)          | CSV. Lo usan los tests de revalidacion                     |
| `SINT-NORMAL-S2`                | NORMAL  | 2      | 65.0%  | `+56900000017` (falso)          | CSV                                                        |
| `SINT-NORMAL-S4`                | NORMAL  | 4      | 100.0% | `+56900000018` (falso)          | CSV                                                        |
| `SINT-CRITICO-DEMO`             | CRITICO | 3      | 0.0%   | `allowlist[0]` / `+56900100141` | Curso del `local:demo` y de los tests de dispatcher        |
| `SINT-CRITICO-S2`               | CRITICO | 2      | 30.0%  | `allowlist[1]` / `+56900100142` | CRITICO temprano (semana 2)                                |
| `SINT-CRITICO-S4`               | CRITICO | 4      | 70.0%  | `allowlist[2]` / `+56900100143` | El caso mas urgente: curso por terminar                    |
| `SINT-ALERTA-S3-BIS`            | ALERTA  | 3      | 80.0%  | `+56900000004` (falso)          | Justo en el umbral `alertaMin` de semana 3                 |
| `SINT-CRITICO-SIN-TELEFONO`     | CRITICO | 3      | 0.0%   | **ninguno**                     | Guardrail "descartar sin telefono valido"                  |
| `SINT-CRITICO-DO-NOT-CALL`      | CRITICO | 3      | 0.0%   | `+56900100137` (fijo)           | `scripts/seed-local.ts` lo marca `do_not_call=true`        |
| `SINT-CRITICO-OC-INTERNACIONAL` | —       | 3      | 0.0%   | `+56900000009` (falso)          | **No aparece en el tablero**: `groupOrders` excluye `INT*` |

El generador falla si los cursos visibles dejan de ser exactamente 15.

### Telefonos: allowlist vs numeros falsos

- **Cursos CRITICO** — declaran `_fixture_allowlist_slot`. `FixtureTableroApiClient` reemplaza
  `phone_test_only` por `ALLOWLIST_NUMBERS[slot]` en tiempo de lectura, para que el micrositio
  muestre un numero **realmente llamable** (el del operador). Si ese slot no existe en la
  allowlist configurada, queda el numero autorado como fallback y el guardrail de allowlist lo
  rechaza con su motivo visible — que es el comportamiento correcto.
- **Cursos ALERTA / NORMAL** — `+569000000XX`, obviamente falsos. Aparecen en el tablero (el
  operador ve la columna) pero jamas pasan el guardrail de allowlist.
- **`SINT-CRITICO-DO-NOT-CALL`** — a proposito NO recibe slot: mostrarle al operador su propio
  numero de prueba etiquetado "no contactar" seria confuso y peligroso.

### Campos SINTETICOS (no existen en tablero-api real)

`phone_test_only`, `contacto_nombre` y `contacto_cargo`. tablero-api no expone telefono ni
contacto en ningun punto de la cadena `po -> pod -> execution-sence -> tablero-api` (ver
`docs/context/PROJECT_CONTEXT.md` y `DECISIONS.md` ADR-004, y los tickets abiertos UV-023 /
UV-024).

Los nombres de contacto van prefijados con `TEST ·` **a proposito**: hay cursos con nombre de
cliente real, y un nombre de persona inventado sin marca podria leerse como dato real. El
`contacto_cargo` **no responde** la pregunta abierta de a quien se llama (alumno, encargado de
capacitacion o ambos, UV-023): es relleno para poder mostrar la columna.

### Fechas relativas (`_fixture_offset_*_days`)

Las fechas del fixture **no se usan tal como estan en el JSON**. Cada registro lleva:

- `_fixture_offset_init_days` — dias (relativos a la medianoche UTC de hoy) para `init_course`
- `_fixture_offset_end_days` — idem para `end_course`
- `_fixture_offset_updated_days` — idem para `updated_at`
- `_fixture_semana_objetivo` — la semana de curso (1-4) que ese grupo debe reproducir

`FixtureTableroApiClient.search()` reescribe los tres campos en cada llamada. Los offsets usan
una duracion de curso fija de 28 dias y colocan "hoy" en el CENTRO de la banda de semana
objetivo (progreso 0.125 / 0.375 / 0.625 / 0.875), asi que la clasificacion nunca queda en un
borde y el fixture no envejece. Ver `DECISIONS.md` ADR-009 y
`docs/status/INVENTARIO-2026-09-03.md` (el bug que motivo el cambio: el fixture anterior tenia
fechas absolutas y tres semanas despues reclasificaba 4 de 13 grupos solo).

Los valores absolutos de `init_course` / `end_course` en el JSON son informativos.

## `semaforo_test_samples.csv`

Copia del documento de la auditoria previa, incluida en el repo para que
`npm run fixture:generate` sea reproducible sin depender de rutas fuera del proyecto. Solo se
consume su seccion `A_RIESGO_CONEXION`.

## `elevenlabs_post_call_payload.sample.json` / `twilio_status_payload.sample.json`

Payloads de ejemplo usados por los tests de los webhooks (ver `test/integration/`). No son
datos reales — construidos siguiendo la forma documentada de cada proveedor.
