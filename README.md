# Umine Voice

Agente de voz que detecta situaciones urgentes en el "Semaforo" operacional de Umine (riesgo
de conexion de alumnos a SENCE), llama via Twilio + ElevenLabs, conversa con la persona, y
registra el resultado para seguimiento o derivacion a un humano.

Este repo contiene el **MVP local**: backend TypeScript + un **micrositio de operacion**
(`web/`) para disparar y revisar llamadas a mano. Se prueba 100% en local, sin AWS real y sin
llamadas reales.

> ## Ninguna llamada se dispara sola
>
> El plan de voz es **Starter**: muy pocos minutos. Por eso **no hay cron, ni scheduler, ni
> polling, ni reintentos automaticos** habilitados. La unica forma de originar una llamada es
> que una persona apriete el boton en el micrositio (`POST /api/calls`). Cada disparo pasa por
> revalidacion contra el Semaforo, allowlist, ventana horaria, cuota diaria persistente y una
> escritura condicional anti doble disparo. Si vas a tocar algo de esto, lee primero
> `CLAUDE.md` y `docs/architecture/DECISIONS.md` (ADR-010).
>
> `infra/` (CDK, **no desplegado**) todavia declara una `events.Rule` de cron para el
> evaluador: **hay que deshabilitarla antes de cualquier despliegue** (ticket UV-042).

Documentacion: `CLAUDE.md` (comandos, convenciones y reglas de seguridad) ·
`docs/context/PROJECT_CONTEXT.md` (contexto de negocio) · `docs/architecture/` (arquitectura y
ADRs) · `docs/bpmn/` (diagramas de proceso) · `docs/spec.csv` (backlog) ·
`docs/status/` (inventarios de estado) · `web/README.md` (micrositio).

## Quickstart

```bash
npm install
cp .env.example .env   # editar segun CLAUDE.md antes de correr

npm run local:up             # DynamoDB local (dynalite o Docker, ver CLAUDE.md)
npm run local:create-tables
npm run local:seed
npm run local:server         # API en http://localhost:3000

# en otra terminal: el micrositio
npm run web:install
npm run web:dev              # http://localhost:5173
```

Con eso ya se puede operar a mano: la pestana **Tablero** muestra los 15 cursos del Semaforo,
**Disparador** dispara una llamada (simulada) y **Dashboard** muestra el resultado.

El flujo automatico (evaluador en lote) sigue existiendo y se puede probar con
`npm run local:demo` — ver `CLAUDE.md`.

## API de operacion

| Metodo | Ruta             | Que hace                                                                                           |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`    | Kill switch, `DRY_RUN`, `MOCK_PROVIDERS`, cuota usada/restante, ventana horaria, allowlist         |
| GET    | `/api/tablero`   | Los 15 cursos con urgencia, semana, % de conexion, dias restantes, contacto y telefono enmascarado |
| GET    | `/api/calls`     | Followups con su ultimo resultado clasificado                                                      |
| GET    | `/api/calls/:id` | Detalle del followup + todas sus llamadas con transcripcion                                        |
| POST   | `/api/calls`     | **Dispara UNA llamada manual.** `Idempotency-Key` obligatoria                                      |

Codigos de `POST /api/calls`:

| Codigo | Cuando                                                                                 |
| ------ | -------------------------------------------------------------------------------------- |
| 201    | La llamada se origino (`dialing`)                                                      |
| 200    | La misma `Idempotency-Key` ya se uso (`already_processed`) — no se origina una segunda |
| 400    | Falta `Idempotency-Key` o falta `clientId`/`orderNumber`/`phone`                       |
| 403    | El numero no esta en la allowlist, o el destinatario esta `do_not_call`                |
| 404    | La OC ya no aparece en el Semaforo                                                     |
| 409    | Fuera de la ventana horaria, o el curso ya no es CRITICO                               |
| 429    | Cuota diaria agotada                                                                   |
| 503    | `KILL_SWITCH=true`                                                                     |
| 502    | El proveedor rechazo la originacion                                                    |

## Estado actual (2026-09-03)

**Modo simulacion.** `MOCK_PROVIDERS=true`: el disparador funciona de punta a punta pero contra
`MockElevenLabsClient`, sin gastar minutos. Para llamar de verdad, ver la seccion siguiente.

Pendientes con los que hay que contar antes de dar esto por cerrado:

| Ticket     | Que falta                                                                                                                                                          | Impacto                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UV-051** | **Webhook post-call sin configurar — DIFERIDO a proposito.** Requiere un tunel + `PUBLIC_BASE_URL` + registrar la URL en ElevenLabs y guardar su secreto de firma. | Con llamadas reales, cada FOLLOWUP queda en `DIALING` para siempre: no llega transcripcion, ni campos extraidos, ni clasificacion. `GET /api/health` lo reporta en `webhookPostCall` y el banner del micrositio lo avisa. |
| UV-042     | La `events.Rule` de cron en `infra/` sigue declarada                                                                                                               | Bloqueante de despliegue: contradice "ninguna llamada se dispara sola"                                                                                                                                                    |
| UV-043     | La API no tiene autenticacion                                                                                                                                      | No exponer mas alla de localhost hasta resolverlo                                                                                                                                                                         |
| UV-027     | Twilio exige numeros `+56 600`/`+56 809` con KYC local en Chile                                                                                                    | Bloqueante externo antes de llamar a un cliente real                                                                                                                                                                      |

Backlog completo en `docs/spec.csv`.

## Llamadas reales (salir del modo simulacion)

Por defecto `MOCK_PROVIDERS=true`: el disparador simula y no se gasta un minuto. Para llamar de
verdad hacen falta cuatro cosas, y conviene hacerlas en este orden.

### 1. Una cuenta de ElevenLabs con un agente y un numero importado

En el panel de ElevenLabs:

- **Un agente** (Agents Platform -> Agents). Su `agent_id` va en `ELEVENLABS_AGENT_ID`.
- **Un numero de Twilio importado** (Agents Platform -> Phone Numbers -> _Import from Twilio_).
  Ahi ElevenLabs te pide el **Account SID** y el **Auth Token** de Twilio, y guarda el numero
  del lado suyo. El `phone_number_id` que queda va en `ELEVENLABS_AGENT_PHONE_NUMBER_ID`.
  Asigna ese numero al agente.
- **Una API key** (Settings -> API Keys) con acceso a Agents Platform. Va en
  `ELEVENLABS_API_KEY`.

Importante: **la llamada la origina ElevenLabs, no este backend.** Nosotros solo hacemos
`POST /v1/convai/twilio/outbound-call` (integracion nativa, ADR-003). Por eso las credenciales
de Twilio que importan son las que le diste a ElevenLabs; las de nuestro `.env` solo se usan
para validar la firma del webhook de status de Twilio, que es opcional.

### 2. Una URL publica para el webhook post-call

Sin esto **la llamada ocurre pero el resultado nunca vuelve**: el FOLLOWUP se queda en `DIALING`
para siempre, sin transcripcion ni clasificacion. El server corre en localhost, asi que hace
falta un tunel:

```bash
# opcion A: cloudflared (gratis, sin cuenta)
cloudflared tunnel --url http://localhost:3000
# opcion B: ngrok
ngrok http 3000
```

Copia la URL `https://...` que te devuelve a `PUBLIC_BASE_URL` en el `.env`, y registrala en
ElevenLabs (Settings -> Webhooks, post-call):

