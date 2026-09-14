# Auditoría del Mock: criterios B y C

Fuente indicada por el usuario: `../semaforo-reglas-negocio/`, copia local del repositorio
`umine-ui-core-operaciones`. Se revisaron `README.md`, `flujo-estados-oc.md`,
`business-rules-2026-05-10.html` y `StatusCursosPage.tsx`.

## Resultado de la comparación

| Criterio          | Requisito de entrada                                                                                     | Criticidad fija                                  | Resultado                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| B · Riesgo DJ     | Curso terminado, conectados mayores que cero, DJ/conectados menor que uno, más de tres días desde cierre | ALERTA con más de 3 días; CRITICO con más de 7   | Ya coincidía. Se conservan cálculos, denominador y exclusión de DJ completas. |
| C · Rectificación | Estado contiene ESPERA o RECTIFIC y más de tres días desde la última actualización                       | ALERTA con más de 15 días; CRITICO con más de 30 | Ya coincidía el cálculo; faltaba poder elegir EN RECTIFICACION en el editor.  |

Referencias exactas de `StatusCursosPage.tsx`: B en líneas 83–87 y 582–621; C en 626–659 y 1245. Los días usan `Math.ceil` sobre la diferencia temporal, no días completos ni semanas.
C usa el máximo `updated_at` de los registros vivos de la OC, no la fecha de término del curso.
Los colores auxiliares de la celda de días de B (15/30) no reemplazan su etiqueta de criticidad
(3/7). La documentación HTML describe reglas upstream del scanner sobre alumnos, montos y
estados; no define otros umbrales para estas dos secciones.

Se incorporaron al editor `EN RECTIFICACION`, `OCF SOLICITADA`,
`SOLICITUD OC FINAL ENVIADA` y `OC RECIBIDA`. Los dos estados `OCF SOLICITADA` y `OC RECIBIDA`
también se preservan como manuales al promover estados por fechas, según `flujo-estados-oc.md`.
Estos dos no entran en C: no contienen ESPERA ni RECTIFIC. No se cambiaron los umbrales de
criticidad ni los cálculos de A, B o C.

## Configuración de llamadas B

El nuevo apartado **B · Umbrales de llamada por declaraciones juradas** permite configurar:

- `dj.llamarSiDiasMayorA`: entero no negativo. Comparación estricta de días desde cierre;
  vacío/null desactiva las llamadas B. Predeterminado: 7.
- `dj.nivelesQueLlaman`: niveles del semáforo habilitados para llamar. Predeterminado: CRITICO.

Ejemplo: con umbral 3 y nivel ALERTA habilitado, una OC con cinco días desde cierre puede
llamar y sigue siendo ALERTA. Con umbral 12, una OC con diez días sigue siendo CRITICO pero
no llama. Se conserva siempre el gate de B, incluidos los tres días de gracia.

Las reglas de llamada de A y B son independientes. Editar o restaurar una desde su panel no
restaura la otra. Los cambios parciales de API conservan los valores existentes; el endpoint
`POST /api/tablero/mock/call-rules/reset` sigue restaurando ambas explícitamente.
Guardar/restaurar reglas no llama: realinea los estados previos para exigir una nueva transición
al guardar una OC. El interruptor B debe estar encendido y siguen aplicando cuota, consentimiento,
allowlist, horario, cooldown e idempotencia. C permanece sin llamadas.

El preview, el disparo y el dispatcher consultan la misma decisión. La revalidación cancela
si la regla cambia antes de marcar. Como ocurre con A, la regla activa también determina la
posibilidad de llamar desde el Disparador manual. No se modificó el agente de ElevenLabs: el
motivo y los datos conversacionales de B siguen siendo los mismos.

## Verificación

Pruebas de los bordes B 3/4/7/8 y C 3/4/15/16/30/31 días; conservación de estados manuales;
separación entre criticidad y llamada; validación de parámetros; edición sin llamada ni nuevo
flanco; llamada B en ALERTA pasando por el dispatcher; cancelación por cambio de regla; interfaz
para editar días y niveles. Proveedores simulados, sin llamadas telefónicas reales.
