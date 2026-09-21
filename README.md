# Umine Voice (CallAgent)

Agente de voz que lee el **Semaforo operacional de Umine** (el tablero que vigila los cursos
SENCE), detecta las Ordenes de Compra en riesgo, llama por telefono a la persona responsable via
**Twilio + ElevenLabs**, conversa con ella y registra el resultado para seguimiento o derivacion
a un humano.

Este repo es el **MVP local**: un backend TypeScript + un **micrositio de operacion** (`web/`)
para disparar y revisar llamadas a mano. Corre entero en tu maquina, sin AWS y — por defecto —
sin gastar un minuto de telefono.

> ## Ninguna llamada se dispara sola
>
> El plan de voz es **Starter**: muy pocos minutos. Por eso **no hay cron, ni scheduler, ni
> polling, ni reintentos automaticos** habilitados (ADR-010).
>
> **Solo dos caminos pueden originar una llamada, y los dos nacen de un click de una persona:**
>
> 1. el **Disparador** del micrositio (`POST /api/calls`), con modal de confirmacion obligatorio;
> 2. el **Tablero Mock**, cuando guardas una OC (`PATCH .../mock/orders/...`) y ese cambio la
>    empuja a una condicion llamable — y **solo si el interruptor de SU seccion esta encendido**
>    (`src/services/mock-call-trigger.ts`).
>
> Los dos terminan en `originateManualCall` -> `dispatchFollowup`, que revalida **todo** por su
> cuenta. El **Tablero Original nunca llama**: es de solo lectura.
>
> Ademas hay una **whitelist dura de la etapa de pruebas** (`TELEFONOS_ETAPA_PRUEBAS` en
> `src/utils/env.ts`): hoy solo pueden sonar `+56956194817` y `+56955326503`. Cualquier otro
> numero se rechaza con `fuera_de_whitelist_pruebas` (403) **aunque este en la allowlist**. Es un
> cerrojo de etapa: no lo saques ni agregues numeros sin una decision explicita.
>
> `infra/` (CDK, **no desplegado**) todavia declara una `events.Rule` de cron para el evaluador:
> **hay que deshabilitarla antes de cualquier despliegue** (UV-042).

## Documentacion

| Archivo                                 | Para que                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `CLAUDE.md`                             | Comandos, convenciones y reglas de seguridad. **Leelo si vas a tocar codigo** |
| `docs/context/PROJECT_CONTEXT.md`       | Contexto de negocio: que es el Semaforo, SENCE, las DJ                        |
| `docs/context/ESTADO-PROYECTO.md`       | Resumen del proyecto entero, para pegar en otra herramienta                   |
| `docs/SEMAFORO_INTEGRACION.md`          | Contrato del `tablero-api`, paginacion, umbrales y limitaciones               |
| `docs/architecture/ARCHITECTURE.md`     | Modelo de datos single-table, handlers, flujo                                 |
| `docs/architecture/DECISIONS.md`        | ADRs (por que las cosas son como son)                                         |
| `docs/architecture/CALL-HISTORY.md`     | Historial del agente y conexion del webhook local                             |
| `docs/architecture/ELEVENLABS-AGENT.md` | El agente de ElevenLabs: prompt, variables y como configurarlo                |
| `docs/PRUEBAS_MANUALES_AGENTE.md`       | Guia de casos de prueba con el Tablero Mock                                   |
| `docs/spec.csv`                         | Backlog completo (67 tickets, 17 abiertos)                                    |
| `docs/status/`                          | Inventarios y auditorias fechadas                                             |
| `web/README.md`                         | El micrositio y sus decisiones deliberadas                                    |

## Quickstart

Node 24 (el `package.json` declara `>=24 <25`; con 22 funciona pero avisa).

```bash
npm install
cp .env.example .env         # los defaults ya son seguros: MOCK_PROVIDERS=true

npm run local:up             # DynamoDB local (dynalite; o Docker, ver CLAUDE.md)
npm run local:create-tables
npm run local:seed
npm run local:server         # API en http://localhost:3000

# en otra terminal: el micrositio
npm run web:install
npm run web:dev              # http://localhost:5173
```

