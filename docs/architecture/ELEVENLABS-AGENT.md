# Agente Sence — configuración conversacional

Configurado el 2026-09-09 en el agente `agent_5201m1f6e9ccfb6t5gafcw2azzrk`, rama Main
`agtbrch_4001m1f6eapce618c4vn02zecdzx`. Versión verificada por GET:
`agtvrsn_0501m23xb1eve5x91xhkj2wt541t`.

[Abrir workflow en ElevenLabs](https://elevenlabs.io/app/agents/agents/agent_5201m1f6e9ccfb6t5gafcw2azzrk/workflow?branchId=agtbrch_4001m1f6eapce618c4vn02zecdzx).

## Fuente y alcance

`scripts/lib/sence-agent-config.ts` contiene el prompt general, las instrucciones por etapa,
las condiciones de transición y el análisis post-llamada. `buildSenceAgentPatch()` genera un
objeto de configuración sin efectos externos; importar el módulo no modifica ElevenLabs.
El agente tiene 15 nodos y 60 conexiones, dos de ellas bidireccionales. El prompt general
establece identidad, contexto y límites; cada nodo agrega su objetivo conversacional.

El workflow implementa la parte conversacional del flujo 2 y produce evidencia para los
flujos 3 y 4. La selección, revalidación, horarios, cuotas, persistencia y bloqueo de reintentos
siguen en el backend. El único motivo originado actualmente es `riesgo_conexion_critico`.
Un motivo desconocido o contexto incompleto llevan a revisión humana; agregar una nueva
campaña requiere definir su objetivo y habilitarla expresamente en el backend.

## Etapas y salidas

| Etapa                       | Comportamiento                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Identificación              | Confirma persona o rol antes de revelar empresa, curso o situación.                            |
| Contexto                    | Usa motivo y datos de la llamada; no supone falta de conexión si los datos son inconsistentes. |
| Diagnóstico                 | Distingue desconocimiento, coordinación, acceso, problema administrativo y otras situaciones.  |
| Soporte                     | Recoge el error sin credenciales; bloqueo persistente se deriva a revisión humana.             |
| Acuerdo                     | Recoge acción y plazo explícitos; no confunde una preferencia de llamada con resolución.       |
| Capacitación futura         | Recoge interés espontáneo, sin ofrecer precios, matrícula ni fechas.                           |
| Cierre de acuerdo           | Resume el compromiso sin afirmar que el registro ya se completó.                               |
| Ya resuelto                 | Acepta el reporte de la persona, advierte posible desfase y no insiste.                        |
| Reagendar                   | Recoge una preferencia, sin confirmar una cita ni programar llamadas.                          |
| Contacto ausente/equivocado | Cierra sin revelar datos ni pedir teléfonos de terceros.                                       |
| Humano                      | Deja solicitud para revisión sin prometer transferencia en vivo o notificación.                |
| No contactar                | Reconoce rechazo permanente y termina sin persuadir.                                           |
| Cierre pendiente            | Resume solo lo obtenido, sin inventar compromisos.                                             |
| Inicio y fin                | Entrada y terminación del grafo.                                                               |

Las etapas activas tienen salidas prioritarias para buzón, rechazo permanente, humano,
contacto incorrecto y falta de disponibilidad. Las conexiones de retorno permiten volver
de soporte o de capacitación futura al acuerdo. El interés o error ya recogidos no deben
provocar bucles. `end_call`, `skip_turn` y `voicemail_detection` están habilitadas; el buzón
se termina sin dejar mensaje.

## Variables y análisis

Las siete variables coinciden con `src/services/agent-variables.ts`: `nombre_interlocutor`,
`nombre_cliente`, `nombre_curso`, `motivo`, `dias_restantes`, `pct_conexion`, `orden_compra`.
Los valores predeterminados no representan a una persona ni curso real: los datos faltantes
se reconocen como `NO_DISPONIBLE` o cadena vacía y no se inventan. El porcentaje y la orden
son referencias internas que el agente no debe pronunciar.

Los cinco campos de extracción coinciden con el clasificador existente:

| Campo                           | Tipo y significado                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `motivo_no_conexion`            | Texto; rechazo permanente usa exactamente `no_contactar`.                               |
| `tiene_bloqueo_tecnico`         | Booleano; true solo para bloqueo que persiste al cierre.                                |
| `compromiso_fecha`              | Texto; vacío si falta acción y plazo aceptados. Otra llamada no cuenta como compromiso. |
| `requiere_humano`               | Booleano; solicitud de humano, límite de atribuciones o bloqueo que necesita soporte.   |
| `necesidad_capacitacion_futura` | Texto; vacío si no hubo interés espontáneo.                                             |

El único criterio de evaluación es `objetivo_resuelto`. No agregar criterios independientes
de cortesía sin revisar el clasificador: actualmente todos los criterios en success pueden
cerrar el seguimiento como RESUELTO. La resolución es del seguimiento, no una verificación
de acreditación en SENCE. Los campos sin evidencia no se deben rellenar con ejemplos.

Si pide humano y no volver a llamar, el webhook conserva ESCALADO y marca CONTACT.doNotCall
en paralelo. Este ajuste local requiere que el servidor cargue el código actualizado.

## Verificación y mantenimiento

Se validó el esquema del grafo, correspondencia de variables, alcanzabilidad y salidas de
todos los nodos, prioridad de rechazo y contrato de extracción. Se verificó por GET que la
API guardó las herramientas, los campos y el criterio. La API convirtió los campos de análisis
a sus referencias nativas (`analysis_items`) conservando sus identificadores de extracción.
Se conservaron voz, modelo conversacional, configuración de turnos, privacidad, autenticación,
límites y webhooks existentes.

Las tres pruebas de transición ejecutadas en ElevenLabs pasaron: identificación a contexto,
diagnóstico a soporte y acuerdo a cierre. Quedaron guardadas en la biblioteca de pruebas de
ElevenLabs bajo nombres que comienzan con `Umine workflow:`. Las simulaciones de texto
comprobaron extracción de rechazo de contactos, reporte de resolución y bloqueo técnico.
El compromiso con fecha se validó con un historial controlado que contiene la aceptación
explícita. Las simulaciones generales no reportan el nodo recorrido; para las transiciones
se usó la API específica de pruebas de workflow. Evidencia resumida sin credenciales:
[elevenlabs-validation.json](elevenlabs-validation.json).

Pasaron 23 pruebas locales (13 unitarias y 10 del webhook con DynamoDB local), compilación
TypeScript y lint de los archivos cambiados. No se realizaron llamadas telefónicas; falta
validación de voz y del ciclo completo con el backend en ejecución.

```bash
npm run build
npx vitest run test/unit/sence-agent-config.spec.ts test/unit/call-outcome-classifier.spec.ts test/integration/elevenlabs-post-call-webhook.spec.ts
```

Para actualizar de nuevo: leer la rama indicada con GET, respaldar su versión, construir el
objeto con `buildSenceAgentPatch()`, combinar únicamente sus campos con la configuración
vigente y aplicar PATCH a la misma rama. Verificar que la versión no cambió entre lectura
y escritura y comprobar el resultado con un nuevo GET. No enviar referencias vacías de
`analysis_items` junto con cambios de extracción. No incluir claves API en archivos versionados.

El respaldo privado de esta sesión está en `/tmp/umine-agent-config/before.json` (permisos
0600); las respuestas aplicada y verificada están en `after.json` y `verified.json`. Estos
archivos temporales no forman parte del repositorio. La versión anterior es
`agtvrsn_7201m1hza033etxb0qq0j3j1wf6g`, disponible para comparación o restauración en ElevenLabs.

## Límites del sistema existente

- Una preferencia de horario queda en el análisis y transcripción; no existe agenda automática.
- La revisión humana conserva evidencia y estado ESCALADO; no hay transferencia telefónica
  ni notificación a PMO implementada por este workflow.
- La reconciliación por timeout y la clasificación real de no contestadas siguen siendo
  pendientes documentados en el proyecto. Finalizar un buzón en ElevenLabs no corrige por sí
  solo la taxonomía de estados del proveedor en el backend.
- La entrega post-call depende del webhook y URL pública previamente configurados. Cambiar
  el workflow no despliega el backend ni mantiene vivo el túnel local.

Referencias: [Workflows](https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows),
[actualizar agente](https://elevenlabs.io/docs/api-reference/agents/update).
