# Inventario del esqueleto — 2026-09-03 (Fase 0)

Levantamiento hecho antes de escribir codigo nuevo, sobre la rama `dev` en el commit
`5118200`. Metodo: `npm run build` + `npm run lint` + `npm run format:check` + `npm test`,
lectura completa de `src/`, `scripts/` y `test/`, y corrida real del flujo local
(`local:up` -> `create-tables` -> `seed` -> `local:server` -> `local:demo`).

## Resultado de las verificaciones

| Verificacion              | Resultado                                                      |
| ------------------------- | -------------------------------------------------------------- |
| `npm run build` (tsc)     | OK, sin errores                                                |
| `npm run lint` (eslint)   | OK, 0 warnings                                                 |
| `npm run format:check`    | FALLA en `PROGRESS.md` (unico archivo sin formatear)           |
| `npm test`                | 92/92 tests pasando (12 archivos), 2.8s                        |
| `npm run local:up/tables` | OK (dynalite, sin Docker en esta maquina)                      |
| `npm run local:demo`      | **FALLA** — ver "Lo que estaba roto"                           |
| Node                      | v22.19.0 (el `engines` del repo pide `>=24 <25`, `EBADENGINE`) |

## Lo que esta realmente implementado (verificado leyendo el codigo y corriendo tests)

Logica de dominio y servicios — **implementado y con tests**:

- `urgency-classifier.ts` — `getCourseWeek` + `clasificarConexion`, 4 bandas de semana.
- `order-status-promoter.ts` — `promoteOrderStatus` + `groupOrders` (agrega por
  `client_id + order_number`, excluye OCs `INT*` e `INACTIVE_STATUSES`).
- `guardrails.ts` — kill switch, ventana horaria (con dia habil, sin feriados), allowlist,
  cuota diaria. Un solo modulo, usado por evaluator y dispatcher.
- `idempotency.ts` — `sha256(destinatario|motivo|order_number|semana_ISO)`.
- `call-outcome-classifier.ts` — taxonomia de 13 valores con precedencia explicita.
- `elevenlabs-client.ts` — real + mock; la factory nunca activa el real por omision.
- `auth/elevenlabs-signature-validator.ts` y `auth/twilio-signature-validator.ts`.
- `logger.ts` — enmascara telefonos, redacta secretos, omite transcripciones.
- `queue.ts` — cola FIFO en memoria (`sharedLocalQueue`), sin worker propio: solo se drena
  cuando alguien llama al endpoint del dispatcher.

Persistencia — **implementada y con tests de integracion contra dynalite real**:

- `base-repository.ts` (get / put / put condicional / update / update condicional / query).
- `followup-repository.ts` — `FOLLOWUP#<id> META`, `CALL#<conversation_id>`,
  `CONVERSATION#<id> META` (mapeo inverso), GSI1 por estado, GSI2 por destinatario.
- `contact-repository.ts` — `do_not_call` y `last_contacted_at`.
- `idempotency-repository.ts` — lock con `attribute_not_exists(PK)`.

Handlers:

- `candidate-evaluator` — **implementado** (6 tests de integracion).
- `call-dispatcher` — **implementado** (9 tests): revalida contra el Semaforo, revalida
  guardrails, escritura condicional READY->DIALING, reintentos con backoff.
- `webhooks/elevenlabs-post-call` — **implementado** (8 tests): firma, idempotencia por
  `conversation_id`, clasificacion, transicion de estado.

Entorno local:

- `dynalite` como DynamoDB local (Docker no esta instalado en esta maquina), tabla + GSIs,
  seed, server Fastify y demo end-to-end.

## Lo que es stub, falta, o esta a medias

