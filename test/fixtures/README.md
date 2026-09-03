# Fixtures

## `tablero_search_sample.json`

Simula la respuesta de `GET /tablero/search` (tablero-api / "el Semaforo"), usada por defecto
por `FixtureTableroApiClient` (`TABLERO_API_MODE=fixture`, el default en local). Generado a
partir del mismo patron de datos que `semaforo_test_samples.csv` (documento de la auditoria
previa de `micrositio-operaciones-tablero-sence`), con dos diferencias explicitas:

1. Solo incluye la seccion `A_RIESGO_CONEXION` (el unico caso de uso del MVP, ver prompt §5.1).
   Las secciones B (Riesgo DJ) y C (Rectificacion) del CSV original no se portaron: quedan
   fuera de alcance de esta sesion.
2. Agrega un campo `phone_test_only` — **dato SINTETICO, no existe en produccion**. tablero-api
   real no expone telefono en ningun punto de la cadena `po -> pod -> execution-sence ->
tablero-api` (ver `docs/context/PROJECT_CONTEXT.md`). Un subconjunto de registros omite este
   campo a proposito, para poder ejercitar el guardrail "descartar sin telefono valido".

Cada registro representa un ALUMNO (igual que el dato real), con `enrolled_count: 1` y
`sence_connections` en `0|1`. `groupOrders()` (en `order-status-promoter.ts`) agrega por
`client_id + order_number` para reconstruir el `pct_conexion` a nivel de curso, tal como lo
hace el Semaforo real.

### Grupos incluidos (marcados con `_fixture_tag` / `_fixture_esperado_nivel`, solo para tests)

| Tag                             | Origen                                       | Nivel esperado       | Notas                                                                                                                                      |
| ------------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REAL-1`, `REAL-2`, `REAL-3`    | Dato real (des-identificado) de la auditoria | CRITICO              | pct_conexion=0%/12.5%, semanas 3-4                                                                                                         |
| `SINT-ALERTA-S2/S3/S4`          | Sintetico                                    | ALERTA               | una por cada semana de curso 2/3/4                                                                                                         |
| `SINT-NORMAL-S1/S2/S4`          | Sintetico                                    | NORMAL               | no deberian aparecer como candidatos                                                                                                       |
| `SINT-CRITICO-SIN-TELEFONO`     | Sintetico                                    | CRITICO (descartado) | sin `phone_test_only` — prueba el guardrail                                                                                                |
| `SINT-CRITICO-DO-NOT-CALL`      | Sintetico                                    | CRITICO (descartado) | su telefono se siembra con `do_not_call=true` en CONTACT via `scripts/seed-local.ts` (tablero-api real no tiene este campo, ver mas abajo) |
| `SINT-CRITICO-OC-INTERNACIONAL` | Sintetico                                    | CRITICO (descartado) | `order_number` empieza con `INT-`                                                                                                          |
| `SINT-CRITICO-DEMO`             | Sintetico                                    | CRITICO              | usado por `scripts/local-demo.ts` para el flujo end-to-end                                                                                 |

### Sobre las fechas (importante)

Los grupos `SINT-*` fueron disenados con `init_course`/`end_course` centrados alrededor de
`FIXTURE_REFERENCE_NOW` (`test/fixtures/reference-time.ts`, `2026-08-13T16:00:00.000Z`), usando
una duracion de curso ficticia de 84 dias (bandas de 21 dias por "semana logica") para dar
margen de ~10 dias de tolerancia a la deriva del reloj real. Esto significa:

- Si corres los tests o el demo dentro de pocas semanas de esa fecha, la clasificacion es estable.
- Pasado ese margen, algunos grupos `SINT-*` cercanos a un borde de banda podrian reclasificarse
  a la banda vecina — es el mismo comportamiento que tendria el Semaforo real con datos
  reales que envejecen (no hay `last_sence_sync`, solo `updated_at`). Si eso ocurre, regenera
  las fechas del fixture (o ajusta `FIXTURE_REFERENCE_NOW` y las corridas de test que lo pinean).

Los tests que verifican la alineacion fixture -> clasificacion (`test/integration/fixture-tablero-api-client.spec.ts`)
pinean el reloj a `FIXTURE_REFERENCE_NOW` con `vi.setSystemTime`, por lo que son deterministas
sin importar cuando se ejecute el test suite.

## `elevenlabs_post_call_payload.sample.json` / `twilio_status_payload.sample.json`

Payloads de ejemplo usados por los tests de los webhooks (ver `test/integration/`). No son
datos reales — construidos siguiendo la forma documentada de cada proveedor.

## Fechas relativas (`_fixture_offset_*_days`) — leer antes de tocar el fixture

Desde 2026-09-03 las fechas del fixture **no se usan tal como estan en el JSON**. Cada
registro lleva:

- `_fixture_offset_init_days` — dias (relativos a la medianoche UTC de hoy) para `init_course`
- `_fixture_offset_end_days` — idem para `end_course`
- `_fixture_offset_updated_days` — idem para `updated_at`
- `_fixture_semana_objetivo` — la semana de curso (1-4) que ese grupo debe reproducir

`FixtureTableroApiClient.search()` reescribe los tres campos en cada llamada. Los offsets usan
una duracion de curso fija de 28 dias y colocan "hoy" en el CENTRO de la banda de semana
objetivo (progreso 0.125 / 0.375 / 0.625 / 0.875), asi que la clasificacion nunca queda en un
borde y el fixture no envejece. Ver `docs/architecture/DECISIONS.md` ADR-009 y
`docs/status/INVENTARIO-2026-09-03.md` (el bug que motivo el cambio).

Los valores absolutos de `init_course`/`end_course` que siguen en el JSON son el dato de
referencia historico de la auditoria — informativos, no funcionales.

**Si agregas un grupo:** ponle los cuatro campos `_fixture_*` de arriba usando los offsets de
la banda que quieras (`1: -4`, `2: -11`, `3: -18`, `4: -25`, y `end = init + 28`).
