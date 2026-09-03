# CLAUDE.md — Umine Voice

Guia para trabajar en este repo con Claude Code (o cualquier desarrollador nuevo). No es un
historial del proyecto — para eso esta `git log` y `docs/spec.csv`.

## Stack real

- **TypeScript** (ESM, `"type": "module"`, `moduleResolution: NodeNext`) — no Python.
- **Node 24 ARM64** es el target de produccion (patron Lambda de Umine). El sandbox donde se
  construyo este esqueleto solo tenia Node 22.19 disponible (via `nvm`) — funciona igual para
  desarrollo/tests, pero antes de desplegar de verdad, correr todo con Node 24 real al menos
  una vez.
- **npm** (gestor de paquetes) — mas simple, ya viene con Node, consistente con el boilerplate
  de Umine. No usar `pnpm`/`yarn` en este repo.
- **Vitest** (no Jest) — soporte ESM nativo sin configuracion adicional. `npx vitest run` /
  `npm test`.
- **Fastify** para el servidor local (`src/local/server.ts`) — no es parte del runtime Lambda,
  solo adapta HTTP a los mismos handlers que correrian en API Gateway.
- **AWS CDK v2** en `infra/` — construido, NO desplegado en esta sesion (regla no negociable).

## Comandos

```bash
npm install

# Calidad
npm run build          # tsc --noEmit
npm run lint           # eslint . --max-warnings=0
npm run format:check   # prettier --check .
npm test               # vitest run (unit + integration)
npm run test:unit
npm run test:integration

# Entorno local
npm run local:up             # levanta DynamoDB local (ver nota Docker/dynalite abajo)
npm run local:create-tables  # crea la tabla single-table + GSI1/GSI2
npm run local:seed           # siembra CONTACT.do_not_call para el escenario de prueba
npm run local:server         # levanta el server Fastify (puerto LOCAL_SERVER_PORT, default 3000)
npm run local:demo           # corre el flujo end-to-end contra el server (requiere que ya este arriba)
npm run local:down           # detiene DynamoDB local

# Fixture del Semaforo (NO editar el JSON a mano)
npm run fixture:generate     # regenera test/fixtures/tablero_search_sample.json

# Micrositio de operacion (web/)
npm run web:install
npm run web:dev              # Vite en :5173, proxea /api al server local
npm run web:build            # tsc --noEmit + vite build
npm run web:test             # vitest + jsdom
```

### Nota sobre DynamoDB local: Docker vs `dynalite`

El prompt original pide `docker-compose -f docker-compose.local.yml up -d` (DynamoDB Local
real via Docker — `docker-compose.local.yml` esta en el repo para eso). El sandbox donde se
construyo este esqueleto **no tenia Docker instalado**, asi que `npm run local:up` en realidad
levanta `dynalite` (implementacion pura JS de la API de DynamoDB, sin Docker/Java) como proceso
hijo en background, escuchando en el mismo `DYNAMODB_ENDPOINT` del `.env`. Ambos hablan el
mismo protocolo AWS SDK — el resto del codigo no distingue cual esta corriendo. Si tu entorno
si tiene Docker, preferible usar `docker-compose -f docker-compose.local.yml up -d` (mas fiel a
lo que sera producción real) — no se verifico en esta sesion que ambos se comporten
identicos en el 100% de los casos (ver `docs/architecture/DECISIONS.md` ADR-007).

### Correr el demo end-to-end paso a paso

```bash
cp .env.example .env
# Edita .env:
#   DRY_RUN=false                          (el default es true — "no encolar nada" a proposito)
#   ALLOWLIST_NUMBERS=+56900100141         (telefono del candidato demo, ver mas abajo)
#   ELEVENLABS_WEBHOOK_SECRET=cualquier-valor-para-local
#   RETRY_BACKOFF_SECONDS_OVERRIDE=1       (opcional, acelera reintentos si los pruebas)
#   BUSINESS_HOURS_START / _END            (solo si corres el demo fuera de 09:00-19:00 Santiago,
#                                            ver nota de guardrail mas abajo)

npm run local:up
npm run local:create-tables
npm run local:seed
npm run local:server &     # dejalo corriendo en background o en otra terminal
npm run local:demo
```

`local:demo` es idempotente/re-corrible: resetea el estado del candidato demo (idempotencia +
cooldown) antes de correr, asi que se puede ejecutar varias veces seguidas sin tener que
limpiar la base a mano.

**Sobre el guardrail de ventana horaria**: `runGuardrails` compara la hora real contra
`BUSINESS_HOURS_START`/`_END` (America/Santiago) — es una regla real, no un mock. Si corres el
demo fuera de 09:00-19:00 hora de Santiago, el dispatcher va a reagendar en vez de llamar (eso
es correcto). Para poder demostrar el flujo completo a cualquier hora del dia durante
desarrollo, es valido ampliar temporalmente `BUSINESS_HOURS_START=00:00` /
`BUSINESS_HOURS_END=23:59` en tu `.env` local — **nunca hagas esto en un entorno que se acerque
a produccion real**, ahi el guardrail debe reflejar el horario real acordado con negocio.

