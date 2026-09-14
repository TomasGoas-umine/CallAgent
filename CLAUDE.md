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

# Webhook post-call (cerrar el ciclo de la llamada)
npm run tunnel:up            # quick tunnel de cloudflared + escribe PUBLIC_BASE_URL en .env
npm run webhook:selftest     # verifica el circuito sin gastar un minuto de llamada
npm run webhook:selftest -- --conversation-id=conv_x   # reproduce una llamada real ya ocurrida
npm run providers:check      # §5 valida el registro del webhook contra la API de ElevenLabs

# Registro de llamadas por API (camino pull — no depende del webhook)
npm run calls:sync           # ElevenLabs + estado final en Twilio (solo GET)
npm run calls:sync -- --since=2026-09-01
npm run calls:sync -- --no-twilio    # solo conversaciones, sin consultar el estado final
npm run calls:sync -- --gracia=30    # minutos antes de considerar colgado un DIALING
npm run calls:sync -- --conversation-id=conv_x --followup-id=<uuid>   # atribucion manual

# Fixture del Semaforo (NO editar el JSON a mano)
npm run fixture:generate     # regenera test/fixtures/tablero_search_sample.json

# Semaforo: lectura en seco (no dispara nada)
npm run semaforo:probe                                    # contra el Mock
npm run semaforo:probe -- --http --base-url https://<gw>  # contra el API real
npm run semaforo:capture-sample -- --base-url https://<gw> --pages 3  # regenera el snapshot real

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

Los dos **persisten en `.dynamo-local-data/`** (dynalite con `path`, docker-compose con `-dbPath`

- volumen). No es un detalle cosmetico: en memoria, un reinicio borraba los items
  `CONVERSATION#<id> META` y el resultado de una llamada ya hecha se volvia irrecuperable — el
  webhook llega y no encuentra a quien atribuirlo (paso de verdad, UV-056). Para empezar de cero:
  `npm run local:down && rm -rf .dynamo-local-data`.

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

> ⚠️ **`npm run local:server` NO recarga al cambiar archivos** (`tsx` sin `--watch`). Si tocaste
> `src/` y el micrositio muestra tablas vacias o errores 404, casi seguro el server quedo
> corriendo codigo viejo: paralo y volve a levantarlo. **No se le puso `--watch` a proposito**:
> el store del Tablero Mock vive en memoria del proceso, asi que un reinicio automatico en cada
> guardado borraria las OCs que estas editando en pantalla. El micrositio ahora explica ese 404
> en vez de mostrar "Not Found" (`web/src/api.ts`).

- `src/local/api-routes.ts` — plugin de Fastify con `/api/health`, `/api/tablero`,
  `/api/calls`, `/api/calls/:id` y `POST /api/calls`. Es un **adaptador**: no decide nada de
  negocio, solo traduce HTTP y mapea el `status` tipado de `originateManualCall` a un codigo
  (403 / 429 / 503 / ...). Si necesitas una regla nueva, va en el servicio, no en la ruta.
- `src/services/manual-call.ts` — el disparo manual. No reimplementa guardrails: delega en
  `dispatchFollowup`, que revalida todo por su cuenta.
- `web/` — micrositio React + Vite, paquete independiente (su propio `package.json` y
  `node_modules`, no importa nada de `../src`). Cuatro vistas, en este orden: **Tablero Mock**,
  **Tablero Original**, **Dashboard**, **Disparador**. Ver `web/README.md` antes de tocarlo: hay
  decisiones deliberadas ahi (sin router, assets relativos, sin polling, telefonos de terceros
  enmascarados, modal de confirmacion obligatorio, guardado explicito por fila en el Mock).
- **El Tablero Original muestra las TRES secciones del Semaforo** (A Riesgo Conexion, B Riesgo
  DJ, C Rectificacion) en vinetas colapsables, de una sola lectura de `tablero-api`
  (`readSemaforoSecciones`). Las tres escalas son independientes y ninguna se calcula en el
  front: llegan resueltas en `GET /api/tablero/original`. B y C **no tienen camino a una
  llamada** en ningun modo (ADR-011): una DJ que falta o una OC Final que no llega se resuelven
  con el OTIC, no con el alumno.
