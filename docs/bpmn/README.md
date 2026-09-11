# BPMN — Umine Voice

Estos 4 diagramas (Mermaid, `.mmd`) fueron revisados como borrador para jefatura/PMO antes de
esta sesion de construccion. Se copiaron aca **tal cual**, sin rediseñar — son la fuente de
verdad vigente del proceso. Si el proceso cambia, el diagrama se actualiza en el MISMO commit
que el cambio de codigo: un BPMN desactualizado es peor que no tener BPMN.

## Pools / lanes

Aunque los diagramas estan escritos como flowchart (no como swimlanes explicitos de BPMN), los
actores involucrados en el proceso son:

| Actor                 | Rol                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Umine Operacional** | El Semaforo (tablero-api / micrositio-operaciones-tablero-sence) — fuente de datos de solo lectura, nunca se le escribe. |
| **Umine Voice**       | Este proyecto: candidate-evaluator, call-dispatcher, webhooks, persistencia DynamoDB.                                    |
| **ElevenLabs**        | Agente conversacional + orquestacion de la llamada saliente (integracion nativa con Twilio, ver ADR-003).                |
| **Twilio**            | Proveedor telefonico — marca al destinatario, el audio viaja directo Twilio<->ElevenLabs.                                |
| **Destinatario**      | La persona que recibe la llamada (encargado de capacitacion o alumno — sin confirmar, ver ADR-006 / prompt §9).          |
| **PMO**               | Revisa y actua sobre escalamientos y (si se activa esa rama) aprobaciones manuales antes de llamar.                      |

## Los 4 flujos

1. **`flujo-1-seleccion-priorizacion.mmd`** — cron -> leer Semaforo -> clasificar urgencia ->
   aplicar guardrails de descarte -> crear FOLLOWUP -> encolar (o diferir por cuota).
   Implementado por `src/handlers/candidate-evaluator/handler.ts`.
2. **`flujo-2-ejecucion-llamada.mmd`** — consumir de la cola -> **revalidar contra el
   Semaforo** (paso critico) -> guardrails -> marcar DIALING -> disparar la llamada ->
   esperar el webhook. Implementado por `src/handlers/call-dispatcher/handler.ts`.
3. **`flujo-3-procesamiento-post-llamada.mmd`** — validar firma -> idempotencia por
   `conversation_id` -> clasificar resultado -> transicionar el FOLLOWUP. Implementado por
   `src/handlers/webhooks/elevenlabs-post-call/handler.ts`.
4. **`flujo-4-escalamiento.mmd`** — reunir evidencia -> el agente limita su autonomia ->
   crear registro de escalamiento -> bloquear reintentos -> esperar accion humana. En este
   MVP el registro de escalamiento se modela (`src/domain/escalation.ts`) y se deja constancia
   estructurada en logs, pero **no tiene repositorio DynamoDB dedicado todavia** — ver
   `docs/spec.csv` para el ticket de seguimiento.

## Nodos marcados como "a definir" (no resueltos en este MVP)

- **Flujo 1, nodo `G6`** ("¿Requiere aprobacion humana?"): la rama de aprobacion manual antes
  de llamar existe en el diagrama pero **no esta implementada** — el MVP actual no tiene ese
  gate (todo candidato que pasa los guardrails se encola directo). Si jefatura confirma que se
  necesita aprobacion previa, es el siguiente cambio logico a este flujo.
- **Flujo 2, nodo de reconciliacion via `GET /v1/convai/conversations/{id}`**: modelado en el
  diagrama y en la estructura (`webhooks/twilio-status` como stub), pero no implementado —
  ver TODO en `src/handlers/webhooks/twilio-status/handler.ts`.

## Workflow conversacional en ElevenLabs

El detalle de conversación del flujo 2 está configurado como un grafo de 15 nodos en
ElevenLabs. Fuente versionable, correspondencia con los flujos 3 y 4, campos de análisis y
límites operativos: [Configuración del agente](../architecture/ELEVENLABS-AGENT.md).

## Como actualizar estos diagramas

1. Edita el `.mmd` correspondiente en el mismo commit que el cambio de codigo que lo motiva.
2. Si el cambio afecta a mas de un flujo (ej. un nuevo guardrail que aplica en flujo-1 Y
   flujo-2), actualiza ambos diagramas — la logica en si sigue viviendo en un solo modulo de
   codigo (`src/services/guardrails.ts`), pero el diagrama es documentacion de proceso, no de
   codigo, y cada flujo lo necesita representado en su propio contexto.
3. Verifica que el diagrama siga renderizando (cualquier visor de Mermaid, o pegarlo en
   https://mermaid.live).