## Operar a mano: la API y el micrositio

El camino que se usa en el dia a dia es el manual:

```bash
npm run local:up && npm run local:create-tables && npm run local:seed
npm run local:server         # API en :3000
npm run web:dev              # micrositio en :5173 (en otra terminal)
```

- `src/local/api-routes.ts` — plugin de Fastify con `/api/health`, `/api/tablero`,
  `/api/calls`, `/api/calls/:id` y `POST /api/calls`. Es un **adaptador**: no decide nada de
  negocio, solo traduce HTTP y mapea el `status` tipado de `originateManualCall` a un codigo
  (403 / 429 / 503 / ...). Si necesitas una regla nueva, va en el servicio, no en la ruta.
- `src/services/manual-call.ts` — el disparo manual. No reimplementa guardrails: delega en
  `dispatchFollowup`, que revalida todo por su cuenta.
- `web/` — micrositio React + Vite, paquete independiente (su propio `package.json` y
  `node_modules`, no importa nada de `../src`). Ver `web/README.md` antes de tocarlo: hay
  decisiones deliberadas ahi (sin router, assets relativos, sin polling, telefonos de terceros
  enmascarados en el tablero, modal de confirmacion obligatorio).
- **El disparador si permite escribir el telefono a mano** (desplegable de autorizados + el del
  curso + input manual). Eso NO debilita nada: el guardrail de allowlist vive en el backend
  (`services/guardrails.ts`), asi que un numero fuera de `ALLOWLIST_NUMBERS` responde 403 igual.
  Lo que hace el front es avisar el motivo antes. **No muevas el chequeo de allowlist al front.**

**La cuota diaria es persistente** (`QuotaRepository`, `QUOTA#<fecha> COUNTER` con `ADD`
condicional atomico) y la consume el dispatcher justo despues de la escritura condicional
READY->DIALING. No la cuentes en memoria en ningun lugar nuevo. Cuenta llamadas **originadas**,
no minutos (ver UV-044).

## Reglas de seguridad (no negociables)

0. **Ninguna llamada se dispara sola.** El plan de voz es Starter (muy pocos minutos). No
   agregues cron, scheduler, polling, worker de cola ni reintentos automaticos. La unica
   originacion es `POST /api/calls` -> `originateManualCall` -> `dispatchFollowup`, una vez por
   cada vez que un humano aprieta el boton. El `candidate-evaluator` existe y se puede correr a
   mano, pero **su disparador no se habilita**. Ver `docs/architecture/DECISIONS.md` ADR-010.
   `infra/` todavia declara una `events.Rule` de cron: hay que deshabilitarla antes de
   desplegar (UV-042).
1. **Nunca llames de verdad a Twilio/ElevenLabs.** `MOCK_PROVIDERS=true` es el default en
   local y en tests. Si se activa `MOCK_PROVIDERS=false`, `elevenlabs-client.factory.ts` exige
   ademas `ALLOWLIST_NUMBERS` no vacia — nunca se activa el cliente real por omision.
2. **No dupliques la logica de urgencia/promocion de estado.** Vive en
   `urgency-classifier.ts` + `order-status-promoter.ts` — nada mas debe reimplementarla.
3. **`.env.example` solo lleva nombres de variables**, nunca valores reales. Revisa `git diff`
   antes de cada commit.
4. **Todo lo que pueda reintentarse debe ser idempotente**: creacion de FOLLOWUP (escritura
   condicional `attribute_not_exists(PK)`), transicion READY->DIALING (condicional), webhook
   post-call (idempotente por `conversation_id`).
5. El logger (`src/utils/logger.ts`) enmascara telefonos (`***1234`) y trunca cualquier string
   largo (candidato a transcripcion) — nunca loguear el payload crudo de un webhook sin pasar
   por `logger.*`.

## Convenciones no evidentes

- Los handlers (`src/handlers/**/handler.ts`) exportan tanto una funcion "de negocio" testeable
  (`runCandidateEvaluator`, `dispatchFollowup`, `handleElevenLabsPostCall`) como (cuando aplica)
  un `handler()` delgado que la llama — separacion pensada para poder inyectar dependencias en
  tests de integracion sin mockear modulos completos.
- Los repositorios reciben `tableName` y un `DynamoDBDocumentClient` opcionales en el
  constructor — en produccion usan el default (`env.tableName` + cliente compartido); en tests
  se inyecta una tabla/cliente de `dynalite` aislado por test (ver
  `test/integration/test-dynamo-harness.ts`).
- El webhook de ElevenLabs solo trae `conversation_id`, nunca nuestro `followup_id` — por eso
  existe el item `CONVERSATION#<id> META -> { followupId }` (no estaba en el prompt original,
  se agrego durante la implementacion; ver `docs/architecture/ARCHITECTURE.md`).
