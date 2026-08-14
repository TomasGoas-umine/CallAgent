# Arquitectura — Umine Voice

## Vista de componentes

```
                    ┌──────────────────────┐
   (cron)  ───────▶ │ candidate-evaluator  │──── lee (solo lectura) ───▶ tablero-api (Semaforo)
                    │ Lambda               │
                    └──────────┬───────────┘
                               │ crea FOLLOWUP (READY) + encola
                               ▼
                    ┌──────────────────────┐
                    │ SQS FIFO             │   (local: cola en memoria, ver ADR-005)
                    │ MessageGroupId=      │
                    │ destinatario         │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ call-dispatcher      │──── REVALIDA ───▶ tablero-api (Semaforo)
                    │ Lambda               │
                    └──────────┬───────────┘
                               │ POST /v1/convai/twilio/outbound-call
                               ▼
                    ┌──────────────────────┐        ┌─────────┐
                    │ ElevenLabs           │◀──────▶│ Twilio  │──▶ Destinatario
                    │ (integracion nativa) │  audio  └─────────┘
                    └──────────┬───────────┘
                               │ webhook post-call (HMAC firmado)
                               ▼
                    ┌──────────────────────┐
                    │ webhooks/            │
                    │ elevenlabs-post-call │
                    │ Lambda               │
                    └──────────┬───────────┘
                               │ clasifica + transiciona FOLLOWUP
                               ▼
                    ┌──────────────────────┐
                    │ DynamoDB single-table │
                    │ FOLLOWUP / CALL /     │
                    │ CONTACT / IDEMP /     │
                    │ CONVERSATION (link)   │
                    └──────────────────────┘
```

Un cuarto handler, `webhooks/twilio-status`, es un stub de respaldo (reconciliacion si el
webhook de ElevenLabs no llega dentro del timeout) — ver TODO en su codigo.

## Por que Lambda de request/response corto (sin servidores persistentes)

La integracion elegida (ElevenLabs<->Twilio nativa, ver ADR-003) hace que el audio viaje
directo entre ElevenLabs y Twilio, sin pasar por infraestructura de Umine. Nuestro backend
solo dispara la llamada (`POST /v1/convai/twilio/outbound-call`) y despues recibe un webhook
con el resultado ya analizado (transcripcion, `data_collection_results`,
`evaluation_criteria_results`). Esto significa que todo el computo de este proyecto es
request/response corto — no se necesita ningun servidor WebSocket persistente (Fargate/EC2),
que ademas no es un patron que Umine use hoy para este tipo de servicio.

## Modulo de dominio unico para logica que no debe duplicarse

- **Clasificacion de urgencia**: `src/services/urgency-classifier.ts` +
  `src/services/order-status-promoter.ts`. Portados 1:1 desde el Semaforo real
  (`StatusCursosPage.tsx`, `useSenceData.ts`, `InicioBPage.tsx`) — el Semaforo real tiene esta
  logica duplicada entre dos archivos; aca vive en uno solo.
- **Guardrails**: `src/services/guardrails.ts`, usado identico por el evaluador (decision de
  encolar) y por el dispatcher (revalidacion justo antes de llamar).
- **Reagendamiento/backoff**: `src/utils/scheduling.ts`, compartido por evaluador, dispatcher
  y el webhook (todos necesitan calcular "proxima ventana habil" o "backoff de reintento").
- **Taxonomia de resultado de llamada**: `src/services/call-outcome-classifier.ts`, un solo
  lugar que traduce el payload de ElevenLabs a la taxonomia de negocio.

## Modelo de datos (DynamoDB single-table)

Ver prompt §8 para el diseño original. Una pieza se agrego durante la implementacion, no
explicitada en el prompt: **`CONVERSATION#<conversation_id> META -> { followupId }`**. El
webhook post-call de ElevenLabs solo trae `conversation_id` en el payload, nunca nuestro
`followup_id` interno — sin este mapeo no habria forma de saber a que FOLLOWUP corresponde un
webhook entrante. Se escribe en el momento en que `call-dispatcher` dispara la llamada con
exito (`FollowupRepository.linkConversation`).

```
PK                          SK                       Atributos clave
─────────────────────────────────────────────────────────────────────────
FOLLOWUP#<followup_id>      META                     motivo, prioridad, estado,
                                                      destinatarioId, destinatarioPhone,
                                                      oc, curso, intentos, nextAttemptAt,
                                                      idempotencyKey, contexto, createdAt
FOLLOWUP#<followup_id>      CALL#<conversation_id>   callSid, status, durationSeconds,
                                                      dataCollection, evaluation,
                                                      transcriptS3Key
CONTACT#<telefono_e164>     META                     nombre, cliente, doNotCall,
                                                      lastContactedAt, consent
IDEMP#<idempotency_key>     LOCK                     followupId, ttl
CONVERSATION#<conv_id>      META                     followupId   (agregado en implementacion)

GSI1: GSI1PK=ESTADO#<estado>     GSI1SK=<next_attempt_at>  → "que toca llamar ahora"
GSI2: GSI2PK=DEST#<destinatario> GSI2SK=<created_at>       → cooldown por destinatario
```

## Entorno local vs. AWS real

| Pieza       | AWS real (futuro)     | Local (esta sesion)                                                          |
| ----------- | --------------------- | ---------------------------------------------------------------------------- |
| DynamoDB    | DynamoDB real         | `dynalite` (ver ADR-007 — no habia Docker en el sandbox de esta sesion)      |
| Cola        | SQS FIFO              | Cola en memoria (`src/services/queue.ts`, ver ADR-005)                       |
| API Gateway | HTTP API v2           | Fastify (`src/local/server.ts`) adaptando el mismo shape de evento/respuesta |
| Cron        | EventBridge Scheduler | Disparo manual (`POST /internal/evaluator`) o `scripts/local-demo.ts`        |
| Kill switch | SSM Parameter Store   | Variable de entorno `KILL_SWITCH`                                            |
| Secretos    | Secrets Manager       | `.env` (nunca commiteado, `.env.example` solo con nombres)                   |

## Infra como codigo (construida, no desplegada)

`infra/` contiene un esqueleto de AWS CDK v2 (`bin/app.ts`, `lib/stacks/umine-voice-stack.ts`)
siguiendo el patron tabla -> Lambda factory -> rutas API GW -> IAM del boilerplate de Umine.
No se ejecuto `cdk deploy` en esta sesion (regla no negociable del prompt) — el stack compila
(`cdk synth` no se corrio tampoco, ver limitaciones en CLAUDE.md) pero es un punto de partida
para la siguiente sesion de despliegue, no un artefacto verificado end-to-end contra AWS.
