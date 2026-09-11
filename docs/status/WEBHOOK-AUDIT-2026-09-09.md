# Revisión del webhook y dashboard — 2026-09-09

## Resultado

El circuito local procesa resultados simulados correctamente, pero **la entrega real desde
ElevenLabs no está configurada**. El dashboard no recibirá automáticamente el resultado de
una nueva llamada con la configuración observada durante esta revisión.

No se modificaron configuraciones, seguimientos ni llamadas reales. Se enviaron dos sondas
sintéticas con identificadores desconocidos al servidor local; no crean registros. Las pruebas
de persistencia usaron tablas aisladas y proveedores simulados.

## Bloqueos comprobados en el entorno en ejecución

| Comprobación                       | Resultado                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Webhook local con firma válida     | HTTP 200, `ignored / unknown_conversation_id`, esperado para la sonda.                                                     |
| Webhook local con firma inválida   | HTTP 401, correcto.                                                                                                        |
| `PUBLIC_BASE_URL`                  | La URL de quick tunnel configurada no resuelve: `ENOTFOUND`. La sonda pública no pudo conectarse.                          |
| Webhooks registrados en ElevenLabs | GET `/v1/workspace/webhooks`: HTTP 200, lista vacía.                                                                       |
| Webhook asignado al workspace      | `post_call_webhook_id: null`.                                                                                              |
| Override del agente Sence          | `post_call_webhook_id: null`.                                                                                              |
| Secreto local                      | `ELEVENLABS_WEBHOOK_SECRET` sigue siendo un placeholder de desarrollo, no un secreto emitido al registrar el webhook.      |
| Formato de evento configurado      | `transcript`, formato `json`, `send_audio: false`; aún sin destino asignado.                                               |
| Campos del agente                  | Los cinco campos de extracción configurados en la sesión anterior están presentes.                                         |
| Dashboard local                    | GET `/api/calls`: HTTP 200, cero seguimientos.                                                                             |
| Historial de ElevenLabs            | La primera página devuelve 20 conversaciones, con más páginas disponibles; incluye conversaciones terminadas con mensajes. |

La sonda local verifica que cliente de prueba y servidor comparten el mismo secreto. No
demuestra que ese secreto corresponda a ElevenLabs ni que exista entrega desde el proveedor.
El mensaje final de `webhook:selftest --local` es más optimista de lo que prueba.

## Qué llega al dashboard una vez conectado

El handler persiste estado del proveedor, resultado clasificado, duración, SID de Twilio,
inicio, fecha del evento, cinco campos extraídos, criterios de evaluación, resumen y
transcripción. La API de detalle expone la mayoría de esos datos. La pantalla muestra estado,
duración, resultado, resumen, campos extraídos y turnos de transcripción.

El dashboard se alimenta de FOLLOWUP/CALL locales. No importa por sí solo el historial de
ElevenLabs. Para aceptar un webhook debe existir el mapeo `conversation_id -> followupId`,
normalmente creado por el dispatcher. Una conversación iniciada directamente en ElevenLabs,
o cuyo mapeo se perdió, se ignora con HTTP 200. Los registros históricos no aparecerán solo
por conectar ahora el webhook; recuperarlos exige primero comprobar su asociación.

## Hallazgos de código

1. **Detalle desactualizado después de refrescar.** `FilaLlamada` solo consulta el detalle
   cuando `!detalle`. Si se abre durante DIALING, guarda una respuesta sin transcripción.
   Refrescar actualiza la lista, pero conserva el componente y su caché por `followupId`.
   Abrir/cerrar la fila no vuelve a consultar. La transcripción puede seguir vacía aunque
   ya esté guardada. Referencia: `web/src/components/Dashboard.tsx`, función `alternar`.

2. **Evaluación recibida pero no mostrada.** `/api/calls/:id` devuelve `evaluacion`, pero
   `Dashboard.tsx` no la renderiza. El criterio `objetivo_resuelto` y su justificación quedan
   fuera de la pantalla. Tampoco muestra el SID, y la API de detalle no expone `startedAt`.

3. **Indicador de configuración insuficiente.** `/api/health` usa la presencia de
   `PUBLIC_BASE_URL` para informar `webhookPostCall.configurado`. Una URL caducada, un secreto
   de prueba y un webhook inexistente pueden aparecer como configurados. No es una
   comprobación de conectividad ni de registro en ElevenLabs.