```
https://<tu-tunel>/webhooks/elevenlabs/post-call
```

ElevenLabs te muestra **una sola vez** el secreto de firma al crear el webhook: ese valor va en
`ELEVENLABS_WEBHOOK_SECRET`. El backend rechaza con 401 cualquier webhook cuya firma HMAC no
cuadre, asi que si el secreto esta mal no vas a ver el resultado de la llamada.

### 3. Validar TODO antes de gastar un minuto

```bash
npm run providers:check
```

Hace solo lecturas (`GET`), no llama a nadie. Verifica la API key, lista tus agentes y numeros
importados, confirma que los IDs del `.env` existen de verdad, chequea las credenciales de
Twilio y avisa de configuraciones riesgosas (ventana horaria 24h, cuenta Twilio en Trial, etc.).
Resolve todos los `FALTA` antes de seguir.

### 4. Activar

```bash
# en .env
MOCK_PROVIDERS=false
```

Reinicia `npm run local:server`. El banner del micrositio pasa a **rojo** avisando que las
llamadas son reales, y el boton del modal dice "Llamar de verdad".

**La primera llamada, a tu propio numero.** Los guardrails siguen todos activos: solo se puede
marcar a `ALLOWLIST_NUMBERS`, con `DAILY_QUOTA` llamadas por dia, dentro de la ventana horaria,
y `KILL_SWITCH=true` corta todo al instante.

### Cosas que muerden

- **Cuenta Twilio en Trial**: solo llama a numeros _verificados_ en Twilio (Console -> Phone
  Numbers -> Verified Caller IDs). `providers:check` te avisa si detecta Trial.
- **Regulacion chilena (UV-027)**: Twilio exige numeros `+56 600` / `+56 809` con KYC local para
  comunicaciones automatizadas. Es un bloqueante externo, no tecnico — para probar contra tu
  propio numero normalmente no aparece, pero si antes de llamarle a un cliente.
- **Ventana horaria**: si tu `.env` local la tiene en `00:00-23:59` (comodo para probar),
  volvela a `09:00-19:00` antes de llamar a alguien que no seas vos.
- **`CALL_RECORDING_ENABLED`**: default `false` (UV-026, decision de negocio abierta). Se manda
  explicito en cada request, no se hereda de la config del agente.
- **`DRY_RUN`** solo afecta al evaluador en lote, **no** al disparador manual: no te protege de
  una llamada real disparada desde el micrositio. El que te protege es `MOCK_PROVIDERS`.

## Calidad

```bash
npm run build          # tsc --noEmit
npm run lint
npm run format:check
npm test               # 117 tests (unit + integracion contra dynalite real)

npm run web:build      # tsc --noEmit + vite build del micrositio
npm run web:test       # 20 tests del front (vitest + jsdom)
```

No se realizan llamadas reales a Twilio/ElevenLabs en ningun test, ni en el demo, ni desde el
micrositio en modo local — todo corre contra `MockElevenLabsClient` (`MOCK_PROVIDERS=true` es
el default). Ver `CLAUDE.md`, seccion "Reglas de seguridad".
