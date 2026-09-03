# PROGRESS.md — Umine Voice (CallAgent)

Resumen de lo avanzado en la sesión del **2026-08-13/14**. Para el detalle técnico completo ver
`docs/spec.csv` (backlog ticket por ticket), `docs/architecture/DECISIONS.md` (ADRs) y
`CLAUDE.md` (cómo correr todo). Este documento es solo el resumen para orientarse rápido.

## Estado general

MVP funcional del agente de llamadas (Semáforo → clasificación de urgencia → llamada
automática vía Twilio/ElevenLabs → registro del resultado), construido de punta a punta en
local, **verificado con `npm run local:demo`**, 92 tests pasando, lint/build limpios.

- **17 commits en la rama `dev`** (`f2c7d32` → este commit). Working tree limpio.
- **Nada de esto está pusheado a GitHub** más allá del commit inicial de README — `origin/dev`
  solo tiene `f2c7d32`. Los otros 16 commits siguen únicamente en local.
- No se desplegó nada en AWS real ni se corrió `cdk synth` (regla no negociable de la sesión).

## Qué se construyó

**Lógica de dominio** (portada 1:1 desde el Semáforo real, sin reimplementar):

- `urgency-classifier.ts` — clasificación de urgencia por semana de curso.
- `order-status-promoter.ts` — promoción de estado de OC + agregación por grupo.

**Integración con el Semáforo:**

- `TableroApiClient` como interfaz; `FixtureTableroApiClient` (default) lee un fixture de 142
  registros/13 grupos; `HttpTableroApiClient` construido pero **inactivo** — el tablero-api real
  no expone teléfono en ningún punto de la cadena de datos.

**Persistencia (DynamoDB single-table):**

- `base-repository.ts` + repos de `followup`/`contact`/`idempotency`, con GSI1/GSI2.
- Item extra no pedido en el prompt original: `CONVERSATION#<id> META` para poder correlacionar
  el webhook de ElevenLabs (que solo trae `conversation_id`) con el `followup_id` interno.

**Guardrails y control de llamadas:**

- Ventana horaria, allowlist, cuota diaria, kill switch (`guardrails.ts`).
- `idempotency.ts` — clave `sha256(destinatario+motivo+order_number+ventana_semanal)`.
- Cola en memoria (`queue.ts`) con concepto de `MessageGroupId`, pensada para migrar a SQS FIFO
  real sin cambiar el contrato.

**Integración de voz:**

- `ElevenLabsClient` real + mock (el real nunca se activa por omisión, solo con
  `MOCK_PROVIDERS=false` + allowlist no vacía).
- Validador de firma HMAC de ElevenLabs (tolerancia 30 min, comparación en tiempo constante).
- Validador de firma de Twilio (usa el helper oficial del SDK).
- `call-outcome-classifier.ts` — taxonomía centralizada de 12 valores de resultado de llamada.

**Los 3 handlers Lambda del MVP:**

1. `candidate-evaluator` — lee el fixture, clasifica, aplica guardrails, crea FOLLOWUP, encola.
2. `call-dispatcher` — revalida contra el Semáforo, guardrails, anti doble disparo, dispara la
   llamada con reintentos y backoff.
3. `webhooks/elevenlabs-post-call` — valida firma, idempotente por `conversation_id`, clasifica
   resultado, transiciona el FOLLOWUP.
4. `webhooks/twilio-status` — **stub**, valida firma y registra el evento, pero sin
   reconciliación real todavía (TODO explícito en el código, ver "Pendiente" abajo).

**Entorno local y demo end-to-end:**

- `docker-compose.local.yml` (para cuando haya Docker) + fallback con `dynalite` (usado en esta
  sesión porque el sandbox no tenía Docker).
- Server Fastify local + seed + `npm run local:demo`, verificado corriendo de forma repetible.

**Infraestructura y CI:**

- Esqueleto CDK v2 en `infra/` (tabla → Lambda factory → rutas → IAM) — **construido, no
  desplegado, no sintetizado**.
- GitHub Actions (`ci.yml`): lint, prettier check, `tsc --noEmit`, tests, validación de
  Conventional Commits — verificado localmente, no corrió en un push real todavía.

**Documentación:**

- BPMN (4 diagramas), `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `DECISIONS.md` (8 ADRs),
  `CLAUDE.md`, `docs/spec.csv`.

## Decisiones de arquitectura clave (detalle en `DECISIONS.md`)

- **ADR-001**: TypeScript, no Python (el repo no tenía remanente de una generación anterior).
- **ADR-003**: Integración ElevenLabs↔Twilio nativa — sin servidor WebSocket persistente.
- **ADR-004**: Fixture en vez de API real de tablero-api (no hay teléfono real disponible).
- **ADR-005**: Cola en memoria en vez de SQS FIFO/ElasticMQ para el MVP.
- **ADR-006**: Decisiones de negocio pendientes modeladas como configuración, nunca hardcodeadas.
- **ADR-007**: Se usó `dynalite` en vez de `dynamodb-local` real vía Docker (el sandbox no tenía
  Docker) — mismo protocolo AWS SDK, pero no verificado contra el binario oficial.
- **ADR-008**: npm + Vitest (no pnpm/yarn, no Jest).

## Preguntas de negocio abiertas (bloquean pasar a producción real)

Tickets `UV-023` a `UV-028` en `docs/spec.csv`, todas asumidas temporalmente vía configuración:

- **A quién se llama** — ¿alumno, encargado de capacitación, o ambos? (propuesta: encargado, sin confirmar)
- **De dónde sale el teléfono real** — no existe en ningún punto de la cadena `po → pod → execution-sence → tablero-api`.
- **Disclosure de IA** — asumido: sí, siempre, primer mensaje (falta confirmación de legal).
- **Grabación de audio** — asumido: no, en el piloto.
- **Bloqueante regulatorio chileno** — Twilio exige números `+56 600`/`+56 809` con KYC local desde agosto 2025 (externo, no técnico).
- **Cuota/ventana horaria/intentos** — valores default ya son variables de entorno (5/día, 09:00–19:00 Santiago, 3 intentos), falta confirmación de negocio.

## Pendiente / próximos pasos técnicos

- **UV-029** (mayor impacto): repositorio DynamoDB dedicado para `ESCALATION` — hoy solo queda en logs estructurados, el PMO no puede revisar escalaciones sin ir a CloudWatch.
- **UV-030**: reconciliación real en `webhooks/twilio-status` (hoy es un stub).
- **UV-031**: validar la misma suite contra `dynamodb-local` real (Docker), no solo `dynalite`.
- Push de la rama `dev` a GitHub (sigue solo local).
- Correr todo con Node 24 real antes de desplegar (esta sesión usó Node 22.19 vía nvm).
