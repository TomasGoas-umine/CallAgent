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

---

## ADR-009 — Fechas del fixture relativas a "hoy", no absolutas

**Contexto.** El fixture `tablero_search_sample.json` se genero con fechas absolutas centradas
en `FIXTURE_REFERENCE_NOW` (`2026-08-13`). `getCourseWeek` calcula el progreso del curso
contra `Date.now()`, asi que las fechas absolutas envejecen: corriendo el 2026-09-03 (tres
semanas despues) 4 de los 13 grupos ya se reclasificaban solos (dos ALERTA y dos NORMAL
pasaron a CRITICO), el evaluador agotaba `DAILY_QUOTA` antes de llegar al grupo del demo y
`npm run local:demo` fallaba. Los 92 tests seguian verdes porque pinean el reloj con
`vi.setSystemTime` — la deriva era invisible para la suite y solo la detectaba el demo.

**Decision.** Los registros del fixture llevan `_fixture_offset_init_days`,
`_fixture_offset_end_days` y `_fixture_offset_updated_days` (dias relativos a la medianoche UTC
de hoy), y `FixtureTableroApiClient` reescribe `init_course` / `end_course` / `updated_at` en
cada `search()`. Los offsets se eligieron con una duracion de curso fija de 28 dias de forma
que "hoy" caiga en el CENTRO de la banda de semana objetivo (progreso 0.125 / 0.375 / 0.625 /
0.875), nunca en un borde. La semana objetivo de cada grupo es la que documenta
`semana_curso` en `semaforo_test_samples.csv`.

**Alternativas.** (a) Regenerar el fixture a mano cada tanto — vuelve a derivar y depende de
que alguien se acuerde. (b) Pinear el reloj tambien en el demo y en el micrositio — esconde el
problema y hace que la UI muestre datos que no corresponden a la fecha que ve el operador.
(c) Guardar las fechas absolutas y ajustar los umbrales — cambiaria la logica de negocio
portada 1:1 del Semaforo, prohibido.

**Consecuencias.** La clasificacion del fixture es estable corra cuando corra, sin mantenimiento.
Los tests que pinean el reloj siguen deterministas (los offsets se resuelven contra el reloj
pineado). El campo `init_course`/`end_course` del JSON queda como valor de referencia
historico (el dato real de la auditoria) pero **no es lo que devuelve el cliente** — quien lea
el JSON a mano debe mirar los offsets. `HttpTableroApiClient` no se ve afectado: los offsets
son exclusivos del fixture.

---

## ADR-010 — Ninguna llamada se dispara sola: originacion solo manual

**Contexto.** El plan de voz es **Starter**: muy pocos minutos disponibles. El esqueleto
original estaba pensado para el flujo automatico del BPMN (cron -> `candidate-evaluator` ->
cola -> `call-dispatcher`), que en una sola corrida puede crear y encolar tantos FOLLOWUP como
cursos CRITICO haya en el Semaforo. Con esa cuota, cualquier automatismo — un cron, un worker
de cola, un reintento con backoff, un poller de reconciliacion — es un riesgo de consumir el
plan completo sin que nadie lo decida.

**Decision.** La unica forma de originar una llamada es que una persona la dispare:
`POST /api/calls` -> `originateManualCall` -> `dispatchFollowup`. Concretamente:

1. **No se habilita ningun disparador automatico.** No hay cron, ni scheduler, ni polling, ni
   worker de cola, ni reintentos automaticos en el camino manual. `sharedLocalQueue` solo se
   drena si alguien hace `POST /internal/dispatcher/*` a mano.
2. **El micrositio no hace polling.** Los datos se refrescan al montar y despues solo con el
   boton (ver `web/README.md`).
3. **La cuota diaria es persistente y atomica** (`QuotaRepository`, `QUOTA#<fecha> COUNTER` con
   `ADD` condicional). Antes `guardrails.isDailyQuotaExceeded` recibia el contador por
   parametro y nadie lo calculaba: el evaluador contaba en memoria (`createdToday`), asi que
   reiniciar el proceso reiniciaba la cuota. Eso no sirve cuando la cuota es lo unico que
   separa un bug de una factura.
4. **El disparo manual no se saltea ningun guardrail.** Delega en el mismo
   `dispatchFollowup` del flujo automatico, que revalida el Semaforo, revalida guardrails,
   consume cuota de forma atomica y hace la escritura condicional READY->DIALING. El
   pre-chequeo del servicio manual existe solo para poder responder con un motivo preciso
   (403 / 429 / 503) _antes_ de crear un FOLLOWUP o quemar la idempotency key.
5. **La idempotency key de `POST /api/calls` es obligatoria** y la elige el cliente. El
   micrositio la genera al ABRIR el modal de confirmacion, no al confirmar: un doble click
   manda la misma key y el backend responde `already_processed` sin originar una segunda
   llamada.

El `candidate-evaluator` **no se borro**: sigue siendo el flujo del BPMN aprobado y se puede
correr a mano (`npm run local:demo`, `POST /internal/evaluator`). Lo que no se habilita es su
disparador.

**Alternativas.** (a) Dejar el cron con una cuota muy baja — la cuota protege el gasto pero no
el criterio: seguiria llamando a quien el clasificador elija, sin que nadie lo mire.
(b) Un modo "aprobacion" donde el evaluador propone y un humano confirma en lote — es a donde
esto deberia ir cuando el plan lo permita, pero agrega una cola de aprobaciones que hoy no
hace falta. (c) Borrar el evaluador — se perderia el flujo ya modelado y aprobado en el BPMN.