- **El disparador si permite escribir el telefono a mano** (desplegable de autorizados + el del
  curso + input manual). Eso NO debilita nada: el guardrail de allowlist vive en el backend
  (`services/guardrails.ts`), asi que un numero fuera de `ALLOWLIST_NUMBERS` responde 403 igual.
  Lo que hace el front es avisar el motivo antes. **No muevas el chequeo de allowlist al front.**

**Hay TRES caminos para que el resultado de una llamada entre al proyecto, y comparten la misma
logica.** El que decide que pasa con un resultado es `services/call-result-recorder.ts`, uno
solo: clasifica, persiste el CALL e imprime la transicion de estado. Si agregas una regla, va
ahi — nunca en un handler ni en el sync.

1. **PULL (`services/conversation-sync.ts`) — el que funciona siempre.** Va a buscar el
   resultado a la API de ElevenLabs. Necesita UNA sola cosa: `ELEVENLABS_API_KEY`. Es
   idempotente, recupera hacia atras y lo dispara una persona: `npm run calls:sync`, o el boton
   **Sincronizar** del Dashboard (`POST /api/calls/sync`). Solo hace `GET` contra el proveedor:
   **no origina llamadas**, asi que no viola la regla 0 ni necesita el modal de confirmacion.
   1-bis. **TWILIO, dentro del mismo `calls:sync`** (`services/twilio-calls-client.ts` +
   `services/dialing-reconciler.ts`). Dos usos, los dos solo `GET`: (a) cruzar cada conversacion
   con su llamada para saber si el telefono llego a ser atendido, y (b) una **segunda pasada**
   sobre los FOLLOWUP en DIALING, que es el unico camino por el que se resuelven las llamadas
   que **no dejan conversacion** — esas no aparecen en la pasada 1 por definicion. Necesita
   `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` **de la misma cuenta que ElevenLabs usa para
   llamar**; sin ellas el sync corre igual y lo dice en el reporte.
2. **PUSH (`handlers/webhooks/elevenlabs-post-call`) — el preferido en produccion.** ElevenLabs
   entrega el resultado apenas termina la llamada. Depende de tres cosas encadenadas: URL
   publica viva, webhook registrado apuntando a **esa** url, y el secreto correcto. En local, un
   quick tunnel invalida las tres cada vez que se reinicia — por eso el registro de llamadas
   **no se apoya en el**. Circuito: `npm run tunnel:up` -> registrar
   `<PUBLIC_BASE_URL>/webhooks/elevenlabs/post-call` con auth **HMAC** -> asignarlo como
   post-call en Agents Platform -> Settings -> `npm run webhook:selftest` y
   `npm run providers:check` §5.

**Como se atribuye una conversacion a un FOLLOWUP** (`conversation-sync`, en este orden): el
item local `CONVERSATION#<id> META` que escribe el dispatcher, y si no esta, el `followup_id`
que viaja DENTRO de la conversacion en ElevenLabs (`dynamic_variables.followup_id`, lo manda el
dispatcher como `attributionId`). Si no hay ninguno de los dos **no se adivina**: se reporta
como no atribuible y no se toca nada. Atribuir por OC+telefono seria adivinar — dos intentos a
la misma OC son indistinguibles — y una atribucion equivocada ensucia el registro de otra
llamada. Para eso esta la atribucion manual (`--conversation-id` + `--followup-id`), donde
decide un humano.

**`user_id` NO sirve para atribuir**: parece el campo indicado ("ID of the end user") pero
ElevenLabs lo rellena por su cuenta — en las llamadas Twilio de esta cuenta quedo con el numero
de telefono, y en las pruebas del panel con un id de workspace. Por eso `extractAttributionId`
exige forma de UUID. Y por eso el `followup_id` se inyecta en `elevenlabs-client.ts` y **no** en
`buildAgentDynamicVariables`: esa funcion define el contrato conversacional del agente (siete
variables comparadas por igualdad estricta contra `sence-agent-config.ts` en un test) y ademas
alimenta el modal de confirmacion del micrositio.

**Nunca registres una conversacion que ElevenLabs todavia esta procesando**
(`initiated`/`in-progress`/`processing`). `recordCall` es una escritura condicional por
`conversation_id`: una version a medias no solo guarda basura, ademas GANA, y el resultado
definitivo se descarta despues como duplicado. Lo cubre `esConversacionFinal`.

