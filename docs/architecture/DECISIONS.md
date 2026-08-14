# Decisiones de arquitectura (ADRs) — Umine Voice

Formato corto: Contexto -> Decision -> Alternativas -> Consecuencias.

---

## ADR-001 — TypeScript en vez de Python

**Contexto.** El Paso 0 de esta sesion audito el repo `CallAgent` y lo encontro con un solo
`README.md` — sin remanente de Python/Ruff/pytest de una generacion anterior del proyecto (a
diferencia de lo que el prompt anticipaba como posible). El boilerplate real de Umine y
`umine-core-ms-dhl` son TypeScript + AWS CDK v2 + Lambda Node ARM64 + DynamoDB + API Gateway
HTTP v2.

**Decision.** Construir todo en TypeScript, reutilizando el patron estructural de
`base-repository.ts`, `auth-middleware.ts`, el patron CDK (tabla -> Lambda factory -> rutas API
GW -> IAM) y la convencion de carpetas `auth/ domain/ repositories/ services/ handlers/
utils/` — sin copiar logica de dominio de DHL, solo la forma.

**Alternativas.** Python + Ruff + pytest (mencionado en la hoja de ruta previa como posible
punto de partida, pero no encontrado en este repo) — se descarto porque no es el stack real de
Lambda/CDK de Umine y hubiera significado reescribir todo mas adelante para desplegar.

**Consecuencias.** Es la decision mas cara de revertir de todo el proyecto; se tomo temprano y
deliberadamente. Toda la infraestructura (`infra/`), los tests y el tooling (ESLint/Prettier/
Vitest/tsc) quedan alineados con ese stack desde el dia uno.

---

## ADR-002 — Patron de repositorio generico (`base-repository.ts`)

**Contexto.** `umine-core-ms-dhl` tiene un `base-repository.ts` que envuelve
`DynamoDBDocumentClient` con un patron generico (get/put condicional/query). No se tuvo acceso
directo a ese repo en esta sesion (auditado en una sesion anterior); las conclusiones de esa
auditoria se aplicaron aca de memoria/documentacion, no copiando codigo literal.

**Decision.** `src/repositories/base-repository.ts` implementa el mismo patron: métodos
protegidos `getItem`/`putItem`/`putItemConditional`/`updateItem`/`updateItemConditional`/
`query`, con un `ConditionalCheckFailedError` propio para que los repositorios concretos no
tengan que conocer el shape de errores de AWS SDK.

**Alternativas.** Usar el SDK de DynamoDB directo en cada repositorio (mas repetitivo, sin
patron consistente); usar un ORM tipo Dynamoose/ElectroDB (mas dependencias, se aleja del
patron ya validado por Umine).

**Consecuencias.** `FollowupRepository`, `ContactRepository` e `IdempotencyRepository`
heredan de `BaseRepository` y solo agregan la forma de sus items y sus queries especificas.
Toda escritura condicional (anti-duplicado, anti doble disparo) pasa por el mismo mecanismo.

---

## ADR-003 — Integracion ElevenLabs<->Twilio nativa (Opcion A)

**Contexto.** ElevenLabs permite importar el numero Twilio directamente en su plataforma; el
audio viaja Twilio<->ElevenLabs sin pasar por infraestructura de Umine. La alternativa
(Twilio ConversationRelay o Media Streams) requeriria un servidor WebSocket persistente para
mediar el audio, con mas control del dialogo pero mas complejidad operacional.

**Decision.** Usar la integracion nativa: nuestro backend solo dispara
`POST /v1/convai/twilio/outbound-call` y recibe un webhook post-call con transcripcion y
analisis ya generados por ElevenLabs. Todo el computo de este proyecto es Lambda de
request/response corto — Umine no usa hoy el patron de servidores persistentes (Fargate) para
este tipo de servicio.

**Alternativas.** ConversationRelay / Media Streams — descartado por ahora; queda documentado
como ruta de migracion si mas adelante se necesita mas control del dialogo (solo cambiaria la
capa de voz, el resto del sistema — evaluador, dispatcher, persistencia, guardrails — no
cambia).

**Consecuencias.** No se construyo ningun procesador de LLM propio para analizar
transcripciones — se confia en `analysis.data_collection_results` /
`evaluation_criteria_results` que ElevenLabs ya entrega. Esto simplifica mucho el MVP, a costo
de menos control fino sobre el analisis (si se necesita logica de clasificacion mas rica, hay
que configurarla del lado del agente de ElevenLabs, no en este backend).

---

## ADR-004 — Fixture en vez de la API real de tablero-api

**Contexto.** `tablero-api` (auditado en una sesion anterior) no expone telefono en ningun
punto de la cadena `po -> pod -> execution-sence -> tablero-api`, ni de alumno ni de encargado
de capacitacion. Tampoco existe `do_not_call`. Ademas, la decision de negocio de "a quien se
llama" (§9) no esta confirmada.

**Decision.** `TableroApiClient` es una interfaz; `FixtureTableroApiClient` (default,
`TABLERO_API_MODE=fixture`) lee `test/fixtures/tablero_search_sample.json`, generado con el
mismo patron de `semaforo_test_samples.csv` mas un campo `phone_test_only` explicitamente
marcado como dato sintetico. `HttpTableroApiClient` se construyo con el mismo contrato pero
**no se activa por defecto**.

**Alternativas.** Conectar directo a la API real desde el dia uno — descartado: no hay
telefono real que usar, y hacerlo hubiera significado inventar de donde sale el numero
(justo la pregunta de negocio pendiente en §9).

