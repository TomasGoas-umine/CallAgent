# Umine Voice — estado del proyecto (2026-09-03)

Documento de contexto pensado para pegarse en otra herramienta (por ejemplo el "project
knowledge" de Claude en el navegador, que no comparte contexto con Claude Code). Se mantiene a
mano; si algo de aca contradice el codigo, **el codigo manda**.

---

## 1. Que es esto en una frase

Agente de voz que detecta cursos SENCE con riesgo critico de conexion en el "Semaforo"
operacional de Umine, y permite que un humano dispare una llamada telefonica automatizada
(ElevenLabs + Twilio) que conversa con el contacto del cliente, obtiene un compromiso y deja el
resultado clasificado y persistido.

**Repo:** `~/Umine/agente-sence/CallAgent` · rama `dev` · nada pusheado mas alla del commit
inicial (`origin/dev` sigue en `f2c7d32`).

---

## 2. Contexto de negocio

Umine es una OTEC chilena que gestiona cursos financiados por SENCE. Cada curso es una Orden de
Compra (OC) de un cliente, con alumnos que **deben conectarse a la plataforma SENCE** durante el
curso para justificar la franquicia tributaria y evitar objeciones (DJ).

El **"Semaforo"** (repo `micrositio-operaciones-tablero-sence`, backend `tablero-api`) es el
tablero donde operaciones ve, por curso, si la conexion va atrasada respecto de lo esperado para
la semana de curso en que esta. Clasifica en `NORMAL` / `ALERTA` / `CRITICO`.

Hoy esa deteccion y el contacto son **100% manuales**. Umine Voice automatiza el primer contacto
para el caso mas urgente: **Seccion A — Riesgo Conexion — nivel CRITICO**.

### Umbrales de clasificacion (portados 1:1 del Semaforo, NO reinterpretar)

| Semana de curso | Esperado | ALERTA si >= | CRITICO si < |
| --------------- | -------- | ------------ | ------------ |
| 1               | 20%      | 20%          | (nunca)      |
| 2               | 60%      | 55%          | 55%          |
| 3               | 90%      | 80%          | 80%          |
| 4               | 98%      | 90%          | 90%          |

La semana de curso se calcula por progreso temporal: `<0.25` → 1, `<0.5` → 2, `<0.75` → 3, resto
→ 4. Vive solo en `src/services/urgency-classifier.ts`.

### Hechos heredados de la auditoria de `tablero-api` (verificados, no opiniones)

- **No existe campo de telefono** en ningun punto de la cadena
  `po -> pod -> execution-sence -> tablero-api`, ni del alumno ni del encargado de
  capacitacion. Tampoco existe `do_not_call`. Este es el bloqueante de negocio numero uno.
- **Paginacion rota**: `GET /tablero/search` siempre devuelve `nextCursor: null`, limite
  hardcodeado de 15000 registros, puede fallar con `Function.ResponseSizeTooLarge` sobre ~6MB.
- **Autenticacion debil**: solo valida presencia de un Bearer de Firebase, no la firma.
- Umine Voice trata a tablero-api como **fuente de solo lectura** y nunca le escribe.

---

## 3. Restriccion central del diseno

> **Ninguna llamada se dispara sola.**

El plan de voz es **Starter** (muy pocos minutos). Por eso **no hay cron, ni scheduler, ni
polling, ni worker de cola, ni reintentos automaticos habilitados**. La unica originacion es un
humano apretando un boton: `POST /api/calls` → `originateManualCall` → `dispatchFollowup`.

Esto esta documentado como **ADR-010**. El `candidate-evaluator` (flujo automatico en lote del
BPMN) existe y se puede correr a mano, pero **su disparador no se habilita**.

Cada disparo pasa, sin excepcion, por: revalidacion contra el Semaforo, allowlist, ventana
horaria, cuota diaria persistente y una escritura condicional anti doble disparo.

---

## 4. Stack

- **TypeScript** ESM (`"type": "module"`, `moduleResolution: NodeNext`). No Python.
- **Node 24** es el target; la maquina de desarrollo corre 22.19 (`EBADENGINE`, funciona).
- **npm** (no pnpm/yarn) · **Vitest** (no Jest).
- **Fastify** para el server local (`src/local/server.ts`) — adaptador HTTP, no es el runtime
  Lambda.
- **DynamoDB single-table** con GSI1/GSI2. En local, **dynalite** (no hay Docker en la maquina).
- **AWS CDK v2** en `infra/` — construido, **nunca desplegado ni sintetizado**.
- **Front:** React 19 + Vite 7 en `web/`, sin libreria de UI, CSS plano prefijado `uv-`.
  Paquete independiente: su propio `package.json` y `node_modules`, no importa nada de `../src`.

---

## 5. Arquitectura

```
Semaforo (tablero-api)          ← solo lectura, hoy via FIXTURE
   │
   ├─ course-lookup ──── urgency-classifier + order-status-promoter
   │
Micrositio web/ ──HTTP──▶ /api/* (Fastify)
   │                        │
   │                        ├─ GET  /api/health    modo, cuota, allowlist, webhook
   │                        ├─ GET  /api/tablero   15 cursos clasificados
   │                        ├─ GET  /api/calls     followups + resultado
   │                        ├─ GET  /api/calls/:id detalle + transcripcion
   │                        └─ POST /api/calls ──▶ originateManualCall
   │                                                    │
   │                                              dispatchFollowup
   │                                                    │ revalida todo
   │                                                    ▼
   │                                        ElevenLabs (nativo Twilio)
   │                                                    │
   └───── webhook post-call ◀───────────────────────────┘  (HOY SIN CONFIGURAR)
                │
          DynamoDB single-table
```

**ADR-003:** integracion ElevenLabs↔Twilio **nativa** (Opcion A). ElevenLabs origina la llamada;
nuestro backend solo hace `POST /v1/convai/twilio/outbound-call`. No hay servidor WebSocket
persistente. Por eso las credenciales de Twilio que importan son las que se le dieron a
ElevenLabs al importar el numero; las del `.env` solo sirven para validar la firma del webhook
de status de Twilio (opcional).

### Modelo de datos (single-table)

| Item                           | Para que                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| `FOLLOWUP#<id> META`           | la unidad de trabajo central                                              |
| `FOLLOWUP#<id> CALL#<conv_id>` | un intento de llamada, con transcripcion y resultado                      |
| `CONVERSATION#<id> META`       | mapeo inverso conv_id → followupId (el webhook solo trae conversation_id) |
| `CONTACT#<telefono> META`      | `do_not_call` (permanente) y `last_contacted_at`                          |
| `IDEMP#<key> LOCK`             | anti duplicado, `attribute_not_exists(PK)`                                |
| `QUOTA#<fecha> COUNTER`        | cuota diaria persistente, `ADD` condicional atomico                       |
| GSI1 `ESTADO#<estado>`         | "que toca llamar" + listar followups sin `scan`                           |
| GSI2 `DEST#<telefono>`         | cooldown por destinatario                                                 |

### Guardrails (un solo modulo: `src/services/guardrails.ts`)

Kill switch → ventana horaria (dias habiles, sin feriados) → allowlist → cuota diaria. Se corren
**dos veces**: pre-chequeo en `manual-call` (para dar un motivo HTTP preciso antes de escribir
nada) y revalidacion real dentro de `dispatchFollowup`. **El gate efectivo es siempre el del
backend.**

La cuota cuenta **llamadas originadas, no minutos** (los minutos solo se conocen cuando llega el
webhook, y ahi ya se gastaron). Se consume con `ADD` condicional **despues** de la escritura
condicional `READY→DIALING`, para no gastar un slot si otro worker se llevo el followup.

---

## 6. Que esta implementado y verificado

| Pieza                                                 | Estado                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Clasificacion de urgencia y promocion de estado de OC | portadas 1:1, un solo modulo cada una                                   |
| Guardrails centralizados                              | kill switch, ventana horaria, allowlist, cuota                          |
| Cuota diaria persistente y atomica                    | `QuotaRepository`, dia de negocio (TIMEZONE)                            |
| Idempotencia                                          | `sha256(...)` para el evaluador; key del cliente para el disparo manual |
| Disparo manual de UNA llamada                         | `originateManualCall`, unico camino de originacion                      |
| `call-dispatcher`                                     | revalida Semaforo + guardrails, `READY→DIALING` condicional, backoff    |
| Webhook post-call de ElevenLabs                       | firma HMAC, idempotente por `conversation_id`, clasifica y transiciona  |
| Taxonomia de resultado                                | 13 valores, `call-outcome-classifier.ts`                                |
| Transcripcion                                         | se **persiste** en el item CALL; nunca se loguea                        |
| API de operacion `/api/*`                             | 5 endpoints, adaptador puro                                             |
| Micrositio (3 vistas)                                 | Tablero, Dashboard, Disparador                                          |
| Fixture de 15 cursos                                  | generado desde `semaforo_test_samples.csv`                              |
| `providers:check`                                     | preflight de credenciales sin gastar llamadas                           |
| Cliente real de ElevenLabs                            | endurecido, con 11 tests que interceptan `fetch`                        |

**Calidad:** 130 tests backend (15 archivos) + 27 front (2 archivos). `build`, `lint` y
`format:check` limpios en ambos paquetes.

### Stub o no implementado

- `webhooks/twilio-status` — valida firma y loguea, **no reconcilia nada** (UV-030).
- `ESCALATION` — `domain/escalation.ts` modelado, **sin repositorio**: escalar solo deja el
  FOLLOWUP en `ESCALADO` + un log (UV-029).
- `HttpTableroApiClient` — construido pero **inactivo** por decision (no hay telefono real).
- `infra/` — CDK construido, nunca desplegado.

---

## 7. Estado operativo AHORA MISMO

|                          |                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `MOCK_PROVIDERS`         | **false — LLAMADAS REALES habilitadas**                                                                             |
| ElevenLabs               | API key valida · agente **"Sence"** (`agent_5201m1f6e9ccfb6t5gafcw2azzrk`, idioma `es`)                             |
| Numero                   | importado como `phnum_0801m1hx5xt1eh1brn67ams7c4jh` y asignado al agente. Es un numero **de EE.UU.** (`+1 260…`)    |
| Twilio                   | cuenta Full (no Trial), activa · **Chile habilitado** en Geo Permissions                                            |
| `ALLOWLIST_NUMBERS`      | 2 numeros personales del operador (solo se puede llamar a esos)                                                     |
| `DAILY_QUOTA`            | 5 llamadas originadas por dia                                                                                       |
| Ventana horaria          | `00:00-23:59` en local (abierta 24h **a proposito para probar**; volver a `09:00-19:00` antes de llamar a terceros) |
| `CALL_RECORDING_ENABLED` | `false`, mandado explicito en cada request                                                                          |
| `KILL_SWITCH`            | `false`                                                                                                             |
| Webhook post-call        | **SIN configurar — diferido a proposito (UV-051)**                                                                  |
| Semaforo                 | modo `fixture` (15 cursos sinteticos + 3 reales des-identificados)                                                  |

### Variables que espera el agente "Sence"

`nombre_interlocutor`, `nombre_cliente`, `nombre_curso`, `dias_restantes`, `pct_conexion`
(+ `orden_compra` y `motivo` como extras). ElevenLabs **exige que el payload traiga todas** las
que el agente define; si falta una, la llamada falla o el agente lee el `{{placeholder}}` en voz
alta. Se construyen en un solo lugar: `src/services/agent-variables.ts`. **Si alguien agrega una
variable al prompt del agente, hay que agregarla ahi tambien** — `providers:check` no lo detecta.

---

## 8. Consecuencia del webhook diferido (leer antes de reportar un bug)

Con `MOCK_PROVIDERS=false` y sin webhook configurado:

- la llamada **suena y conversa** normalmente;
- pero el resultado **nunca vuelve**: el FOLLOWUP se queda en `DIALING` para siempre, sin
  transcripcion, sin campos extraidos y sin clasificacion.

**Esto no es un bug.** `GET /api/health` lo reporta en `webhookPostCall` y el banner del
micrositio lo avisa. Para cerrarlo hacen falta tres cosas:

1. un tunel (`cloudflared tunnel --url http://localhost:3000` o ngrok) — **ninguno instalado**;
2. `PUBLIC_BASE_URL` en `.env`;
3. registrar `https://<tunel>/webhooks/elevenlabs/post-call` en ElevenLabs (Settings →
   Webhooks) y guardar el **secreto de firma que se muestra una sola vez** en
   `ELEVENLABS_WEBHOOK_SECRET` (hoy tiene el placeholder `demo-local-secret`).

---

## 9. Backlog: 52 tickets (35 DONE)

### Bloqueantes / alta prioridad

| Ticket     | Que falta                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **UV-051** | Webhook post-call sin configurar (diferido a proposito). Ver §8                                                                       |
| **UV-042** | `infra/` todavia declara una `events.Rule` de cron para el evaluador. **Bloqueante de despliegue**: contradice ADR-010                |
| **UV-024** | No existe fuente de telefono real. Bloquea salir del modo fixture                                                                     |
| **UV-023** | A quien se llama: alumno, encargado de capacitacion, o ambos (propuesta: encargado, sin confirmar)                                    |
| **UV-027** | Twilio exige numeros `+56 600`/`+56 809` con KYC local en Chile para comunicaciones automatizadas. Bloqueante **externo**, no tecnico |

### Decisiones de negocio abiertas

`UV-025` disclosure de IA al destinatario (asumido: si, siempre, primer mensaje — falta legal) ·
`UV-026` grabacion de audio (asumido: no en el piloto) · `UV-028` confirmar cuota/ventana/
intentos default · `UV-044` si la cuota debe medir minutos en vez de llamadas · `UV-043` como se
embebe el micrositio y su autenticacion (**hoy la API no tiene ninguna**) · `UV-048` si el
tablero puede exponer telefonos reales de terceros.

### Deuda tecnica

`UV-029` repositorio de ESCALATION · `UV-030` reconciliacion en `twilio-status` · `UV-031`
validar contra `dynamodb-local` real (Docker) · `UV-045` unificar el conteo de cuota del
evaluador con `QuotaRepository` · `UV-017` / `UV-022` stubs declarados.

---

## 10. Decisiones de arquitectura (ADRs)

| ADR | Decision                                                                              |
| --- | ------------------------------------------------------------------------------------- |
| 001 | TypeScript, no Python                                                                 |
| 002 | Patron de repositorio adaptado de `umine-core-ms-dhl` (solo la forma, no la logica)   |
| 003 | Integracion ElevenLabs↔Twilio **nativa** — sin WebSocket persistente                  |
| 004 | Fixture en vez de la API real de tablero-api (no hay telefono)                        |
| 005 | Cola en memoria en vez de SQS FIFO para el MVP local                                  |
| 006 | Decisiones de negocio pendientes modeladas como **configuracion**, nunca hardcodeadas |
| 007 | `dynalite` en vez de `dynamodb-local` via Docker (no hay Docker en la maquina)        |
| 008 | npm + Vitest                                                                          |
| 009 | **Fechas del fixture relativas a hoy** — el fixture no envejece                       |
| 010 | **Originacion solo manual** — sin cron/scheduler/polling; cuota persistente y atomica |

---

## 11. Reglas que no se deben romper

1. **Ninguna llamada se dispara sola.** No agregar cron, scheduler, polling, worker de cola ni
   reintentos automaticos.
2. **Las llamadas reales se activan a mano, nunca por omision.** Los **tests nunca** llaman de
   verdad: usan `MockElevenLabsClient` o interceptan `fetch`.
3. **No duplicar la logica de urgencia ni de promocion de estado.** Viven solo en
   `urgency-classifier.ts` y `order-status-promoter.ts`.
4. **`.env.example` solo lleva nombres**, nunca valores reales. El `.env` esta gitignoreado.
5. **Todo lo reintentable es idempotente** (escrituras condicionales de DynamoDB).
6. **El logger enmascara telefonos y omite transcripciones.** Nunca loguear un payload crudo de
   webhook.
7. **El chequeo de allowlist vive en el backend.** El front lo adelanta como UX; no es la
   barrera. El disparador **si** permite escribir el telefono a mano — eso no debilita nada.
8. **`test/fixtures/tablero_search_sample.json` se genera** (`npm run fixture:generate`). No
   editarlo a mano.

---

## 12. Comandos

```bash
# Entorno local
npm run local:up && npm run local:create-tables && npm run local:seed
npm run local:server          # API en :3000
npm run web:dev               # micrositio en :5173 (proxea /api)
npm run local:down

# Proveedores
npm run providers:check       # valida credenciales SIN gastar una llamada

# Fixture
npm run fixture:generate

# Calidad
npm run build && npm run lint && npm run format:check && npm test
npm run web:build && npm run web:test
```

---

## 13. Bugs reales encontrados y corregidos en la sesion del 2026-09-03

Utiles como contexto de que tipo de fallo aparece en este proyecto:

1. **Fixture que envejecia** — fechas absolutas; 3 semanas despues 4 de 13 grupos se
   reclasificaban solos y `local:demo` fallaba. La suite no lo veia porque pinea el reloj.
   → ADR-009, fechas relativas.
2. **Cuota diaria en memoria** — se reiniciaba con el proceso. Inaceptable con plan Starter.
   → `QuotaRepository` persistente y atomico.
3. **Transcripcion descartada** — el webhook la recibia y no la guardaba.
4. **Test sin aislar** — el dispatcher instanciaba su `QuotaRepository` contra el DynamoDB local
   real porque el test no lo inyectaba.
5. **`local:demo` no determinista** — identificaba su curso por telefono, y varios cursos
   comparten el mismo numero de prueba a proposito. → ahora por `orderNumber`.
6. **Precargado de telefono que no dejaba borrar el campo** — vivia en un efecto que reaccionaba
   a "el campo esta vacio". → ahora pasa una sola vez.
7. **Cliente real que daba por exitosa una llamada fallida** — miraba solo el HTTP status; un
   `200` con `success: false`, o sin `conversation_id`, dejaba el followup colgado en `DIALING`
   con cuota gastada.
8. **`dynamic_variables` desalineadas con el agente real** — habria hecho fallar la primera
   llamada real.