**Lo que el payload real trae distinto del fixture** (verificado contra la cuenta, UV-055/060):
el `call_sid` de Twilio viaja en `metadata.phone_call.call_sid`, no en `metadata.call_sid` (se
aceptan ambos); el inicio en `metadata.start_time_unix_secs`; y `endedAt` se calcula como
inicio + duracion, NO desde `event_timestamp` — en un sync ese timestamp es "ahora" y fecharia
una llamada vieja como recien terminada. Y **el `data.status` real nunca es `no-answer`/`busy`**
— solo `initiated`/`in-progress`/`processing`/`done`/`failed` — asi que
`NOT_ANSWERED_STATUS_MAP` no se activa con payloads reales.

**Por eso la clasificacion le pregunta a Twilio, que es quien marco el numero** (UV-053): si su
`status` es `no-answer`/`busy`/`failed`/`canceled` ese resultado **manda** sobre lo que diga la
conversacion (`classifyTwilioCall`, en el mismo `call-outcome-classifier.ts` — no lo dupliques).
Si dice `completed`, decide la conversacion como siempre: Twilio no sabe de que se hablo. Reglas
que no se negocian: **no se adivina** (sin `call_sid` guardado el seguimiento se deja como esta y
se reporta por que), y un `completed` **sin** conversacion todavia disponible deja el FOLLOWUP en
DIALING — cerrarlo ahi tiraria la transcripcion que ElevenLabs esta procesando. El `call_sid` lo
persiste el dispatcher (`registrarIntentoSaliente`): sin el no hay por donde empezar, porque el
item `CONVERSATION#<id>` solo existe si hubo conversacion. El CALL sintetico se guarda como
`CALL#twilio:<CallSid>`, asi que reconciliar dos veces es idempotente por `call_sid` y no pisa la
conversacion real si aparece despues.

**La cuota diaria es persistente** (`QuotaRepository`, `QUOTA#<fecha> COUNTER` con `ADD`
condicional atomico) y la consume el dispatcher justo despues de la escritura condicional
READY->DIALING. No la cuentes en memoria en ningun lugar nuevo. Cuenta llamadas **originadas**,
no minutos (ver UV-044).

## Reglas de seguridad (no negociables)

0. **Ninguna llamada se dispara sola.** El plan de voz es Starter (muy pocos minutos). No
   agregues cron, scheduler, polling, worker de cola ni reintentos automaticos.
   **Solo dos caminos pueden originar una llamada**, los dos disparados por una accion humana:
   el **Disparador** (`POST /api/calls`) y el **Tablero Mock** (`PATCH` de una OC que produce
   una transicion hacia la condicion configurada, y solo con el interruptor de SU seccion
   encendido — hay uno por seccion de voz, ver abajo). Los dos
   terminan en `originateManualCall` -> `dispatchFollowup`. El **Tablero Original nunca llama**:
   es de solo lectura y su cliente HTTP no entra en ningun camino de originacion. El `candidate-evaluator` existe y se puede correr a
   mano, pero **su disparador no se habilita**. Ver `docs/architecture/DECISIONS.md` ADR-010.
   `infra/` todavia declara una `events.Rule` de cron: hay que deshabilitarla antes de
   desplegar (UV-042).
   0-bis. **Whitelist dura de la etapa de pruebas.** `guardrails.ts` rechaza con
   `fuera_de_whitelist_pruebas` (403) cualquier numero fuera de `TELEFONOS_ETAPA_PRUEBAS`
   (`src/utils/env.ts`), ademas de la allowlist. Hoy son **dos**: `+56956194817` y
   `+56955326503` — se amplio a pedido explicito del operador para poder probar con un segundo
   telefono. Es un cerrojo de etapa, no configuracion de operacion: no lo saques ni lo relajes
   sin una decision explicita, y agregar un numero es una de esas decisiones.
   `TEST_PHONE_WHITELIST` solo existe para que la suite use sus numeros sinteticos. Cada OC del
   Tablero Mock apunta a UNO de esos numeros (se elige por OC, ver abajo).
