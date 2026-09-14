# Pruebas de llamadas con el Tablero Mock

El agente activo usa siete variables por llamada. El backend las vuelve a construir con la
OC actualizada justo antes de marcar. El contacto es ficticio; el teléfono sigue siendo el
número autorizado de pruebas. Cambiar contacto, empresa o curso no altera la criticidad.

## Preparar y llamar

1. En **Tablero Mock**, deja **Llamadas automáticas** apagadas mientras preparas los casos.
2. Abre **Contexto del agente** en la fila. Puedes editar contacto, empresa y curso. Si dejas
   el contacto vacío, el saludo preguntará por el encargado de capacitación. Empresa o curso
   vacíos sirven para probar contexto incompleto. Guarda los cambios.
3. Revisa las siete variables guardadas. Fechas y conexiones editadas actualizan los días y
   porcentaje; los cambios sin guardar todavía no se envían al agente.
4. En **Disparador**, elige esa OC y el teléfono autorizado. Revisa el modal y confirma una
   llamada. Este camino permite repetir un caso sin tener que simular otra transición.
5. Contesta representando al contacto del caso. Revisa después el resultado, la transcripción
   y la extracción en el historial. Usa una respuesta distinta en cada llamada.

El disparador permite solo cursos que cumplen la regla activa. Por defecto son CRITICO.
En el mock puedes habilitar ALERTA o NORMAL y ajustar el umbral por semana para explorar datos
distintos. Esto no cambia la clasificación del Semáforo ni habilita esos niveles para fuentes
reales. El motivo interno sigue siendo `riesgo_conexion_critico`: son pruebas del mismo
seguimiento, no campañas nuevas de DJ, facturación o rectificación.

Las llamadas automáticas requieren una transición de no cumplir a cumplir al **guardar**.
Encender el interruptor o cambiar umbrales no llama. Si una OC ya cumple, usa el disparador
manual para repetirla. Los guardrails, consentimiento y cuota se comprueban en ambos caminos.

## Casos iniciales

Las fechas se siembran relativas al día en que arranca el servidor; estos días corresponden
a esa siembra. Consulta el contexto visible después de editar o dejar el servidor varios días.

| OC        | Contacto ficticio | Conexión | Días iniciales | Qué permite comparar                                     |
| --------- | ----------------- | -------- | -------------- | -------------------------------------------------------- |
| TEST-9600 | Marcela Bravo     | 0%       | 10             | Seguimiento con margen intermedio                        |
| TEST-9601 | Cristian Aguilera | 30%      | 17             | Participación parcial y mayor plazo                      |
| TEST-9602 | Daniela Herrera   | 70%      | 3              | Participación parcial y término cercano                  |
| 2127020   | Rodrigo Salas     | 12.5%    | 3              | Conservación del porcentaje decimal                      |
| TEST-9101 | Ignacio Fuentes   | 55%      | 17             | ALERTA: requiere habilitar ALERTA y umbral S2 mayor a 55 |
| TEST-9104 | Daniela Herrera   | 25%      | 24             | NORMAL S1: no llama con las reglas iniciales             |
| TEST-9106 | Carolina Munoz    | 100%     | 3              | Control: conexión completa queda fuera de llamadas       |

Una OC terminada o con conexión completa queda excluida aunque amplíes los umbrales. Las
etiquetas históricas de TEST-9500/9501 describen guardrails del fixture congelado; el **mock
editable** usa un teléfono común en todas las filas. El consentimiento efectivo se consulta
en CONTACT para ese teléfono, no se deduce del nombre de la OC.

## Respuestas para variar el comportamiento

La causa y el compromiso los aporta quien contesta. No se precargan en las variables, porque
el agente debe descubrirlos durante la conversación.

| Respuesta que puedes representar                      | Comportamiento que debes observar                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| «No sabía que faltaba revisar ese registro»           | Aclaración breve y pregunta por una acción posible                              |
| «Lo reviso el 15 de septiembre»                       | Confirma acción y fecha; no declara que ya está resuelto                        |
| «No logro entrar; aparece un error al iniciar sesión» | Recoge el paso y el error, sin claves; revisión humana si persiste              |
| «Ya lo hicimos esta mañana»                           | Acepta el reporte, menciona posible desfase y no insiste                        |
| «Ahora no puedo, prefiero mañana por la tarde»        | Guarda preferencia, sin prometer una cita ni tratarla como resolución           |
| «Esa persona no está»                                 | No revela empresa, curso ni incidencia a terceros                               |
| «Quiero hablar con una persona»                       | Cierra para revisión humana sin prometer transferencia en vivo                  |
| «También necesitamos otro curso de Excel»             | Recoge interés espontáneo sin confundirlo con resolución del curso actual       |
| «No me vuelvan a llamar»                              | Registra rechazo permanente; el backend bloquea llamadas futuras a ese teléfono |

