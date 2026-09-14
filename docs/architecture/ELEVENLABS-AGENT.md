# Agente Sence — conexión y declaraciones juradas

Actualizado y verificado por GET el **2026-09-11** en el agente
`agent_5201m1f6e9ccfb6t5gafcw2azzrk`, rama Main `agtbrch_4001m1f6eapce618c4vn02zecdzx`,
versión `agtvrsn_1101m28nmpace7nrzbcq9gsa44na`.

[Abrir workflow en ElevenLabs](https://elevenlabs.io/app/agents/agents/agent_5201m1f6e9ccfb6t5gafcw2azzrk/workflow?branchId=agtbrch_4001m1f6eapce618c4vn02zecdzx).

## Capacidad y decisión

La revisión del agente remoto confirmó que solo admitía `riesgo_conexion_critico`. No bastaba
con conectar el tablero B: el workflow habría derivado el motivo desconocido a revisión humana.
Se amplió el mismo agente porque identificación, diagnóstico, soporte, acuerdo y cierre son
compartidos; otro agente habría duplicado esas instrucciones y su mantenimiento.

La configuración versionable vive en `scripts/lib/sence-agent-config.ts`. Tiene **16 nodos**:
se agregó únicamente `contexto_dj`. Después de confirmar identidad, el motivo decide si se entra
a contexto de conexión o a contexto DJ; luego se reutiliza el flujo común. El prompt general pasó
de **5.107 a 5.211 caracteres (+2%)**. Las instrucciones específicas de DJ viven en su etapa.
Ver [ADR-012](DECISIONS.md#adr-012--un-agente-dos-motivos-conexión-y-declaraciones-juradas).

| Motivo                    | Objetivo                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `riesgo_conexion_critico` | Revisar participación pendiente del curso y recoger una acción/plazo.                       |
| `riesgo_dj_critico`       | Revisar declaraciones juradas pendientes de un curso terminado con el contacto responsable. |
| Otros                     | Revisión humana; no convertirlos en riesgo de conexión.                                     |

Para B, tener conexión al 100% es válido y **no demuestra que las declaraciones estén completas**.
El agente no pide volver a conectarse, firmar por terceros ni entregar documentos o credenciales
por teléfono. No inventa pasos de plataforma, enlaces, sanciones ni plazos legales. Si la gestión
depende del OTIC, una validación administrativa o un bloqueo persistente, deja revisión humana.

## Datos y resultados

Las ocho variables de `src/services/agent-variables.ts` son `nombre_interlocutor`, `nombre_cliente`,
`nombre_curso`, `motivo`, `dias_restantes`, `pct_conexion`, `orden_compra` y `dj_pendientes`.
La última es conectados menos DJ, releída al marcar; se envía vacía en A. Los datos faltantes
siguen vacíos/`NO_DISPONIBLE`. Una llamada B necesita curso, días restantes negativos y DJ
pendientes positivas; un contexto inconsistente lleva a revisión, sin inventar una incidencia.

Se conservan los cinco campos del análisis post-call:

| Campo                           | Contrato                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `motivo_no_conexion`            | Clave histórica: causa del motivo original, también DJ. Rechazo permanente usa `no_contactar`. |
| `tiene_bloqueo_tecnico`         | Booleano; bloqueo que persiste al cierre.                                                      |
| `compromiso_fecha`              | Plazo aceptado junto con una acción; otra llamada no cuenta.                                   |
| `requiere_humano`               | Booleano; petición explícita o límite de atribuciones.                                         |
| `necesidad_capacitacion_futura` | Solo interés espontáneo.                                                                       |

El único criterio de evaluación sigue siendo `objetivo_resuelto`. En B, haber conectado a los
participantes no resuelve las DJ. Se necesita reporte de declaraciones completas o acción con
plazo para ellas. RESUELTO significa resolución del seguimiento, no verificación en SENCE.
Las solicitudes simultáneas de humano y no contactar conservan ESCALADO y CONTACT.doNotCall.

## Integración y verificación

`readCallSemaforo` incluye A y B para el evaluador, `/api/tablero` y la revalidación. El Mock
presenta B con «¿Llama?» y usa el mismo trigger y dispatcher que A. B conserva su gate y usa sus umbrales de llamada configurables (por defecto, más de siete
días y CRITICO); los ajustes de A no la afectan. C sigue sin originar llamadas. El seguimiento
conserva la sección original para que un cambio de fechas no cambie silenciosamente su motivo.

Se verificaron selección, conexión completa con DJ pendientes, preview y payload HTTP,
cancelación si las DJ se completan antes de marcar, no reconvertir A a B, control de repetición,
consentimiento, cuota, kill switch y resultados post-call. Las siete pruebas en ElevenLabs
pasaron contra la configuración propuesta: cuatro transiciones y tres simulaciones de texto
(compromiso, DJ entregadas y rechazo permanente). Después se aplicó el PATCH a Main y se verificó
por GET que prompt, etapas, transiciones, variables y análisis coinciden.

Se preservaron voz, modelo, temperatura, turnos, herramientas externas, base de conocimiento,
privacidad, autenticación, límites y configuración de webhooks. Evidencia resumida:
[elevenlabs-dj-validation.json](elevenlabs-dj-validation.json).

**No se realizaron llamadas telefónicas.** Falta comprobar voz y entrega del webhook con el
servidor/túnel en ejecución; la integración local se probó con proveedor simulado y DynamoDB local.
Pruebas sugeridas: [PRUEBAS_MANUALES_AGENTE.md](../PRUEBAS_MANUALES_AGENTE.md#criterio-b--declaraciones-juradas-2026-09-11).

## Mantenimiento

```bash
npm run agent:check
# Requiere ELEVENLABS_AGENT_BRANCH_ID explícito. Sin --apply solo prepara una vista previa.
npm run agent:configure
npm run agent:configure -- --apply
```

`agent-configure` lee la rama, guarda respaldo privado y patch en un directorio temporal,
comprueba que la versión no cambió y aplica solo la configuración conversacional versionada.
El respaldo de esta actualización está en `/tmp/umine-agent-8WOeza/before.json` (0600),
y la verificación en `verified.json`. La versión previa es
`agtvrsn_1601m26702v8fzhrj4z5e9h372t3`. Los temporales no forman parte del repositorio.

Referencias de API: [actualizar agente](https://elevenlabs.io/docs/api-reference/agents/update),
[variables dinámicas](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables),
[pruebas del agente](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing).
