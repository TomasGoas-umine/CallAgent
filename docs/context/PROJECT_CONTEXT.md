# Contexto de negocio — Umine Voice

## Que es Umine

Umine es una empresa chilena de capacitaciones (OTEC) que gestiona cursos financiados via
SENCE. Cada curso vive como una Orden de Compra (OC) vinculada a un cliente, con alumnos
inscritos que deben conectarse a la plataforma SENCE durante el curso para justificar la
franquicia tributaria y evitar objeciones de la Direccion del Trabajo (DJ).

## El "Semaforo"

El "Semaforo" (repo `micrositio-operaciones-tablero-sence`, backend `tablero-api`) es el
tablero operacional donde el equipo de Umine ve, por curso, si la conexion de los alumnos a
SENCE va atrasada respecto de lo esperado para la semana del curso en que estan. Clasifica
cada curso en `NORMAL` / `ALERTA` / `CRITICO` segun el `%` de alumnos conectados vs. el
umbral esperado para esa semana (ver `urgency-classifier.ts` para los umbrales exactos,
portados 1:1 desde el Semaforo real).

Hoy esa deteccion es 100% manual: alguien del equipo de operaciones revisa el tablero y decide
a quien llamar. **Umine Voice automatiza la deteccion y el primer contacto** para el caso mas
urgente (Seccion A, Riesgo Conexion, nivel CRITICO), liberando ese trabajo manual y acortando
el tiempo de reaccion.

## Que hace Umine Voice (MVP de esta sesion)

1. Lee el Semaforo (solo lectura) y detecta cursos en banda CRITICO de riesgo de conexion.
2. Aplica guardrails (telefono valido, no `do_not_call`, no duplicado, no en cooldown, cuota
   diaria, ventana horaria, kill switch) para decidir a quien llamar.
3. Dispara una llamada saliente via ElevenLabs (que a su vez usa Twilio para marcar) — un
   agente conversacional explica la situacion, intenta entender el motivo y obtener un
   compromiso o detectar que el caso necesita un humano.
4. Recibe el resultado de la llamada (transcripcion + analisis, ya generados por ElevenLabs) y
   clasifica el resultado, actualizando el estado del seguimiento.
5. Si el caso lo amerita (el destinatario pide un humano, se detecta una situacion urgente, o
   se agotaron los intentos), escala para revision manual de PMO — **nunca sigue reintentando
   en paralelo a un caso escalado**.

## Fuera de alcance de esta sesion (deliberado)

- Llamadas reales a Twilio/ElevenLabs (todo corre con mocks, ver `CLAUDE.md`).
- Conectar a la API real de `tablero-api` (se usa un fixture — el dato real no tiene telefono,
  ver mas abajo).
- Cualquier UI/frontend — el Semaforo ya es la interfaz de entrada; los resultados se revisan
  via logs/DynamoDB.
- Base vectorial/semantica — complejidad prematura sin pregunta de negocio que la justifique.
- Despliegue a AWS.

## Riesgos heredados de la auditoria de `tablero-api` (hechos ya verificados, no opiniones)

- **Paginacion rota**: `GET /tablero/search` siempre devuelve `nextCursor: null` y tiene un
  limite hardcodeado de 15000 registros. Puede fallar con `Function.ResponseSizeTooLarge` si
  la respuesta supera ~6MB (~19.087 registros reales al momento de la auditoria).
  `HttpTableroApiClient` detecta y loguea esta condicion como metrica — nunca falla en
  silencio (ver `src/services/tablero-api-client.http.ts`).
- **Autenticacion debil**: solo valida presencia de un Bearer token de Firebase, no la firma
  (gateado por `REQUIRE_AUTH`, que puede no estar seteada). Umine Voice trata a tablero-api
  como fuente de solo lectura y nunca le escribe.
- **No existe campo de telefono** en ningun punto de la cadena `po -> pod ->
  execution-sence -> tablero-api`, ni de alumno ni de encargado de capacitacion. Tampoco
  existe `do_not_call`, ni se expone `last_sence_sync` real (solo `updated_at`, que puede
  reflejar ediciones manuales). Por eso el MVP usa `FixtureTableroApiClient` con un campo
  sintetico `phone_test_only` explicitamente marcado como dato de prueba — nunca se debe
  inferir que ese dato existe en produccion.

## Decisiones de negocio que siguen sin confirmar (ver DECISIONS.md §9)

A quien se llama exactamente, de donde sale el telefono real, si el destinatario debe saber
que habla con una IA, si se graba el audio, y el numero telefonico chileno a usar (bloqueante
regulatorio de Twilio para comunicaciones automatizadas). Ninguna de estas se resolvio en esta
sesion — se construyeron como parametros configurables, nunca hardcodeados.