Prueba el rechazo permanente **al final**: afecta al teléfono compartido por todas las OCs.
Restaurar datos del mock no borra consentimiento ni cuota. La configuración actual limita a
5 llamadas diarias; distribuye los casos entre jornadas si mantienes ese límite.

El agente conoce el porcentaje y la OC como referencias internas, pero tiene instrucciones
de no pronunciarlos. La variación esperada está en el contacto, curso, plazo y conversación,
no en recitar las etiquetas del tablero.

## Comprobaciones sin llamadas

```bash
npm run agent:check
npm run providers:check
npm run webhook:selftest
```

`agent:check` compara las variables, saludo, prompt y etapas con la configuración remota y
verifica los 15 casos iniciales. No lee las ediciones en memoria de otro proceso: para esas
ediciones usa el tablero. `providers:check` valida credenciales y configuración; el selftest
comprueba además que el túnel recibe una firma válida y rechaza una inválida.

Si reinicias el entorno, conserva la base existente y levanta:

```bash
npm run local:up
npm run local:create-tables
npm run webhook:connect
# En otra terminal, una vez configurado el webhook:
npm run local:server
# En otra terminal:
npm run web:dev
```

El túnel debe seguir abierto durante las llamadas. Un nuevo túnel cambia la URL y actualiza
el secreto en `.env`; inicia o reinicia el backend después de configurarlo.

### Estado de la revisión del 10 de septiembre de 2026

Se verificaron las siete variables contra el agente activo, la correspondencia entre PATCH,
preview y payload de ElevenLabs, la revalidación de datos recién cambiados y los 15 casos
iniciales. Pasaron compilación, lint y las suites de backend y web. No se originaron llamadas
reales ni se validó todavía la conversación por teléfono.

El servidor, la base persistente y la web quedaron iniciados. El teléfono de pruebas no
estaba bloqueado y quedaban 5 llamadas de cuota. Las llamadas automáticas quedaron apagadas.
El webhook HMAC fue registrado con la URL del túnel actual y el backend cargó ese secreto.
La sonda local acepta firma válida y rechaza la inválida.

**Pendiente externo:** las dos URLs nuevas entregadas por Cloudflare no resolvieron en DNS
(NXDOMAIN), aunque el conector reportó conexión activa. Por tanto todavía no está comprobada
la entrega pública del resultado de una llamada. Antes de probar el ciclo completo, vuelve a
ejecutar `npm run webhook:selftest` y exige que pase. Si haces una prueba de voz con la entrega
caída, puedes recuperar el resultado posteriormente con **Sincronizar** en el
Dashboard o `npm run calls:sync`; esto no reemplaza la validación del webhook.

Documentación del proveedor: [personalización y variables por llamada](https://elevenlabs.io/docs/eleven-agents/customization/personalization).
La rama opcional `ELEVENLABS_AGENT_BRANCH_ID` también viaja en los datos de inicio de la llamada.

## Criterio B — declaraciones juradas (2026-09-11)

1. En Tablero Mock, mantén apagadas las llamadas mientras preparas una OC. Usa un inicio
   anterior al término y término de hace diez días; asigna ocho conectados y ocho DJ. El estado
   acompaña las fechas. La fila B debe quedar fuera de riesgo porque las DJ están completas.
2. En el detalle de contexto compartido de esa OC elige el contacto y teléfono de prueba.
   Activa el interruptor de llamadas y guarda en B un cambio a dos DJ. Ahora hay seis pendientes:
   la transición a CRITICO debe intentar una sola llamada. Guardar otra vez no llama nuevamente.
3. El agente debe confirmar identidad y preguntar por **declaraciones juradas del curso
   terminado**, incluso con ocho conectados de ocho inscritos (100% de conexión).
4. Prueba por separado: compromiso de coordinar declaraciones con fecha; reporte de que todas
   se entregaron; bloqueo de plataforma; dependencia de validación del OTIC; no volver a llamar.
   El historial debe conservar motivo `riesgo_dj_critico` y el resultado correspondiente.
5. Con automáticas apagadas, también puedes seleccionar la OC B en el Disparador. La confirmación
   muestra declaraciones pendientes y días desde cierre, junto con las variables del agente.
6. Completar las DJ antes de confirmar debe cancelar el disparo. Una OC con C crítico y sin riesgo
   A/B nunca debe originar llamada. Los umbrales editables de conexión no afectan a B.

Los días B usan `Math.ceil` tal como el semáforo original; los cortes se aplican al número
calculado por el backend. Las simulaciones de texto no sustituyen esta comprobación de voz.
