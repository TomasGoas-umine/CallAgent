# Historial de ElevenLabs en CallAgent

El Dashboard tiene dos registros distintos:

- **Historial del agente**: todas las conversaciones disponibles para `ELEVENLABS_AGENT_ID`, incluidas pruebas web/texto, llamadas telefónicas, fallos y conversaciones sin OC. Se guardan en DynamoDB local y sobreviven al reinicio del servidor.
- **Seguimientos de CallAgent**: las OCs y estados del proceso de negocio. Una prueba del panel no crea un seguimiento ni se atribuye automáticamente a una OC.

## Uso

Abre Dashboard → **Importar historial de ElevenLabs** para recuperar el historial anterior y las conversaciones de períodos en que el receptor estuvo apagado. Solo consulta la API; no origina llamadas. No hay polling ni sincronización programada.

**Actualizar historial local** vuelve a leer lo guardado por el webhook. El botón **Sincronizar** de seguimientos conserva la sincronización de resultados y transiciones del proceso de negocio.

Filtros: fecha de Chile (`America/Santiago`), estado, canal e ID/resumen. Las estadísticas se recalculan para los registros filtrados: cantidad, minutos, duración promedio, proporción de objetivos logrados entre las evaluaciones conocidas, créditos y fallos. Un estado `done` no equivale a un objetivo logrado. Los créditos no incluyen la factura independiente de Twilio.

**Ver registros** muestra transcripción, resumen, evaluación y sus justificaciones, datos extraídos, herramientas por turno, latencias/uso cuando ElevenLabs los devuelve, metadatos y errores. Permite descargar JSON. Los números de teléfono estructurados y secretos se enmascaran al servir los registros. El audio se reproduce desde ElevenLabs a través del backend, cuando el proveedor indica que existe; no se cambia la política de grabación o retención y no se conserva una copia local del audio.

## Conectar el webhook local

La API key necesita leer conversaciones y el agente, modificar el agente y escribir webhooks (`webhooks_write`). La clave se guarda únicamente en `.env`.

```bash
npm run webhook:connect
# Mantener este proceso abierto. Al completar el registro:
# reiniciar npm run local:server en su terminal y ejecutar:
npm run providers:check
npm run webhook:selftest
```

`webhook:connect` inicia un gateway en `127.0.0.1:3001`, levanta Cloudflare, crea un webhook HMAC, guarda inmediatamente el secreto de una sola lectura en `.env` y asigna el webhook **a este agente**. Comprueba que prompt y workflow no hayan cambiado. Solicita transcripciones JSON y fallos de inicio, y activa reintentos del proveedor.

Si el túnel ya está corriendo, `npm run webhook:configure` registra/asigna su `PUBLIC_BASE_URL` actual. Puede repetirse sin crear otro webhook cuando conserva la misma URL, ID y secreto. Para una URL nueva crea un registro nuevo; no elimina webhooks anteriores ni modifica los de otros agentes.

El gateway solo permite `POST /webhooks/elevenlabs/post-call`. `/api`, `/internal` y las rutas del dashboard no se publican. El receptor verifica HMAC sobre el cuerpo crudo, ignora otros agentes y tipos de evento, archiva antes de confirmar recepción y devuelve error si falla el almacenamiento. Los eventos `call_initiation_failure` guardan sus diagnósticos sin fabricar un resultado de negocio basado en una transcripción vacía.

La sonda prueba alcance y HMAC con una solicitud sintética y otra de firma inválida; **no demuestra una entrega originada por ElevenLabs ni que el webhook esté asignado**. `providers:check` verifica el registro y la configuración efectiva del agente/workspace. El banner detecta configuración local incompleta; no es un monitor de disponibilidad remota.

## Persistencia y límites

`AGENT_CALLS#<agent_id>` / `CONVERSATION#<conversation_id>` es independiente de los items FOLLOWUP/CALL. El detalle completo se comprime con gzip y se guarda con revisión condicional para evitar sobrescrituras concurrentes. Las consultas recorren todas las páginas de DynamoDB; el importador recorre las páginas del proveedor y comunica importaciones parciales. Los duplicados no aumentan contadores y un evento atrasado no revierte un estado final ni borra los registros más completos recuperados por API.

El detalle comprimido tiene un límite explícito de 340 KB por conversación para respetar los 400 KB de DynamoDB. Si se supera, la escritura falla de forma visible, sin truncar el detalle; para conversaciones grandes se deberá migrar el objeto a S3 o almacenamiento local de blobs. No hay TTL en este archivo; su persistencia depende del volumen de DynamoDB local.

Un entorno local no garantiza captura permanente: el equipo, DynamoDB, servidor y túnel deben estar funcionando. La URL de Cloudflare cambia al reiniciar el túnel y exige volver a registrar/asignar y cargar las variables en el servidor. Para recepción continua se necesita un receptor alojado con URL estable. El importador recupera solo lo que ElevenLabs todavía conserva; no recrea audio/transcripciones eliminados ni evaluaciones nunca generadas.

## Verificación del 9 de septiembre de 2026

- Historial real importado: **28 conversaciones**, cero errores en el recorrido.
- Prueba pública sintética: firma válida → 200, firma inválida → 401.
- Registro real completado después de habilitar `webhooks_write`: webhook HMAC activo y asignado al agente, con `transcript` y `call_initiation_failure`. El servidor carga el secreto real de ElevenLabs; el secreto de desarrollo ahora se rechaza con 401.
- Navegador local: historial, estadísticas y apertura de registros funcionan sin errores JavaScript.
- No se originaron llamadas para estas comprobaciones.

### Activación confirmada (9 de septiembre, 23:22 de Chile)

- Webhook: `eb8df75052c74b08980ba27458415bc6`.
- Versión del agente tras asignarlo: `agtvrsn_6101m24hwq4mfjqvy6tc3v18kvzj`. Solo cambiaron la asignación/eventos del webhook y los metadatos de versión; prompt, workflow y demás configuración permanecieron iguales.
- `providers:check`: registro activo, asignación efectiva al agente y eventos correctos; sin bloqueantes.
- Reproducción de un payload histórico completo por la URL pública: 200 `archived` dos veces, persistencia confirmada por `updatedAt`, transcripción intacta y 28 registros antes/después.
- Firma inválida o secreto antiguo: 401. Rutas `/api/agent-history` y `/internal/dispatcher/drain` por el túnel: 404.
- Audio por el proxy local: 200 `audio/mpeg`, 710829 bytes.
- Se conservaron las 15 órdenes y reglas del Tablero Mock al reiniciar el servidor.

Las solicitudes de prueba fueron firmadas por CallAgent usando el secreto emitido por ElevenLabs. No se originó una llamada nueva ni se observó una entrega espontánea del proveedor durante esta verificación. La asignación remota y todo el recorrido de recepción/persistencia sí fueron comprobados.