**Consecuencias.** El sistema no descubre urgencias por si solo: alguien tiene que abrir el
micrositio. Es una limitacion **elegida**, no un descuido — el tablero esta justamente para
que ese "alguien" vea en 5 segundos que cursos estan CRITICO. Dos deudas quedan anotadas:
`infra/` todavia declara la `events.Rule` de cron y hay que deshabilitarla antes de cualquier
despliegue (UV-042), y el conteo en memoria del evaluador deberia unificarse con
`QuotaRepository` (UV-045).

**Nota sobre que mide la cuota.** `DAILY_QUOTA` cuenta llamadas ORIGINADAS, no minutos: los
minutos reales solo se conocen cuando llega el webhook post-call, y para entonces ya se
gastaron. Contar originaciones es la aproximacion conservadora (una llamada que el proveedor
rechaza tambien consume cuota). Si negocio necesita un tope en minutos, es un ticket aparte
(UV-044).

---

## ADR-011 — Las secciones B y C del Semaforo se muestran y se editan, pero nunca llaman

**Fecha:** 2026-09-11 · **Estado:** aceptada

**Contexto.** El Semaforo real tiene tres secciones, cada una con su propia pregunta, su propio
filtro de entrada y su propia escala (docs/SEMAFORO_INTEGRACION.md §3):

| Seccion                 | Pregunta                                               | Escala                        |
| ----------------------- | ------------------------------------------------------ | ----------------------------- |
| **A · Riesgo Conexion** | ¿va atrasada la conexion para la semana del curso?     | % contra umbral por semana    |
| **B · Riesgo DJ**       | ¿cuanto lleva el curso cerrado sin Declaracion Jurada? | dias: >3 ALERTA, >7 CRITICO   |
| **C · Rectificacion**   | ¿cuanto lleva la OC esperando la OC Final del OTIC?    | dias: >15 ALERTA, >30 CRITICO |

Hasta ahora CallAgent implementaba solo la A: era la unica accionable por telefono y las otras
dos se dejaron explicitamente fuera. Pero el tablero mentia por omision — un operador que mira
el Tablero Mock de CallAgent y el Semaforo real lado a lado ve dos cosas distintas, y no puede
distinguir "esta OC no tiene problemas" de "esta OC tiene un problema que este tablero no sabe
mirar". Eso vuelve dificil calibrar reglas: sin ver las tres, no se puede razonar sobre cual
justifica una llamada.

**Decision.** Implementar las tres escalas y mostrarlas, y separar de forma explicita **mostrar**
de **llamar**:

1. Las tres escalas viven en `urgency-classifier.ts` (`clasificarConexion`, `clasificarDj`,
   `clasificarRectificacion`) y los tres filtros de entrada en `semaforo-sections.ts`
   (`gateSeccionA/B/C`). Siguen siendo los mismos cuatro modulos espejo del Semaforo de la regla
   2 de CLAUDE.md — **no se agrega un quinto**.
2. Las tres se muestran en vinetas colapsables, como en el original: en el **Tablero Mock**
   (editables) y en el **Tablero Original** (solo lectura).
3. **Solo la seccion A puede terminar en una llamada.** `call-rules.ts` no conoce `clasificarDj`
   ni `clasificarRectificacion`, y `mock-tablero-store` arma `regla` exclusivamente desde el
   nivel de conexion y el gate de la seccion A. Los campos nuevos del Mock (`djs`,
   `ultimaActualizacion`) no participan de esa decision.

**Por que B y C no llaman.** No es una limitacion tecnica ni una etapa pendiente: es la naturaleza
del problema. Una DJ que falta y una OC Final que no llega se resuelven **con el OTIC**, no con el
alumno — llamar por telefono a quien ya hizo su parte no mueve ninguno de los dos indicadores. El
canal correcto ahi es el correo al OTIC, que el micrositio original ya ofrece. La conexion
pendiente, en cambio, si es accionable por telefono: por eso el MVP llama por eso y solo por eso.

**Por que igual son editables en el Mock.** El Tablero Mock es un banco de pruebas: sirve para ver
como se comporta el Semaforo ante datos que no existen todavia. Poder llevar una OC a "DJ critica"
y comprobar **que no suena el telefono** es tan util como poder llevarla a "conexion critica" y
comprobar que si suena. La garantia se prueba con las llamadas automaticas ENCENDIDAS
(`test/integration/mock-call-trigger.spec.ts`), no solo por inspeccion del codigo.

**Alternativas.** (a) No implementarlas — es el estado anterior, y deja el tablero incompleto
frente al Semaforo real. (b) Implementarlas y dejarlas conectadas al agente detras de un flag —
un flag que nadie deberia encender nunca es peor que no tener el camino: invita a encenderlo.
(c) Hacerlas de solo lectura tambien en el Mock — se pierde justamente la capacidad de probar el
escenario, que es para lo que existe el Mock.

**Consecuencias.** `OrderGroup` ahora acumula `djCount` y `lastUpdatedAt` (los usa solo B y C; A
los ignora). El Mock gana dos campos editables, `djs` y `ultimaActualizacion`, con una regla de
validacion propia: `djs <= conexiones`, porque la seccion B divide DJ sobre CONECTADOS y no sobre
inscritos. Y queda una regla viva para quien toque esto despues: **si alguna vez una seccion nueva
tiene que poder llamar, la decision se toma aca y en `call-rules.ts`, nunca agregandole una
condicion al trigger del Mock.**