- Los tests que necesitan una fecha fija para que la clasificacion de urgencia sea determinista
  usan `vi.useFakeTimers({ toFake: ['Date'] })` — **nunca fakear todos los timers** cuando el
  test tambien habla por HTTP con `dynalite` (fakear `setTimeout`/`setImmediate` cuelga las
  requests indefinidamente).
- `test/fixtures/tablero_search_sample.json` **se genera** (`npm run fixture:generate`, ver
  `scripts/generate-fixture.ts`). No lo edites a mano: son ~200 registros por alumno cuyo
  `pct_conexion` y semana de curso tienen que caer en bandas exactas. Sus fechas son
  **relativas a hoy** (`_fixture_offset_*_days`), no absolutas — ADR-009.
- Los cursos CRITICO del fixture declaran `_fixture_allowlist_slot` y el cliente resuelve su
  `phone_test_only` contra `ALLOWLIST_NUMBERS` en tiempo de lectura, para que el micrositio
  muestre un numero realmente llamable. Los ALERTA/NORMAL llevan numeros obviamente falsos.
- Las `dynamic_variables` del agente viven en `src/services/agent-variables.ts` — las usa el
  dispatcher al llamar y las expone `GET /api/tablero`, para que el modal de confirmacion
  muestre exactamente lo que se va a enviar. No las armes en el front.
- `docs/status/` guarda los inventarios de estado del repo (que corre, que es stub, que se
  arreglo). `docs/status/INVENTARIO-2026-09-03.md` es el mas reciente.
- `FIXTURE_REFERENCE_NOW` (`test/fixtures/reference-time.ts`) sigue siendo el "ahora" al que
  los tests pinean el reloj, pero ya **no** es el ancla de las fechas del fixture: los offsets se
  resuelven contra el reloj vigente (pineado o real). Ver `test/fixtures/README.md`.

## Flujo de testing

- **Unitario** (`test/unit/`): logica pura, sin red ni DynamoDB — clasificador de urgencia,
  promotor de estado, guardrails, idempotency key, validadores de firma, taxonomia de llamada.
- **Integracion** (`test/integration/`): usa `dynalite` real (no mocks del SDK) para verificar
  escrituras condicionales, GSIs, y los 3 handlers completos (evaluator/dispatcher/webhook).
- **Nunca** un test llama de verdad a Twilio/ElevenLabs — siempre `MockElevenLabsClient` o
  fixtures.
- **API** (`test/integration/api-routes.spec.ts`): usa `fastify.inject()`, sin abrir puerto.
  Cada test de rechazo verifica ademas que el proveedor NO se invoco y que la cuota no se movio.
- **Front** (`web/test/`): vitest + jsdom + testing-library. El test central es que el
  micrositio **no dispara sin pasar por el modal de confirmacion**.
- Si inyectas repositorios en un test del dispatcher, inyecta **todos** los que usa
  (`followupRepository` Y `quotaRepository`): el que falte se instancia contra
  `env.tableName` + `DYNAMODB_ENDPOINT` reales y el test deja de estar aislado.
- Antes de un PR: `npm run build && npm run lint && npm run format:check && npm test` y, si
  tocaste `web/`, `npm run web:build && npm run web:test`.

## Decisiones arquitectonicas vigentes (resumen — detalle completo en `docs/architecture/DECISIONS.md`)

- Integracion ElevenLabs<->Twilio nativa (Opcion A) — sin servidores WebSocket persistentes.
- `TableroApiClient` en modo fixture por defecto — el real (`tablero-api`) no expone telefono.
- Cola en memoria en vez de SQS FIFO/ElasticMQ para el MVP local.
- **ADR-009**: las fechas del fixture son relativas a hoy (el fixture no envejece).
- **ADR-010**: originacion solo manual — sin cron, scheduler, polling ni reintentos
  automaticos; cuota diaria persistente y atomica.
- Varias decisiones de negocio (a quien llamar, disclosure de IA, grabacion, numero chileno)
  siguen **abiertas** — modeladas como configuracion, nunca hardcodeadas. Ver prompt §9 y
  `docs/spec.csv` (tickets UV-023 a UV-028).

## Gotchas

- `npx eslint`/`tsc` pueden reportar el paquete `dynalite` sin tipos — ya resuelto con
  `src/types/dynalite.d.ts` (ambient module declaration), no se necesita `@types/dynalite`
  (no existe).
- `npm audit` reporta vulnerabilidades en `esbuild`/`vite` (transitivas de Vitest, solo
  afectan al dev server, no al runtime de produccion) — no se forzo un upgrade breaking en
  esta sesion, queda para revisar en el proximo `npm run lint`/mantenimiento de dependencias.
- El engine declarado es `"node": ">=24 <25"` pero el sandbox de esta sesion instalo con
  Node 22.19 (`npm warn EBADENGINE`) — funciona, pero no reemplaza probarlo con Node 24 real
  antes de desplegar.