4. **No se captura todo el payload.** Solo se conservan los cinco campos conocidos de
   extracción; se pierde su `rationale`. No se guarda el costo ni `termination_reason`,
   aunque están declarados en el tipo. `endedAt` se toma del timestamp del evento post-call,
   no se calcula como inicio más duración. Audio no se recibe ni muestra en esta configuración.

5. **Fallos de inicio de llamada requieren tratamiento propio.** El handler no distingue
   tipos de evento y el clasificador sigue esperando algunos estados sintéticos
   (`no-answer`, `busy`, etc.). No hay suscripción a `call_initiation_failure`. La detección
   fiable de llamadas no contestadas y su reconciliación siguen pendientes en el proyecto;
   no quedan resueltas al registrar un webhook de transcripción.

## Validación ejecutada

- `npm run webhook:selftest -- --local`: pasó firma válida e inválida.
- `npm run webhook:selftest`: falló el alcance público.
- `npm run providers:check`: confirmó ausencia de webhook y secreto de desarrollo.
- Lecturas directas adicionales confirmaron workspace, override del agente y DNS.
- 55 pruebas de backend pasaron: firma, webhook, ciclo manual simulado y API.
- 25 pruebas de vistas web pasaron.

Las pruebas existentes cubren recepción, persistencia y lectura de resultados simulados;
no cubren la invalidación del detalle de una fila ya abierta ni prueban entrega real desde
ElevenLabs. No se originó ninguna llamada telefónica.

## Orden para dejarlo operativo

1. Levantar una URL pública vigente hacia el backend.
2. Registrar un webhook HMAC en ElevenLabs y guardar el secreto emitido en `.env`.
3. Asignarlo al agente Sence o al workspace, con evento `transcript` y formato JSON.
4. Reiniciar el backend para que cargue el secreto y comprobar ambas firmas por la URL pública.
5. Corregir la caché del detalle y mostrar la evaluación en el dashboard.
6. Validar persistencia y visualización con un seguimiento controlado; distinguir esa prueba
   sintética de una entrega real del proveedor.

Referencia del proveedor: [eventos post-call de ElevenLabs](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks).

---

## Cierre — 2026-09-09 (tarde)

La revisión de arriba queda **atendida**, pero por un camino distinto al que proponía su
"Orden para dejarlo operativo": en vez de apoyar el registro de llamadas en el webhook, se
agregó un camino **pull** por API (`services/conversation-sync`) que solo necesita
`ELEVENLABS_API_KEY`. El webhook sigue existiendo y es el camino preferido en producción
(URL estable), pero ya no es el único ni el que bloquea.

### Por qué se invirtió el flujo

El push depende de tres cosas encadenadas y frágiles en local: una URL pública viva, un webhook
registrado apuntando a **esa** URL, y un secreto emitido en el panel. Un quick tunnel invalida
las tres cada vez que se reinicia — que es exactamente lo que encontró esta auditoría
(`ENOTFOUND`). El pull no depende de ninguna: es re-corrible, recupera hacia atrás y es
idempotente por `conversation_id`.

### Hallazgos de esta auditoría, uno por uno

| #   | Hallazgo                                     | Estado                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Detalle desactualizado tras refrescar        | **Corregido**. El detalle se vuelve a pedir al abrir y cuando cambia `updatedAt`. Test en `web/test/vistas.spec.tsx`.                                                                                                                                                                                                                                                                           |
| 2   | Evaluación recibida y no mostrada            | **Corregido**. Se muestran criterios con su `rationale`, `call_sid`, `startedAt`, corte y origen del dato.                                                                                                                                                                                                                                                                                      |
| 3   | Indicador de configuración insuficiente      | **Corregido**. `configurado` pasó a llamarse `urlConfigurada` y `/api/health` dice con qué se verifica de verdad. Se agregó `sincronizacionPorApi`.                                                                                                                                                                                                                                             |
| 4   | No se captura todo el payload                | **Corregido**. Se persisten `cost`, `termination_reason` y el `rationale` de cada campo extraído. `endedAt` se calcula como inicio + duración (antes, en un sync, habría fechado una llamada vieja como recién terminada). Audio sigue sin traerse.                                                                                                                                             |
| 5   | Fallos de inicio de llamada / no contestadas | **Parcial**. El recorder ahora ignora conversaciones no finales (`initiated`/`in-progress`/`processing`), que era el riesgo concreto: guardar una a medias bloqueaba el resultado bueno por la escritura condicional. La taxonomía de no contestadas sigue abierta (UV-053) y ahora tiene con qué calibrarse: se persiste `termination_reason`. No hay suscripción a `call_initiation_failure`. |