1. **Las llamadas reales se activan a mano, nunca por omision.** `MOCK_PROVIDERS=true` es el
   default. Con `MOCK_PROVIDERS=false` la factory exige `ALLOWLIST_NUMBERS`,
   `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` y
   `ELEVENLABS_WEBHOOK_SECRET`, y falla nombrando lo que falte antes de tocar la red.
   **Los tests NUNCA llaman de verdad**: usan `MockElevenLabsClient` o interceptan `fetch`
   (ver `test/unit/elevenlabs-real-client.spec.ts`). Antes del primer disparo real corre
   `npm run providers:check`, que valida todo con puros GET. Ver README, "Llamadas reales".
2. **No dupliques la logica del Semaforo.** Vive en exactamente cuatro modulos:
   `urgency-classifier.ts` (las TRES escalas: semana + umbrales de conexion, dias de DJ, dias de
   rectificacion), `order-status-promoter.ts` (promocion de estado + agregacion por OC),
   `semaforo-sections.ts` (los filtros de entrada de las tres secciones) y `course-lookup.ts`
   (los compone). Nada mas debe reimplementarla — en particular `web/`, donde hay un test que lo
   verifica (`web/test/sin-logica-semaforo.spec.ts`). Los cuatro son espejo del repo
   `micrositio-operaciones-tablero-sence`: un cambio de umbral alla exige el cambio equivalente
   aca. **Las tres escalas son independientes**: un CRITICO de conexion no equivale a uno de DJ,
   y mezclarlas da otro resultado (hay un test que lo fija). Contrato del API, paginacion y
   limitaciones: **`docs/SEMAFORO_INTEGRACION.md`**.
   2-bis. **A y B pueden originar llamadas; C no** (ADR-012, reemplaza parcialmente ADR-011).
   A sigue conexión; B sigue declaraciones juradas con el contacto responsable. `call-rules.ts`
   define la decisión y `course-lookup` compone los gates/clasificadores. No agregar reglas al
   trigger ni al frontend. A y B tienen umbrales de llamada independientes; ambos usan CRITICO por defecto.

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
- Hay DOS fixtures del Semaforo y prueban cosas distintas: `tablero_search_sample.json` prueba
  la CLASIFICACION (sintetico, con telefono, fechas relativas) y
  `tablero_search_real_anonymized.json` prueba el CONTRATO (snapshot anonimizado de prod, fechas
  absolutas, sin telefono — los tests pinean el reloj a su `captured_at`). El segundo se
  regenera con `npm run semaforo:capture-sample`, nunca a mano.
- `test/fixtures/tablero_search_sample.json` **se genera** (`npm run fixture:generate`, ver
  `scripts/generate-fixture.ts`). No lo edites a mano: son ~200 registros por alumno cuyo
  `pct_conexion` y semana de curso tienen que caer en bandas exactas. Sus fechas son
  **relativas a hoy** (`_fixture_offset_*_days`), no absolutas — ADR-009.
- Los cursos CRITICO del fixture declaran `_fixture_allowlist_slot` y el cliente resuelve su
  `phone_test_only` contra `ALLOWLIST_NUMBERS` en tiempo de lectura, para que el micrositio
  muestre un numero realmente llamable. Los ALERTA/NORMAL llevan numeros obviamente falsos.
- **Modo Mock y modo HTTP no se mezclan.** `buildTableroApiClient()` es la fuente de los
  caminos que llaman y con `TABLERO_API_MODE=fixture` devuelve el **Mock editable**
  (`MockTableroApiClient`), no el JSON del fixture — si devolviera el JSON, una OC recien editada
  a critica seria rechazada como `curso_no_critico` al revalidar. El Tablero Original construye
  su `HttpTableroApiClient` dentro de su propia ruta, a proposito.
- El store del Mock (`mock-tablero-store.ts`) es un **singleton de modulo en memoria**: los tests
  llaman `resetMockStore()` en `beforeEach`, y reiniciar el server lo devuelve al fixture.