| Pieza                         | Estado                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks/twilio-status`      | **Stub declarado**: valida firma y loguea, no reconcilia nada (`TODO` en el codigo, UV-030). Sin tests de integracion.                                                                                                                                                                                              |
| `ESCALATION`                  | `domain/escalation.ts` esta modelado pero **no hay repositorio**: escalar solo deja el FOLLOWUP en `ESCALADO` + un log (UV-029).                                                                                                                                                                                    |
| Transcripcion de la llamada   | **No se persiste**: `recordCall` guarda `transcriptS3Key: null` y descarta `transcript` / `transcript_summary` del payload.                                                                                                                                                                                         |
| Cuota diaria persistente      | `guardrails.isDailyQuotaExceeded` recibe el contador **por parametro**; nadie lo calcula desde la base. El evaluador cuenta en memoria (`createdToday`) y se reinicia con el proceso.                                                                                                                               |
| Listar followups              | No existe: solo `getById`, `findReadyForDispatch(estado, ...)` y `findRecentByDestinatario`. `BaseRepository` no tiene `scan`.                                                                                                                                                                                      |
| API de operacion / micrositio | No existe. `src/local/server.ts` solo expone endpoints `/internal/*` de debug y `/health` minimo.                                                                                                                                                                                                                   |
| Disparo manual de UNA llamada | No existe. El unico camino a una llamada hoy es `evaluator` (que encola en lote) + `dispatcher/drain`.                                                                                                                                                                                                              |
| `HttpTableroApiClient`        | Construido pero inactivo por decision (UV-024: tablero-api no expone telefono).                                                                                                                                                                                                                                     |
| `infra/`                      | CDK v2 construido, nunca sintetizado ni desplegado. **Incluye una `events.Rule` de cron para el evaluador** (`cron(0 13,19 ? * MON-FRI *)`) — no se toca en esta sesion, pero queda anotado: ese cron es incompatible con la restriccion de plan Starter y debe quedar deshabilitado antes de cualquier despliegue. |
| Fixture                       | 142 registros / 13 grupos, con `phone_test_only` sintetico. **Fechas absolutas que envejecen** — ver abajo.                                                                                                                                                                                                         |

## Lo que estaba roto

**`npm run local:demo` fallaba.** Causa raiz: las fechas del fixture son absolutas y fueron
disenadas alrededor de `FIXTURE_REFERENCE_NOW` (`2026-08-13`). Corriendo hoy (`2026-09-03`,
~3 semanas despues) los cursos sinteticos avanzaron de semana y 4 de los 13 grupos se
reclasifican:

| Grupo            | Nivel esperado | Nivel real hoy |
| ---------------- | -------------- | -------------- |
| `SINT-ALERTA-S2` | ALERTA         | CRITICO        |
| `SINT-ALERTA-S3` | ALERTA         | CRITICO        |
| `SINT-NORMAL-S1` | NORMAL         | CRITICO        |
| `SINT-NORMAL-S2` | NORMAL         | CRITICO        |

Con eso el evaluador encuentra mas candidatos CRITICO que antes, agota `DAILY_QUOTA=5` antes
de llegar al grupo del demo (`TEST-9600`) y el demo aborta con
`No se creo un FOLLOWUP para el candidato demo`.

Los 92 tests seguian verdes porque **pinean el reloj** a `FIXTURE_REFERENCE_NOW` con
`vi.setSystemTime`; el demo usa el reloj real y por eso era el unico que lo detectaba. Es
decir: la suite no estaba mintiendo, pero tampoco cubria la deriva.

**Arreglo aplicado en esta fase** (minimo, sin tocar la logica de negocio): los registros del
fixture ahora llevan `_fixture_offset_init_days` / `_fixture_offset_end_days` /
`_fixture_offset_updated_days` y `FixtureTableroApiClient` reescribe
`init_course`/`end_course`/`updated_at` en cada `search()` relativos a "hoy". La clasificacion
del fixture queda estable corra cuando corra, y los tests que pinean el reloj siguen siendo
deterministas (los offsets se resuelven contra el reloj pineado). Ver ADR-009.

## Nota sobre la restriccion de plan Starter

Nada en el runtime local se dispara solo hoy: no hay cron, ni scheduler, ni poller, ni worker
de la cola. `sharedLocalQueue` solo se drena cuando alguien hace `POST /internal/dispatcher/*`.
La unica pieza automatica del repo es la `events.Rule` de `infra/` (no desplegada). El
`candidate-evaluator` si crea y encola en lote cuando se lo invoca a mano, asi que **no** es el
camino adecuado para el ciclo manual de una sola llamada — de ahi el servicio de disparo
manual que se construye en la Fase 1.