Con eso ya se opera a mano, en **modo simulacion**: el disparador funciona de punta a punta pero
contra `MockElevenLabsClient` — no suena ningun telefono. Para llamar de verdad, ver
[Llamadas reales](#llamadas-reales-salir-del-modo-simulacion).

> ⚠️ **`npm run local:server` no recarga solo** (`tsx` sin `--watch`, a proposito: el store del
> Tablero Mock vive en memoria del proceso). Si tocaste `src/` y el micrositio muestra tablas
> vacias o 404, el server quedo con codigo viejo: paralo y volve a levantarlo.

## Como funciona

El recorrido completo de una llamada, de punta a punta:

```
  Semaforo (tablero-api real, o el Mock editable)
        |
        v
  course-lookup ──► urgency-classifier  (nivel del Semaforo: NORMAL/ALERTA/CRITICO)
        |        └► semaforo-sections   (a que seccion pertenece la OC: A / B / C)
        |        └► call-rules          (¿esto amerita una LLAMADA?)
        v
  [una persona hace click]  Disparador  ó  guardado del Tablero Mock
        |
        v
  originateManualCall ──► guardrails ──► dispatchFollowup
        |                 kill switch, whitelist dura, allowlist, do_not_call,
        |                 ventana horaria, cuota diaria, idempotencia, cooldown
        v
  FOLLOWUP READY ──(escritura condicional)──► DIALING
        |
        v
  ElevenLabs origina la llamada por Twilio  →  conversacion con la persona
        |
        v
  El resultado vuelve por PUSH (webhook) o por PULL (`calls:sync`)
        |
        v
  call-result-recorder: clasifica, guarda el CALL, mueve el FOLLOWUP
        (CERRADO / FOLLOW_UP / ESCALADO / RESUELTO / ...)
```

Dos ideas que conviene tener claras antes de leer el codigo:

- **El nivel del Semaforo y la decision de llamar son cosas distintas.**
  `urgency-classifier.ts` es un espejo 1:1 del Semaforo real y **no se configura** (si se pudiera,
  el tablero dejaria de mostrar lo mismo que el original). `call-rules.ts` decide si esa situacion
  amerita una llamada, y **eso si es configurable**. Por defecto coinciden: llama en CRITICO.
- **Un solo modulo decide que pasa con un resultado**: `services/call-result-recorder.ts`. Entre
  por webhook, por sync o por reconciliacion con Twilio, la logica es la misma. Una regla nueva va
  ahi, nunca en un handler.

### El Semaforo: tres secciones, dos motivos de llamada

La misma OC se evalua por **tres criterios independientes a la vez** y puede caer en dos secciones
o en ninguna. Las tres escalas no se mezclan (un CRITICO de conexion no es un CRITICO de DJ).

| Seccion                 | Que mira                                                                      | Escala                                                            | ¿Llama? |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| **A — Riesgo Conexion** | Curso en ejecucion, sin terminar, con `% de conexion` incompleto              | Semana del curso vs. umbral (S2 <55%, S3 <80%, S4 <90% = CRITICO) | **Si**  |
| **B — Riesgo DJ**       | Curso ya terminado, con alumnos conectados y Declaraciones Juradas pendientes | Dias desde el cierre (>3 ALERTA, >7 CRITICO)                      | **Si**  |
| **C — Rectificacion**   | OC en ESPERA/RECTIFICACION hace mas de 3 dias                                 | Dias esperando al OTIC                                            | **No**  |

**C no llama nunca** (ADR-011): una OC Final que no llega se resuelve con el OTIC, no con el
alumno. **A y B si** (ADR-012): son dos motivos de conversacion distintos para el mismo agente
(`riesgo_conexion_critico` y `riesgo_dj_critico`), con umbrales de llamada independientes.

La logica del Semaforo vive en exactamente cuatro modulos y **no debe reimplementarse en ningun
otro lado** (hay un test en `web/` que lo verifica): `urgency-classifier.ts`,
`order-status-promoter.ts`, `semaforo-sections.ts` y `course-lookup.ts`, que los compone.

### Las cuatro vistas del micrositio

| Vista                | Que es                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tablero Mock**     | OCs simuladas y **editables en la tabla**, con las tres secciones. Es el banco de pruebas: moves los datos y ves como reacciona el Semaforo. Puede originar llamadas (secciones A y B) si enciendes el interruptor de esa seccion |
| **Tablero Original** | El dato **real** de `tablero-api`, estrictamente de lectura, con las tres secciones. No crea candidatos, ni seguimientos, ni llamadas                                                                                             |
| **Dashboard**        | Los seguimientos con estado, resultado clasificado, campos extraidos y transcripcion. Boton **Sincronizar**. Incluye el **Historial del agente** (todas las conversaciones de ElevenLabs, incluso las que no nacieron aca)        |
| **Disparador**       | Elegir una OC llamable + un telefono, ver el modal de confirmacion y disparar UNA llamada                                                                                                                                         |

El Disparador deja **escribir el telefono a mano** a proposito. Eso no debilita nada: el guardrail
vive en el backend (`services/guardrails.ts`), asi que un numero no autorizado responde 403 igual.
Lo que hace el front es avisar el motivo antes. **No muevas ese chequeo al front.**

Detalle de las decisiones del micrositio (guardado explicito por fila, sin router, telefonos de
terceros enmascarados, modal obligatorio): `web/README.md`.

## API de operacion

Todo lo que expone `npm run local:server` en `:3000`. Es un **adaptador**: no decide nada de
negocio, solo traduce HTTP y mapea el `status` tipado del servicio a un codigo.

### Tablero y llamadas

| Metodo | Ruta                    | Que hace                                                                                                                                                                         |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`           | Kill switch, `DRY_RUN`, `MOCK_PROVIDERS`, modo del tablero, cuota usada/restante, ventana horaria, allowlist, estado del webhook y del sync                                      |
| GET    | `/api/tablero`          | Las OCs candidatas a llamada, con urgencia, seccion, semana, % conexion, DJ pendientes, contacto, telefono enmascarado y las `dynamic_variables` exactas que recibiria el agente |
| GET    | `/api/tablero/original` | El Semaforo real (`tablero-api`), tres secciones, solo lectura. `?refresh=1` fuerza relectura                                                                                    |
| POST   | `/api/calls`            | **Dispara UNA llamada manual.** `Idempotency-Key` obligatoria                                                                                                                    |
| POST   | `/api/calls/sync`       | Trae los resultados desde la API de ElevenLabs (+ Twilio). Solo `GET` contra los proveedores: **no origina llamadas**                                                            |
| GET    | `/api/calls`            | Seguimientos con su ultimo resultado clasificado                                                                                                                                 |
| GET    | `/api/calls/:id`        | Detalle del seguimiento + todas sus llamadas con transcripcion                                                                                                                   |

### Tablero Mock (el banco de pruebas)

| Metodo | Ruta                                              | Que hace                                                                                                                    |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/tablero/mock`                               | Las OCs editables, ya evaluadas por las tres secciones                                                                      |
| PATCH  | `/api/tablero/mock/orders/:clientId/:orderNumber` | Guarda una OC. **Puede originar una llamada** si el cambio la vuelve llamable y el interruptor de su seccion esta encendido |
| POST   | `/api/tablero/mock/reset`                         | Devuelve el store al fixture                                                                                                |
| PUT    | `/api/tablero/mock/auto-call`                     | Enciende/apaga el disparo automatico **por seccion**. Exige `seccion`; rechaza `C_RECTIFICACION`                            |
| PUT    | `/api/tablero/mock/call-rules`                    | Cambia los umbrales de **llamada** (no los del Semaforo)                                                                    |
| POST   | `/api/tablero/mock/call-rules/reset`              | Vuelve a los umbrales por defecto                                                                                           |

### Historial del agente

| Metodo | Ruta                           | Que hace                                                              |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| GET    | `/api/agent-history`           | Todas las conversaciones guardadas del agente, con filtros            |
| GET    | `/api/agent-history/:id`       | Transcripcion, evaluacion, datos extraidos, metadatos                 |
| GET    | `/api/agent-history/:id/audio` | Audio, cuando ElevenLabs indica que existe (no se guarda copia local) |
| POST   | `/api/agent-history/sync`      | Importa el historial anterior desde ElevenLabs. Solo lectura          |

### Webhooks e internos

`POST /webhooks/elevenlabs/post-call` (firma HMAC obligatoria) y `POST /webhooks/twilio/status`.
Ademas hay rutas `/internal/*` (evaluador, dispatcher, inspeccion de la cola) que existen **solo
para el demo y los tests manuales** — no son parte de la operacion.

### Codigos de `POST /api/calls`

Body: `clientId`, `orderNumber`, `phone` (obligatorios) y `seccion` opcional
(`A_RIESGO_CONEXION` por defecto, o `B_RIESGO_DJ`). La `Idempotency-Key` va en el header.

| Codigo | Cuando                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------- |
| 201    | La llamada se origino (`dialing`)                                                               |
| 200    | La misma `Idempotency-Key` ya se uso (`already_processed`) — no se origina una segunda          |
| 400    | Falta `Idempotency-Key`, falta `clientId`/`orderNumber`/`phone`, o `seccion` no soportada       |
| 403    | `no_en_allowlist`, **`fuera_de_whitelist_pruebas`** (whitelist dura) o `do_not_call`            |
| 404    | La OC ya no aparece en el Semaforo (`curso_no_encontrado`)                                      |
| 409    | Fuera de la ventana horaria, la OC ya no amerita llamada (`curso_no_critico`), o `no_originada` |
| 429    | Cuota diaria agotada                                                                            |
| 503    | `KILL_SWITCH=true`                                                                              |
| 502    | El proveedor rechazo la originacion                                                             |

## Como vuelve el resultado de una llamada

Hay **tres caminos**, y los tres pasan por el mismo `call-result-recorder.ts`.

### 1. PULL — `npm run calls:sync` (el que funciona siempre)

```bash
npm run calls:sync
npm run calls:sync -- --since=2026-09-01
npm run calls:sync -- --no-twilio                 # solo conversaciones
npm run calls:sync -- --gracia=30                 # minutos antes de dar por colgado un DIALING
npm run calls:sync -- --conversation-id=conv_x --followup-id=<uuid>   # atribucion manual
```

Va a buscar a la API de ElevenLabs el resultado de las llamadas que ya terminaron y lo registra:
transcripcion, resumen, campos extraidos, criterios de evaluacion, `call_sid`, duracion, costo y
motivo de corte. Necesita **una sola cosa**: `ELEVENLABS_API_KEY`. Tambien esta el boton
**Sincronizar** del Dashboard (`POST /api/calls/sync`).

### 1-bis. Twilio, dentro del mismo `calls:sync`

Si hay credenciales de Twilio, ademas **le pregunta a Twilio como termino realmente la llamada**.
Resuelve dos cosas que ElevenLabs no puede:

- **Clasificar bien una llamada que nadie atendio.** El `status` de ElevenLabs nunca dice
  `no-answer` ni `busy`, asi que una llamada sin atender parecia una conversacion vacia y se
  cerraba como "contactado". Si Twilio dice `no-answer`/`busy`/`failed`/`canceled`, **ese resultado
  manda**. Si dice `completed`, decide la conversacion como siempre.
- **Destrabar los seguimientos colgados en `DIALING`.** Las llamadas que no dejan ninguna
  conversacion no aparecen en el listado de ElevenLabs. Una segunda pasada revisa cada FOLLOWUP en
  `DIALING` contra el `call_sid` que guardo el dispatcher.

Las credenciales tienen que ser de **la misma cuenta de Twilio** que usa ElevenLabs, o los
`call_sid` no se encuentran. Sin ellas el sync corre igual y lo dice en el reporte.

Nada de esto adivina: sin `call_sid`, o si el SID no existe en esa cuenta, el seguimiento se deja
como esta y el reporte dice por que. Y un `completed` cuya conversacion todavia no entrega
ElevenLabs tampoco se cierra — el resultado bueno esta por llegar.

Todo es `GET`: no origina llamadas, no gasta minutos, es idempotente y no necesita URL publica.

**Como se atribuye una conversacion a un seguimiento**, en este orden: el item local
`CONVERSATION#<id> META` que escribe el dispatcher, y si no esta, el `followup_id` que viaja dentro
de la conversacion en ElevenLabs. Lo que no puede atribuir con certeza **no lo toca**: lo reporta
como no atribuible, porque una atribucion equivocada ensucia el registro de otra llamada. Para eso
existe la atribucion manual (`--conversation-id` + `--followup-id`), donde decide un humano.

> Las conversaciones que no origino este proyecto (pruebas desde el panel de ElevenLabs) siempre
> apareceran como no atribuibles. Es correcto: no traen ninguna referencia a una OC.

### 2. PUSH — webhook post-call (el camino de produccion)

Con el webhook el resultado entra solo apenas termina la llamada. A cambio depende de tres cosas
encadenadas: una URL publica **viva**, un webhook registrado apuntando a **esa** URL, y el secreto
correcto. En local, con un quick tunnel, las tres se invalidan al reiniciarlo — por eso el registro
de llamadas **no se apoya en el**.

```bash
npm run webhook:connect      # tunel + registro HMAC + asignacion al agente (requiere webhooks_write)
# o, a mano:
npm run tunnel:up            # solo el tunel; escribe PUBLIC_BASE_URL en .env
npm run webhook:configure    # solo el registro, con el tunel ya abierto
```

Si lo haces desde el panel de ElevenLabs (**Settings -> Webhooks -> Create webhook**):

- **URL**: `https://<tu-tunel>/webhooks/elevenlabs/post-call`
- **Auth type**: `HMAC` — el handler no valida ningun otro metodo.
- El **secreto** que ElevenLabs muestra una sola vez va en `ELEVENLABS_WEBHOOK_SECRET`.
- Activalo como **post-call webhook** en **Agents Platform -> Settings**. Crearlo no alcanza: si no
  queda asignado ahi, ElevenLabs no le entrega nada. Un agente puede tener su propio override.

Verificalo **sin gastar un minuto de llamada**:

```bash
npm run webhook:selftest     # firma valida -> 200, firma invalida -> 401
npm run webhook:selftest -- --conversation-id=conv_x    # reproduce una llamada real ya ocurrida
npm run providers:check      # §5: que el webhook exista, este activo, sea HMAC y este asignado
```

Despues de registrar el webhook hay que **reiniciar `npm run local:server`** para que cargue el
secreto nuevo.

## Llamadas reales (salir del modo simulacion)

Por defecto `MOCK_PROVIDERS=true`: el disparador simula y no se gasta un minuto. Para llamar de
verdad hacen falta cuatro cosas, en este orden.

### 1. Una cuenta de ElevenLabs con un agente y un numero importado

- **Un agente** (Agents Platform -> Agents). Su `agent_id` va en `ELEVENLABS_AGENT_ID`.
- **Un numero de Twilio importado** (Phone Numbers -> _Import from Twilio_). Ahi ElevenLabs te pide
  el Account SID y el Auth Token de Twilio y guarda el numero del lado suyo; el `phone_number_id`
  va en `ELEVENLABS_AGENT_PHONE_NUMBER_ID`. Asigna ese numero al agente.
- **Una API key** (Settings -> API Keys) con acceso a Agents Platform, en `ELEVENLABS_API_KEY`.
  Para el historial y el webhook necesita ademas leer conversaciones y `webhooks_write`.

Importante: **la llamada la origina ElevenLabs, no este backend.** Nosotros solo hacemos
`POST /v1/convai/twilio/outbound-call` (integracion nativa, ADR-003). Las credenciales de Twilio de
nuestro `.env` se usan para validar la firma del webhook de status y, sobre todo, para que
`calls:sync` pueda preguntar como termino cada llamada.

El contrato conversacional (las variables que el agente espera recibir) vive en
`src/services/agent-variables.ts` y se verifica contra el agente remoto, sin llamar a nadie, con:

```bash
npm run agent:check        # compara el contrato con el agente activo
npm run agent:configure    # escribe la configuracion del agente desde el repo
```

### 2. Que el resultado vuelva

Ver [Como vuelve el resultado](#como-vuelve-el-resultado-de-una-llamada). Lo que conviene tener
andando primero es `calls:sync`: no depende de nada mas que la API key.

### 3. Validar TODO antes de gastar un minuto

```bash
npm run providers:check
```

Hace solo lecturas (`GET`), no llama a nadie. Verifica la API key, lista tus agentes y numeros
importados, confirma que los IDs del `.env` existen de verdad, chequea las credenciales de Twilio y
avisa de configuraciones riesgosas (ventana horaria de 24h, cuenta Twilio en Trial, etc.). Resolve
todos los `FALTA` antes de seguir.

### 4. Activar

```bash
# en .env
MOCK_PROVIDERS=false
```

Reinicia `npm run local:server`. El banner del micrositio pasa a **rojo** avisando que las llamadas
son reales, y el boton del modal dice "Llamar de verdad".

**La primera llamada, a tu propio numero.** Los guardrails siguen todos activos: solo pueden sonar
los numeros de `TELEFONOS_ETAPA_PRUEBAS` que ademas esten en `ALLOWLIST_NUMBERS`, con `DAILY_QUOTA`
llamadas por dia, dentro de la ventana horaria, y `KILL_SWITCH=true` corta todo al instante.

### Cosas que muerden

- **Cuenta Twilio en Trial**: solo llama a numeros _verificados_ en Twilio (Console -> Phone Numbers
  -> Verified Caller IDs). `providers:check` te avisa si detecta Trial.
- **Regulacion chilena (UV-027)**: Twilio exige numeros `+56 600` / `+56 809` con KYC local para
  comunicaciones automatizadas. Es un bloqueante externo, no tecnico — para probar contra tu propio
  numero normalmente no aparece, pero si antes de llamarle a un cliente.
- **Ventana horaria**: `runGuardrails` compara contra la hora real de Santiago. Si tu `.env` local
  la tiene en `00:00-23:59` (comodo para probar), volvela a `09:00-19:00` antes de llamar a alguien
  que no seas vos.
- **`CALL_RECORDING_ENABLED`**: default `false` (UV-026, decision de negocio abierta). Se manda
  explicito en cada request, no se hereda de la config del agente.
- **Un seguimiento colgado en `DIALING` casi nunca es un bug**: es que el resultado no volvio. Corre
  `npm run calls:sync`. Si aparece como no atribuible, esa conversacion no la origino este proyecto.
  Si aparece como `sin_datos`, el seguimiento se origino antes de que se guardara el `call_sid` (o
  el SID es de otra cuenta): hay que mirarlo en el log de Twilio y atribuirlo a mano.
- **"No contestaron" lo resuelve Twilio, no ElevenLabs (UV-053)**: el `data.status` real solo toma
  `initiated`/`in-progress`/`processing`/`done`/`failed`. **Sin `TWILIO_ACCOUNT_SID`/
  `TWILIO_AUTH_TOKEN`** (o con credenciales de otra cuenta), una llamada sin atender sigue cayendo
  como `contacted` -> `CERRADO`: el webhook por si solo no alcanza para distinguirla.
- **`DRY_RUN` solo afecta al evaluador en lote**, **no** al disparador manual: no te protege de una
  llamada real disparada desde el micrositio. El que te protege es `MOCK_PROVIDERS`.
- **La base local persiste en `.dynamo-local-data/`.** Si corre en memoria, un reinicio borra los
  items `CONVERSATION#<id>` y el resultado de una llamada ya hecha se vuelve irrecuperable
  (UV-056). Para empezar de cero: `npm run local:down && rm -rf .dynamo-local-data`.

## Configuracion

Todas las variables estan en `.env.example` (**solo nombres, nunca valores reales**). Las que mas
importan:

| Variable                     | Default           | Para que                                                       |
| ---------------------------- | ----------------- | -------------------------------------------------------------- |
| `MOCK_PROVIDERS`             | `true`            | **El interruptor que decide si se llama de verdad**            |
| `KILL_SWITCH`                | `false`           | Corta toda originacion al instante                             |
| `ALLOWLIST_NUMBERS`          | vacio             | Unicos numeros marcables (primera barrera)                     |
| `TEST_PHONE_WHITELIST`       | los dos de etapa  | Whitelist dura. **Solo la sobreescribe la suite de tests**     |
| `DAILY_QUOTA`                | `5`               | Llamadas **originadas** por dia. Es persistente y atomica      |
| `BUSINESS_HOURS_START/_END`  | `09:00` / `19:00` | Ventana horaria (`TIMEZONE`, `America/Santiago`)               |
| `TABLERO_API_MODE`           | `fixture`         | `fixture` = Tablero Mock editable; `http` = `tablero-api` real |
| `DRY_RUN`                    | `true`            | Solo el evaluador en lote                                      |
| `CALL_RECORDING_ENABLED`     | `false`           | Grabacion de audio (decision de negocio abierta)               |
| `MOCK_CALL_COOLDOWN_SECONDS` | `300`             | Enfriamiento entre disparos del Tablero Mock, **por OC**       |

## Calidad

```bash
npm run build          # tsc --noEmit
npm run lint           # eslint . --max-warnings=0
npm run format:check
npm test               # 402 tests en 27 archivos (unit + integracion contra dynalite real)

npm run web:build      # tsc --noEmit + vite build del micrositio
npm run web:test       # 80 tests del front (vitest + jsdom)
```

Antes de un PR: los cuatro de arriba, y los dos de `web/` si tocaste el micrositio.

- **Unitario** (`test/unit/`): logica pura — clasificador de urgencia, secciones, reglas de llamada,
  guardrails, idempotencia, validadores de firma, taxonomia de resultados.
- **Integracion** (`test/integration/`): `dynalite` real (no mocks del SDK) para verificar
  escrituras condicionales, GSIs, los handlers completos y la API via `fastify.inject()`. Cada test
  de rechazo verifica ademas que el proveedor **no** se invoco y que la cuota no se movio.
- **Front** (`web/test/`): el test central es que el micrositio no dispara sin pasar por el modal de
  confirmacion, y que no reimplementa la logica del Semaforo.

**Ningun test llama de verdad a Twilio/ElevenLabs** — siempre `MockElevenLabsClient` o `fetch`
interceptado. Tampoco el demo, ni el micrositio en modo local.

### Herramientas de lectura en seco

```bash
npm run semaforo:probe                                     # lee el Semaforo contra el Mock
npm run semaforo:probe -- --http --base-url https://<gw>   # contra el API real, sin disparar nada
npm run fixture:generate                                   # regenera el fixture (NO editarlo a mano)
```

## Estado actual (2026-09-21)

**Modo simulacion, operable de punta a punta.** El Semaforo completo (tres secciones), el Tablero
Mock editable, el disparo manual con todos los guardrails, el registro de llamadas por los tres
caminos y el historial del agente estan implementados y con tests. `infra/` (CDK) esta construido
pero **no desplegado**.

Pendientes que hay que tener en cuenta (backlog completo en `docs/spec.csv`, 17 tickets abiertos):

| Ticket     | Que falta                                                                                               | Impacto                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **UV-042** | La `events.Rule` de cron en `infra/` sigue declarada                                                    | **Bloqueante de despliegue**: contradice "ninguna llamada se dispara sola"       |
| UV-027     | Twilio exige numeros `+56 600`/`+56 809` con KYC local en Chile                                         | Bloqueante externo antes de llamar a un cliente real                             |
| UV-043     | La API no tiene autenticacion ni se definio como se embebe en el core                                   | No exponer mas alla de localhost hasta resolverlo                                |
| UV-051     | Webhook post-call: el circuito existe, falta dejarlo estable                                            | En local un quick tunnel lo invalida al reiniciarse; `calls:sync` cubre el hueco |
| UV-023..28 | Decisiones de negocio abiertas: a quien llamar, fuente del telefono, disclosure de IA, grabacion, cuota | Modeladas como **configuracion**, nunca hardcodeadas                             |
| UV-031     | Validar que DynamoDB Local (Docker) se comporte igual que `dynalite`                                    | Solo afecta al entorno de desarrollo                                             |