- **En el Tablero Mock el telefono se elige POR OC**, entre los de `TELEFONOS_ETAPA_PRUEBAS` y
  nada mas (`updateMockOrder` valida contra lista cerrada; `runGuardrails` lo revalida igual). El
  selector vive en "Contexto del agente" del micrositio, pero el telefono **no es una
  `dynamic_variable`**: no entra en `buildAgentDynamicVariables` (contrato de ocho variables
  comparado por igualdad en un test) y no se le dice al interlocutor. El payload del Mock lleva
  `telefonos[]` con `do_not_call`/allowlist ya resueltos POR NUMERO — no hay mas campos globales
  de telefono, porque las OCs ya no comparten uno solo.
- **En el Tablero Mock el `orderStatus` no es un campo libre: lo mandan las fechas.**
  `promoteOrderStatus` deriva el estado de `init_course`/`end_course` salvo que sea DEAD o
  MANUAL, asi que `updateMockOrder` **rechaza** un estado que las fechas contradigan (elegir
  `NO INICIADA` con el inicio ya pasado) y, si solo se movieron las fechas, **corrige el estado y
  lo avisa** (`PatchResult.aviso`). Antes se guardaba: la UI mostraba `NO INICIADA` mientras el
  Semaforo promovia a `CURSO EN OPERACIÓN` y la OC seguia CRITICA, en seccion A y llamable — el
  control mentia. El backend expone `estadosCoherentes` por OC para que el desplegable pueda
  MARCAR los que no cuadran; no los deshabilita, porque un guardado puede mover estado y fechas
  de una sola vez.
- **El Tablero Mock tiene las TRES secciones del Semaforo**, en vinetas colapsables como el
  original, y son tres vistas del MISMO juego de OCs: cada OC se evalua por los tres criterios a
  la vez y puede estar en dos a la vez o en ninguna. Cada tabla edita los campos de SU criterio
  — A: estado/fechas/inscritos/conexiones; B: termino, conectados y `djs`; C: estado y
  `ultimaActualizacion`. **B tiene columna «¿Llama?»; C sigue sin llamadas** (regla 2-bis). Cada tabla lista todas las OCs, las de su seccion primero y el resto
  con el motivo de exclusion: es un editor, hace falta poder agarrar cualquier OC y llevarla a la
  seccion que se quiere probar.
- **`djs` se valida contra `conexiones`, no contra `inscritos`**: la seccion B divide DJ sobre
  CONECTADOS (`StatusCursosPage.tsx:587`). Permitir mas DJs que conectados daria porcentajes
  sobre 100 sin representar ningun escenario que el Semaforo muestre distinto.
- **`ultimaActualizacion` es el unico dato que mueve la seccion C.** Se escribe como `updated_at`
  en todos los registros que expande la OC. Antes `toRecords` ponia "ahora" en cada lectura, con
  lo cual los dias pendientes eran siempre 0 y la seccion C era inalcanzable.
- **El interruptor de llamadas automaticas del Mock es POR SECCION DE VOZ**, no global
  (`autoCallEnabled: Record<CallSection, boolean>`). Encender A no enciende B: son dos
  conversaciones distintas y el plan es Starter. `PUT /api/tablero/mock/auto-call` **exige**
  `seccion` y rechaza `C_RECTIFICACION` — no hay default, porque adivinar cual quiso mover el
  operador es como se termina llamando por el criterio equivocado. El trigger mira el
  interruptor de `evaluacion.seccion`, que es la misma seccion que viaja a
  `originateManualCall`.
- **`evaluateMockOrder` decide la seccion de voz UNA vez** (`seccion`), y de ahi salen el motivo
  del agente, las `dynamic_variables` y el interruptor que gobierna a esa OC. Antes el
  `gateSeccionB(...)` se evaluaba suelto en tres lugares y podian discrepar.
- **La criticidad del Semaforo no es configurable; los umbrales de LLAMADA si**
  (`call-rules.ts`). Son dos cosas distintas: ver docs/SEMAFORO_INTEGRACION.md §8-bis. Y los
  umbrales configurables son de **A y B**: B usa `dj.llamarSiDiasMayorA` y
  `dj.nivelesQueLlaman`. C no llama. Ver la auditoría B/C del 2026-09-11 en `docs/status/`.
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
  El cliente HTTP si esta verificado contra el contrato real (sobre `items`, paginacion por
  `nextCursor`/`hasMore`, `limit` de 2000): `npm run semaforo:probe -- --http --base-url <gw>`
  lo lee en seco sin disparar nada.
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