**Consecuencias.** El MVP es 100% verificable en local sin ninguna llamada de red a
`tablero-api`. El dia que haya decision de negocio + credencial real, activar
`TABLERO_API_MODE=http` no requiere cambiar ningun handler (mismo contrato de interfaz).

---

## ADR-005 — Cola en memoria en vez de SQS FIFO + ElasticMQ

**Contexto.** El prompt dejaba abierta la eleccion entre una cola en memoria o SQS FIFO local
via ElasticMQ (que requiere Docker).

**Decision.** Cola en memoria (`src/services/queue.ts`, `InMemoryQueueClient`), con el mismo
concepto de `MessageGroupId` (destinatario) que tendria SQS FIFO real, para que el contrato no
cambie si mas adelante se reemplaza por SQS real.

**Alternativas.** ElasticMQ via Docker — descartado principalmente porque el sandbox de esta
sesion no tiene Docker disponible (ver ADR-007); aun con Docker disponible, para un flujo
evaluator->dispatcher que en local corre secuencial en el mismo proceso, una cola real no
aporta valor de prueba adicional.

**Consecuencias.** La cola vive en memoria del proceso del server local — no persiste entre
reinicios, y no sirve para probar comportamiento distribuido/multi-consumidor. Eso es
aceptable para el MVP; el reemplazo por SQS real es una tarea de la fase de despliegue.

---

## ADR-006 — Decisiones de negocio pendientes, modeladas como configuracion (prompt §9)

**Contexto.** Varias preguntas de negocio no estan resueltas: a quien se llama exactamente
(alumno / encargado de capacitacion / ambos), de donde sale el telefono real, si el
destinatario debe saber que habla con una IA, si se graba el audio, y el numero telefonico
chileno a usar (Twilio exige `+56 600`/`+56 809` con KYC local desde agosto de 2025 para
comunicaciones automatizadas — bloqueante regulatorio externo, no tecnico).

**Decision.** Ninguna de estas se resolvio con una suposicion fija en el codigo. Se modelaron
como parametros de entorno (`ALLOWLIST_NUMBERS`, `TWILIO_PHONE_NUMBER`, `DAILY_QUOTA`,
`BUSINESS_HOURS_START/END`, `MAX_ATTEMPTS`, `COOLDOWN_HOURS`) o quedan explicitamente fuera de
alcance (el "a quien llamar" se resuelve hoy leyendo el primer registro con `phone_test_only`
del grupo — una eleccion de implementacion para poder probar el flujo, NO una respuesta a la
pregunta de negocio).

**Asumido temporalmente, pendiente de confirmacion de jefatura:**

- El destinatario siempre es informado de que habla con una IA en el primer mensaje del guion
  (asumido: si, siempre — decision que legal debe confirmar).
- `call_recording_enabled: false` por defecto (asumido: no se graba en el piloto).

**Consecuencias.** Nada de esto bloquea la construccion del esqueleto, pero el sistema no
puede pasar a producir llamadas reales sin que jefatura resuelva estas preguntas — quedan
explicitamente listadas en el resumen final de esta sesion y en `docs/spec.csv`.

---

## ADR-007 — `dynalite` como DynamoDB local (limitacion del sandbox de esta sesion)

**Contexto.** El prompt pedia `docker-compose.local.yml` con `dynamodb-local` real via Docker.
El sandbox de ejecucion de esta sesion no tiene Docker instalado.

**Decision.** `docker-compose.local.yml` se construyo igual (es la forma "oficial" para el
equipo cuando haya Docker disponible), pero para poder verificar el flujo completo en esta
sesion se uso `dynalite` (implementacion pura JS de la API de DynamoDB, sin Docker/Java) via
`scripts/local-dynamo-up.ts` / `local-dynamo-down.ts`, que lanzan un proceso hijo detached.
Ambos hablan el mismo protocolo AWS SDK DynamoDB — ningun repositorio ni script de la
aplicacion distingue cual esta corriendo.

**Alternativas.** Instalar Docker en el sandbox — fuera de alcance/permiso de esta sesion
(cambiaria el entorno del usuario sin su intervencion). Usar mocks del SDK en vez de un
servidor real — se descarto porque los tests de integracion (anti-duplicado, anti doble
disparo, queries de GSI) necesitan semantica real de condicion/consistencia, no un mock.

**Consecuencias.** Todo lo verificado en esta sesion (tests de integracion + `local:demo`) usa
`dynalite`. Si el entorno real del equipo tiene Docker, `dynamodb-local` deberia comportarse
igual (mismo protocolo), pero no se verifico contra el binario oficial de AWS en esta sesion —
riesgo residual a validar en la primera corrida del equipo con Docker disponible.

---

## ADR-008 — npm + Vitest

**Contexto.** El prompt pedia elegir gestor de paquetes y framework de testing, documentando
el motivo.

**Decision.** **npm** (mas simple, ya viene con Node, consistente con lo que usa el
boilerplate de Umine). **Vitest** en vez de Jest: soporte ESM nativo sin configuracion
adicional (este proyecto usa `"type": "module"` + `NodeNext`), mas rapido en modo watch, y API
compatible con Jest (`describe`/`it`/`expect`) para minimizar la curva de aprendizaje.

**Alternativas.** pnpm/yarn (mas rapidos con workspaces grandes, mejor manejo de duplicados —
innecesario para un solo paquete como este). Jest (mas maduro/extendido, pero requiere
`ts-jest` o `babel-jest` + configuracion adicional para ESM + TypeScript).

**Consecuencias.** `npm test` / `npm run test:unit` / `npm run test:integration` corren sobre
Vitest; el `tsx --env-file=.env` de los scripts locales usa una capacidad nativa de Node 20+
(no se agrego `dotenv` como dependencia).