### Lo que la auditoría no podía saber todavía

- **`user_id` no sirve como identificador propio.** Parecía el campo indicado, pero ElevenLabs
  lo rellena solo: en las llamadas Twilio de esta cuenta quedó con el número de teléfono, y en
  las pruebas del panel con un id de workspace. La atribución viaja por
  `dynamic_variables.followup_id`, que la API devuelve verbatim.
- **De 24 conversaciones históricas, 23 no son atribuibles.** No traen ninguna variable: son
  pruebas hechas desde el panel. Se dejan sin tocar a propósito (decisión del 2026-09-09). La
  única con `orden_compra` es la que sí originó el micrositio.
- **Ninguna de las 24 trae `data_collection_results` ni `evaluation_criteria_results`**, pese a
  que el agente ya tiene los cinco campos y `objetivo_resuelto` configurados: todas corrieron
  con la versión anterior del agente. Los campos extraídos recién van a aparecer en la próxima
  llamada real. Es la validación que sigue faltando.

### Verificación ejecutada

- Ciclo completo con datos **reales**, sin originar ninguna llamada: se atribuyó a mano la
  conversación `conv_0201m1m5...` (72s, 13 turnos) a un FOLLOWUP local y quedó registrada con
  transcripción, `call_sid` real, `cost`, corte y `endedAt` correcto (17:41:56 + 72s = 17:43:08,
  no la hora del sync).
- `POST /api/calls/sync` sobre las 26 conversaciones de la cuenta: 1 ya registrada, 2 en curso,
  23 no atribuibles, 0 errores. Re-correrlo no duplica nada.
- 229 pruebas de backend y 55 del micrositio, `build`, `lint` y `format:check` limpios.

## Ampliación: historial completo del agente

Se agregó un archivo independiente en DynamoDB y una vista de historial con registros y estadísticas. La importación real recuperó 28 conversaciones sin errores, incluidas las no atribuibles a una OC. El receptor público se verificó con un payload histórico firmado: dos entregas respondieron 200 y el total permaneció en 28. Firma inválida → 401; rutas privadas del dashboard/administración → 404 a través del túnel. Se comprobó reproducción de audio mediante el proxy local (200, audio/mpeg).

La creación del webhook real fue rechazada por ElevenLabs: HTTP 401, `missing_permissions`, permiso `webhooks_write` faltante en la API key. **No confundir el éxito de la sonda con una suscripción activa en ElevenLabs.** El comando `npm run webhook:configure` permite terminar el registro una vez habilitado ese permiso; después se debe reiniciar el servidor local y repetir los chequeos. Detalles de operación y límites: [CALL-HISTORY.md](../architecture/CALL-HISTORY.md).

## Actualización 23:22 — bloqueo resuelto y webhook activo

El usuario habilitó `webhooks_write`. Se ejecutó `npm run webhook:configure` correctamente: webhook `eb8df75052c74b08980ba27458415bc6` creado con HMAC, reintentos habilitados y asignación al agente para transcripciones JSON y fallos de inicio. Se reinició el receptor con el secreto real, conservando las 15 órdenes y reglas locales.

`providers:check` verifica registro activo/asignación/eventos y no reporta bloqueantes. `webhook:selftest` pasa por la URL pública. Dos reproducciones firmadas del resultado de una conversación histórica devolvieron 200, actualizaron su registro y conservaron el total en 28. El secreto de desarrollo devuelve 401; las rutas privadas devuelven 404 por el túnel. Audio local comprobado (200). Esta prueba no originó llamadas nuevas ni representa una entrega espontánea de ElevenLabs. Ver [evidencia y operación](../architecture/CALL-HISTORY.md).
