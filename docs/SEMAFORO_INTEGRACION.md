# Integracion con el Semaforo (`tablero-api`)

Como CallAgent lee el Semaforo operacional de Umine, que parte de la logica reimplementa y por
que, y donde termina la responsabilidad de cada repo.

**Fuente de verdad:** el repo `micrositio-operaciones-tablero-sence`. Cada regla citada aca
lleva el archivo y la linea de donde salio. Si este documento y ese repo se contradicen, **gana
ese repo** y esto es un bug que hay que corregir aca.

Verificado contra produccion el **2026-09-09**. Snapshot anonimizado de esa verificacion:
`test/fixtures/tablero_search_real_anonymized.json`.

---

La revisión B/C contra la fuente local indicada por el usuario y la configuración independiente
de llamadas DJ se documentan en [Auditoría B/C](status/AUDITORIA-SEMAFORO-B-C-2026-09-11.md).

## 1. Que es el Semaforo

Umine es una OTEC chilena: gestiona cursos financiados por SENCE. Cada curso es una Orden de
Compra (OC) de un cliente, con alumnos que **deben conectarse a la plataforma SENCE** durante el
curso para justificar la franquicia tributaria.

El Semaforo (`/semaforo`, `src/pages/StatusCursosPage.tsx`) es la pagina donde operaciones ve
que cursos van atrasados. Es **100% de lectura**: no escribe nada a DynamoDB.

## 2. El hallazgo que gobierna todo este diseno

> **El backend no clasifica nada. "CRITICO" se calcula en el browser.**

En las ~2.400 lineas del Lambda `tablero-api` no aparecen las palabras `CRITICO` ni `ALERTA`, ni
el concepto de semana de curso, ni un umbral. El unico `pctConexion` del backend es un KPI global
plano en `/tablero/stats`, sin relacion con las secciones.

| Capa                             | Que hace                                                                                                                                                             | Que NO hace                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `execution-sence` (DynamoDB)     | 1 registro **por alumno**: `sence_connections` 0/1, `dj` 0/1, `order_status`, fechas, `otic_amount`                                                                  | nada agregado por curso                            |
| `tablero-api` `handleSearch`     | escanea `po`, consulta `execution-sence` por OC y mergea; reparte monto `total_amount / students_count`; filtra por fecha, `dj`, `sence_connections`, `order_status` | no agrupa por curso, no calcula %, no asigna nivel |
| `useSenceData.ts` (browser)      | promueve `order_status` por fechas, filtra `DEAD_ESTADOS`, agrupa en `courseRows`                                                                                    | —                                                  |
| `StatusCursosPage.tsx` (browser) | `getCourseWeek` → `WEEK_THRESHOLDS` → `clasificarConexion` → filtros de seccion                                                                                      | —                                                  |

**Consecuencia directa:** no se le puede pedir a la API "dame los cursos criticos". Ese concepto
no existe del lado del servidor. Para saberlo hay que bajar el dataset y recalcularlo. Por eso
CallAgent tiene un adaptador; no es duplicacion gratuita, es la unica opcion disponible hoy.

**Segunda consecuencia:** "critico" no esta guardado en ningun lado. No hay columna ni flag. Un
curso entra y sale del Semaforo solo, porque `Date.now()` es un input del calculo.

## 3. Las tres secciones

Cada seccion tiene su propio filtro de entrada y su propia escala. **No comparten umbrales.**

| Seccion                 | Pregunta                                                             | Clasificacion                                        | En CallAgent     |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ---------------- |
| **A · Riesgo Conexion** | ¿que OCs en ejecucion van atrasadas en % de conexion para su semana? | `clasificarConexion()` L71-76                        | **implementada** |
| **B · Riesgo DJ**       | ¿que cursos ya terminados tienen conectados sin Declaracion Jurada?  | `criticidadDj()` L83-87 (>3d EN RIESGO, >7d CRITICO) | **implementada** |
| **C · Rectificacion**   | ¿que OCs llevan mucho esperando la OC Final del OTIC?                | dias desde `max(updated_at)`, visible >3d            | **implementada** |

Las tres se muestran en Tablero Mock y Tablero Original. **A y B pueden originar llamadas**
(ADR-012): A sigue participación; B sigue declaraciones juradas con el contacto responsable.
C sigue siendo informativa. Si B depende de validación del OTIC o de una corrección administrativa,
el agente deriva a revisión humana; no firma declaraciones ni promete modificar SENCE.

Las tres escalas son independientes y no se comparan entre si: A mide porcentaje contra la semana
del curso, B y C miden dias. Un CRITICO de una seccion no equivale al de otra.

> ⚠️ El semaforo Rojo/Amarillo/Verde `<30%`/`30-70%`/`>70%` del docstring de
> `StatusCursosPage.tsx:5` **no gobierna ninguna seccion**. Solo se usa en el KPI agregado
> "% Conexion Global" (`senceTheme.ts:148`). No lo uses como referencia.

## 4. Agregacion por OC

`tablero-api` entrega registros **por alumno**. Todo el Semaforo razona **por OC**. La conversion
esta en `useSenceData.ts:120-222` y portada en `src/services/order-status-promoter.ts`.

Orden de operaciones (importa, y cada paso fue un bug cuando falto):

1. **Normalizar fechas** (`src/utils/dates.ts`) — defensa propia de CallAgent, ver §7.
2. **Promover `order_status` por fechas** — `useSenceData.ts:97-106`. Antes de filtrar, para no
   descartar por un estado vacio que en realidad era un curso en operacion.
   - `end_course` pasado → `OBTENIENDO DJ`
   - `init_course` pasado → `CURSO EN OPERACIÓN`
   - `init_course` futuro → `NO INICIADA`
   - salvo que el estado ya este en `DEAD_ESTADOS` o `MANUAL_ESTADOS`.
3. **Descartar `DEAD_ESTADOS`** (`BAJA`, `ANULADA`, `ELIMINADA`, `FACTURADA`, `FACTURADO`).
   En el snapshot real, **515 de 801 registros** caen aca. Si no se filtran, inflan los inscritos
   y hunden el % de cualquier OC mixta.
4. **Descartar OCs sin numero y de otros equipos** (prefijo `INT`, HOT-183).
5. **Agrupar** por `` `${client_id || client_name || 'Sin cliente'}||${order_number}` ``.
6. **Contar** — no leer:
   - `inscritos` = cantidad de registros del grupo, **excluyendo** `REVISAR`/`BAJA`/`ANULADA`
     (`INACTIVE_STATUSES`, HOT-137+139).
   - `conectados` = registros con `sence_connections === 1`. **`=== 1`, no `> 0`, no una suma.**
   - `pctConexion = conectados / inscritos`.
7. **Derivar el estado de la OC** como el mas frecuente entre los alumnos activos. Si no hay
   ninguno activo, se conserva el estado inicial — **nunca se vacia**: el estado vacio pasa el
   gate de "en ejecucion" y una OC enteramente dada de baja entraria como si estuviera corriendo.

## 5. Umbrales y filtros de la seccion A

**Semana de curso** (`getCourseWeek`, `StatusCursosPage.tsx:52-62`) — por progreso temporal, no
por dias calendario: `progress = (now - init) / (end - init)`; `<0.25`→S1, `<0.5`→S2, `<0.75`→S3,
resto→S4. Fechas invalidas → S1.

**Umbrales** (`WEEK_THRESHOLDS`, L64-69):

| Semana | Esperado | ALERTA | CRITICO                 |
| ------ | -------- | ------ | ----------------------- |
| S1     | 20%      | `<20%` | nunca (no aplica en S1) |
| S2     | 60%      | 55-59% | `<55%`                  |
| S3     | 90%      | 80-89% | `<80%`                  |
| S4     | 98%      | 90-97% | `<90%`                  |

**Filtro de entrada de la seccion** (`StatusCursosPage.tsx:528-536`) — distinto de la
clasificacion, y el que faltaba en CallAgent:

- la OC esta **en ejecucion**: `order_status` contiene `OPERACI` o `EJECUCI`, **o viene vacio**;
- el curso **no termino**: `end_course` futuro, o sin fecha;
- la conexion **no esta completa**: `pctConexion < 100%`.

Y despues, ya clasificado, el Semaforo **descarta `NORMAL`** de la tabla (L568).

**Orden de la lista** (L570-578): cliente → OC → `CRITICO` antes que `ALERTA` → menor % primero.
No es "urgencia primero": agrupa por cliente para poder llamar por todas sus OCs de una vez.

## 5-bis. Umbrales y filtros de las secciones B y C

Otras dos escalas, las dos en DIAS. **No comparten nada con la seccion A** — ni semana de curso,
ni porcentaje, ni umbrales. Portadas en `urgency-classifier.ts` (`clasificarDj`,
`clasificarRectificacion`) y `semaforo-sections.ts` (`gateSeccionB`, `gateSeccionC`).

**B · Riesgo DJ** (`criticidadDj`, `StatusCursosPage.tsx:83-87`):

| Dias desde el cierre | Nivel                                      |
| -------------------- | ------------------------------------------ |
| `> 7`                | CRITICO                                    |
| `> 3`                | ALERTA (el original lo rotula "EN RIESGO") |
| resto                | NORMAL (el original lo rotula "PENDIENTE") |

Filtro de entrada (`L584-590` + `L619`): el curso **ya termino**; hay **al menos un conectado**;
la DJ **no esta completa** (`djp / conectados < 1`); y lleva **mas de 3 dias** cerrado.

> El denominador son los CONECTADOS, no los inscritos (`c.sence_connections`, no `c.inscritos`).
> Y el gate de "al menos un conectado" no es cosmetico: sin el, `0/0` haria entrar como "DJ
> incompleta" a toda OC cerrada sin un solo conectado — donde no hay ninguna DJ que pedir.

**C · Rectificacion** (`StatusCursosPage.tsx:1245`, `:1258`):

| Dias esperando al OTIC | Nivel   |
| ---------------------- | ------- |
| `> 30`                 | CRITICO |
| `> 15`                 | ALERTA  |
| resto                  | NORMAL  |

En el original estos dos cortes no son una funcion con nombre: estan en el **color de la celda**
"Dias Pendiente". Se portaron con nombre para que sean una regla y no un estilo.

Filtro de entrada (`L628-631` + `L657`): el `order_status` contiene `ESPERA` o `RECTIFIC`, y
lleva **mas de 3 dias** en ese estado. Los dias salen de `max(updated_at)` de los registros de la
OC — es un **proxy**, no la fecha real en que se pidio la rectificacion: ese dato no existe, y el
SENCE Sync tambien toca `updated_at`. El original lo prefiere igual antes que usar `end_course`,
que daba "60 dias pendiente" para una rectificacion pedida ayer.

Los dos gates usan `Math.ceil` sobre la diferencia de dias, igual que el original: una fecha
anclada a medianoche leida a media tarde da 1 dia, no 0. Se replica el borde, no se corrige.

**Ninguna de las dos puede terminar en una llamada** (ADR-011): se muestran en los dos tableros
y se editan en el Mock, pero `call-rules.ts` no las conoce.

## 6. Contrato real de `GET /tablero/search`

Verificado contra prod, no asumido.

```
GET {base}/tablero/search?limit=2000[&cursor=...][&order_status=...]
→ 200 { "items": [...], "total": n, "nextCursor": "651"|null, "hasMore": true|false }
```

- **El sobre es `items`.** No `data`. Leer `payload.data` devuelve `undefined` y el cliente
  retorna vacio **sin error** — indistinguible de "hoy no hay candidatos".
- **Parametros que el Lambda conoce:** `limit`, `cursor`, `order_status`, `sence_connections`,
  `dj` y filtros de fecha. **`seccion` no existe** — mandarlo era un no-op silencioso.
- **Sin autenticacion efectiva:** el API responde sin token. `REQUIRE_AUTH` no esta en `true` en
  prod. CallAgent manda el Bearer igual si esta configurado.
- **Campos que NO existen** y que no hay que asumir: `enrolled_count`, telefono de cualquier
  tipo, `do_not_call`, `last_sence_sync`.
- **Campos que si existen y sorprenden:** `student_email` (poblado en ~64% de los registros),
  `po_students_count` (snapshot del header del PO — **el Semaforo no lo usa** para inscritos, y
  CallAgent tampoco debe).
- **`updated_at` tiene tipos mezclados:** ISO string en 534 registros y epoch en milisegundos
  (number) en 267, del mismo snapshot. Ver §7.

### 7. Paginacion

**La paginacion es real y hay que seguirla.** Sin `limit`, una sola llamada devolvio **4.042 de
5.943 registros** con `hasMore: true` — quien no siga el cursor ve el 68% del dataset y cree que
lo vio todo.

- `nextCursor` es un **indice de segmento sobre la tabla `po`**, no un offset de items: la
  cantidad de items por pagina no coincide con `limit`. Se usa tal cual, sin interpretarlo.
- `limit` por pagina en CallAgent: **2000** (`DEFAULT_PAGE_LIMIT`). Sin limit, la respuesta pesa
  ~4,5 MB y tarda ~10,7 s, cerca del `Function.ResponseSizeTooLarge` (~6 MB) que el Lambda
  arrastra. Con 2000, el dataset completo entra en **3 paginas**.
- Cinturones de seguridad en `HttpTableroApiClient`: tope de `MAX_PAGES` (50), deteccion de
  cursor que no avanza, y un `truncado: true` que viaja hasta el micrositio.
- ⚠️ La copia local del Lambda en el repo del Semaforo (`lambda_tablero_api/index.mjs:512`)
  devuelve `nextCursor: null, hasMore: false` — **esta desactualizada respecto de prod**. No la
  uses como referencia del contrato.

## 8. Responsabilidades de cada repo

```
micrositio-operaciones-tablero-sence          CallAgent
──────────────────────────────────            ─────────────────────────────────
tablero-api (join + filtros)          ──────► HttpTableroApiClient  (paginacion, contrato)
useSenceData.ts (agregacion)          ──────► order-status-promoter (portado 1:1)
StatusCursosPage.tsx (umbrales)       ──────► urgency-classifier    (portado 1:1)
StatusCursosPage.tsx (filtro seccion) ──────► semaforo-sections     (portado 1:1)
                                              course-lookup         (compone los 4)
                                                     │
                                              ─────────────────────────────────
                                              LO PROPIO DE CallAgent:
                                              a quien llamar, cuando, cooldown,
                                              cuota, allowlist, ventana horaria,
                                              idempotencia, revalidacion,
                                              seguimiento post-llamada
```

**Reglas:**

1. **CallAgent nunca escribe a `tablero-api`.** Fuente de solo lectura.
2. **Los 4 modulos portados son espejo.** Un cambio de umbral o de regla alla exige el cambio
   equivalente aca. No hay nada automatico que lo detecte — ver §9.
3. **El micrositio de CallAgent (`web/`) no clasifica nada.** Recibe `nivel`, `semana`,
   `pctConexion` y `visibleEnSemaforo` ya resueltos de `GET /api/tablero`. Hay un test que falla
   si alguien copia umbrales al front: `web/test/sin-logica-semaforo.spec.ts`.
4. **`GET /api/tablero` ES el adaptador.** Hace del lado del backend exactamente lo que el
   Semaforo hace en el browser, y lo entrega resuelto.

### Por que no se embebe la vista original

Se evaluo reutilizar `StatusCursosPage` directamente. No es viable hoy, por tres razones
concretas:

- **No se puede importar:** vive en otro repo, son 88 KB acoplados a Chakra UI v3, Emotion, su
  `ThemeContext` y su `DashboardLayout`.
- **No se puede montar en un iframe simple:** su `AppShell.tsx:110` hace
  `if (!isEmbedded) return <StandalonePlaceholder />`, con
  `isEmbedded = window.self !== window.top` (`useParentContext.ts:5`). Exige el handshake
  `postMessage` del core de Umine (`UMINE_CHILD_READY` → `UMINE_PARENT_CONTEXT` →
  `UMINE_CHILD_ACK`). Se puede simular, pero atarse a eso significa depender de que el token del
  core siga sin validarse.
- **Aunque se pudiera, no serviria:** un iframe no admite las columnas y acciones que son la
  razon de ser del tablero de CallAgent (telefono, `do_not_call`, boton de disparo, modal de
  confirmacion).

**Lo que se hizo en cambio:** replicar la SELECCION (`visibleEnSemaforo`) y el ORDEN exactos de
la seccion A, consumir toda la logica del backend, y enlazar al Semaforo original desde el
tablero (`VITE_SEMAFORO_URL` / `window.__UMINE_SEMAFORO_URL__`).

## 8-bis. Los dos tableros del micrositio

El micrositio tiene cuatro vistas, en este orden: **Tablero Mock**, **Tablero Original**,
**Dashboard**, **Disparador**. Los dos tableros leen fuentes distintas y **no se mezclan nunca**.

|              | Tablero Mock                                                        | Tablero Original                               |
| ------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| Fuente       | `mock-tablero-store.ts` (memoria del proceso, sembrado del fixture) | `tablero-api` real, via `HttpTableroApiClient` |
| Endpoint     | `GET/PATCH /api/tablero/mock`                                       | `GET /api/tablero/original`                    |
| Secciones    | A, B y C (las tres editables)                                       | A, B y C (las tres de solo lectura)            |
| Editable     | si                                                                  | **no** — estrictamente lectura                 |
| Puede llamar | si (con el toggle encendido)                                        | **nunca**                                      |
| Cliente      | `MockTableroApiClient`, via `buildTableroApiClient()`               | construido a mano en la ruta                   |
| Carga        | al montar la app                                                    | bajo demanda (la lectura real tarda ~25 s)     |

**Como se garantiza que no se mezclan:** los caminos que pueden originar una llamada
(`candidate-evaluator`, `originateManualCall`, `dispatchFollowup`) toman su cliente de
`buildTableroApiClient()`, que con `TABLERO_API_MODE=fixture` devuelve el **Mock**. El Tablero
Original construye su `HttpTableroApiClient` dentro de su propia ruta y ese objeto no se pasa a
ningun servicio de originacion. No hay forma de que el dato real termine disparando una llamada.

### Que se puede editar en el Mock, y por que solo eso

Exactamente los campos que el Semaforo real usa para calcular criticidad, y ni uno mas. Agregar
montos, RUT u OTIC seria inventar reglas que el original no tiene.

| Campo                 | Seccion | Donde interviene en el original                                                       |
| --------------------- | ------- | ------------------------------------------------------------------------------------- |
| `orderStatus`         | A y C   | promocion por fechas + filtro `DEAD_ESTADOS` + gate de seccion (`useSenceData.ts:97`) |
| `initCourse`          | A       | `getCourseWeek` (`StatusCursosPage.tsx:52`)                                           |
| `endCourse`           | A y B   | `getCourseWeek` + gates de curso terminado (`:533` y `:584`)                          |
| `inscritos`           | A       | CANTIDAD de registros activos por OC (`useSenceData.ts:169`)                          |
| `conexiones`          | A y B   | registros con `sence_connections === 1` (`useSenceData.ts:171`)                       |
| `djs`                 | B       | registros con `dj === 1` — `djp` (`useSenceData.ts:177`)                              |
| `ultimaActualizacion` | C       | `max(updated_at)` de la OC (`StatusCursosPage.tsx:632-645`)                           |

El Mock dibuja las TRES secciones como vinetas colapsables y cada tabla edita los campos de SU
criterio; son tres vistas del mismo juego de OCs, no tres listas. **A y B tienen columna
«¿Llama?»** y reciben la decision resuelta del backend. C sigue informativa (ADR-012).

Dos reglas de validacion propias del Mock, que el dato real no impone pero el editor si:

- `djs <= conexiones` — la seccion B divide DJ sobre conectados; mas DJs que conectados daria
  porcentajes sobre 100 sin representar ningun escenario que el Semaforo muestre distinto.
- `ultimaActualizacion` se escribe como `updated_at` de todos los registros expandidos de la OC.
  Antes se ponia "ahora" en cada lectura: los dias pendientes daban siempre 0 y la seccion C era
  literalmente inalcanzable desde el Mock.

Al guardar, el backend recalcula semana, porcentaje, los niveles de las tres secciones y la
decision de llamada, y devuelve el tablero entero. **El micrositio no calcula nada** —
`web/test/sin-logica-semaforo.spec.ts` falla si alguien copia umbrales al front.

### Umbrales de llamada vs. criticidad del Semaforo

Son dos cosas distintas y esa separacion es deliberada (`src/services/call-rules.ts`):

- **La criticidad del Semaforo NO es configurable.** Se calcula siempre con `WEEK_THRESHOLDS`,
  espejo del original. Si se pudiera editar, el tablero dejaria de servir como referencia.
- **Los umbrales de LLAMADA si.** Deciden cuando el agente marca. Arrancan iguales a los
  `criticoBelow` del Semaforo, asi que por defecto "dispara llamada" == "el Semaforo lo marca
  CRITICO". Se editan en un modal y se ven siempre en el panel al pie del tablero, con el valor
  activo, el valor original y un boton de restaurar.

Cambiar los umbrales o encender el toggle **no llama por si solo**: re-alinea el estado de cada
OC primero. Sin eso, bajar un umbral originaria de golpe una llamada por cada OC que quedo en
condicion — todas al mismo unico telefono.

### Los tres cerrojos contra llamadas repetidas

`src/services/mock-call-trigger.ts`, en orden. Cada uno ataja un modo de repeticion distinto:

1. **Toggle de llamadas automaticas** — apagado por defecto. Sin el, arrancar el server bastaria
   para que sonara un telefono.
2. **Transicion de estado** — solo se llama en el flanco no→si. Guardar la misma OC diez veces,
   o que el micrositio recargue, no dispara nada.
3. **Cooldown por OC** (`MOCK_CALL_COOLDOWN_SECONDS`, default 300 s) — corta el "flapping" de
   editar de critico a normal y de vuelta. Es **por OC**, no por contacto: todas las OCs del Mock
   comparten un telefono, y un cooldown por contacto congelaria el tablero entero tras la primera
   llamada.

Y por debajo, la idempotencia de `originateManualCall`: la key incluye la secuencia de disparo de
la OC (`mock:{cliente}:{oc}:{n}`), asi que dos requests del mismo flanco originan UNA llamada.

### Whitelist dura de la etapa de pruebas

`src/services/guardrails.ts` — segunda barrera, independiente de `ALLOWLIST_NUMBERS`:

- `ALLOWLIST_NUMBERS` es configuracion de operacion y cambia seguido.
- La whitelist es un **cerrojo de etapa**: mientras se prueben llamadas reales, ningun numero
  fuera de ella suena, por mas que alguien lo agregue a la allowlist o lo escriba a mano en el
  Disparador. Default: `+56956194817`, el unico numero que usan todos los contactos del Mock.
- Se evalua DESPUES de la allowlist, para no cambiar el motivo de rechazo de los numeros que ya
  estaban fuera. Motivo propio: `fuera_de_whitelist_pruebas` (HTTP 403).
- `TEST_PHONE_WHITELIST` existe solo para que la suite use sus numeros sinteticos.

⚠️ `do_not_call` es **permanente por diseno** (consentimiento, ver `ContactRepository`). No hay
endpoint que lo revierta, y "Restaurar datos" del Mock tampoco lo toca. Si el numero de pruebas
queda marcado durante una llamada real, la unica salida es limpiar la base local:
`npm run local:down && rm -rf .dynamo-local-data`.

## 9. Limitaciones actuales

| #   | Limitacion                                                                          | Impacto                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **No existe telefono** en toda la cadena `po → pod → execution-sence → tablero-api` | Con `TABLERO_API_MODE=http` hay CRITICOs pero **cero llamables**. Bloqueante de negocio UV-023, no un bug. `student_email` si existe y es un canal real sin decision tomada.                                       |
| 2   | **La logica esta duplicada en 3 lugares** (2 en el Semaforo, 1 aca)                 | Un cambio de umbral en uno solo hace que clasifiquen distinto y **nada lo detecta**.                                                                                                                               |
| 3   | **`REQUIRE_AUTH` apagado en prod**                                                  | El Semaforo entero es legible sin credenciales. No es de CallAgent, pero conviene que este escrito.                                                                                                                |
| 4   | **No hay `last_sence_sync` en la respuesta**                                        | No se puede saber que tan fresco es el dato; solo `updated_at`, que tambien se mueve con ediciones manuales. Desfase real de hasta ~30 min (cron del SENCE Sync).                                                  |
| 5   | **C no llama; B admite seguimiento verbal**                                         | B permite seguimiento con el responsable (ADR-012). C no llama. `tablero-api` sigue siendo de solo lectura: no se completa una DJ ni se pide una OC Final desde aca.                                               |
| 6   | **El snapshot de test es un congelado**                                             | `tablero_search_real_anonymized.json` no se regenera solo. Si el contrato cambia, los tests siguen pasando contra el contrato viejo. Regenerar con `npm run semaforo:capture-sample` cuando se sospeche un cambio. |

### Las cuatro incompatibilidades que se corrigieron

Sobrevivieron porque el fixture sintetico probaba la **clasificacion** pero ningun test miraba
una **respuesta real**. Las tres primeras eran silenciosas: producian cero candidatos sin error.

| #   | Sintoma                                    | Causa                                                            |
| --- | ------------------------------------------ | ---------------------------------------------------------------- |
| 1   | `search()` devolvia `[]` siempre           | leia `payload.data`; el API devuelve `items`                     |
| 2   | Veia el 68% del dataset                    | ignoraba `nextCursor` (la auditoria decia "siempre null")        |
| 3   | Todo clasificaba `ALERTA`, nunca `CRITICO` | sumaba `enrolled_count`, campo inexistente → `pctConexion = NaN` |
| 4   | Cursos ya terminados como candidatos       | faltaban los gates de entrada de la seccion A                    |

## 10. Relacion con el flujo de llamadas

```
tablero-api  ──► HttpTableroApiClient ──► groupOrders ──► gateSeccionA ──► clasificarConexion
                                                                                  │
                                                            candidatoALlamada = A + CRITICO
                                                                                  │
                        ┌─────────────────────────────────────────────────────────┤
                        ▼                                                         ▼
              GET /api/tablero (micrositio)                          candidate-evaluator
                        │                                             (solo a mano, sin cron)
                        ▼                                                         │
              el operador aprieta el boton                                        │
                        ▼                                                         ▼
              POST /api/calls ──► originateManualCall ──► dispatchFollowup ──► ElevenLabs+Twilio
                                                                  │
                                          revalida contra el Semaforo, allowlist,
                                          cooldown, cuota, ventana horaria,
                                          escritura condicional READY→DIALING
```

**Ninguna llamada se dispara sola** (ADR-010). El unico origen es un humano apretando el boton.
`dispatchFollowup` **revalida** el curso contra el Semaforo justo antes de marcar: si dejo de ser
CRITICO o salio de su seccion original (A o B) entre que el operador lo vio y aprieta, no se llama.

**Observabilidad.** Cada lectura emite `semaforo_lectura` con: paginas, registros recibidos,
descartes desglosados (estado muerto / sin OC / OC de otro equipo / alumno inactivo), OCs
agrupadas, OCs fuera de la seccion A por motivo, OCs en seccion A, distribucion por nivel y
criticas. Existe para separar **"hoy no hay candidatos"** de **"la lectura esta rota"** — los dos
se ven igual desde afuera, y esa ambiguedad es la que dejo pasar las cuatro incompatibilidades.

Para mirarlo sin tocar nada:

```bash
npm run semaforo:probe                                    # contra el fixture
npm run semaforo:probe -- --http --base-url https://<gw>  # contra el API real, solo lectura
```

## 11. Evolucion posterior: mover la agregacion a `tablero-api`

El adaptador de CallAgent existe **solo** porque `tablero-api` no entrega OCs agregadas ni
clasificadas. Si algun dia lo hiciera, `order-status-promoter`, `semaforo-sections` y
`urgency-classifier` desaparecen de este repo y la duplicacion baja de 3 copias a 1.

Forma tentativa (no implementada, no acordada):

```
GET /tablero/cursos?seccion=A
→ { items: [ { client_id, order_number, course_name, init_course, end_course,
               order_status, inscritos, conectados, pct_conexion,
               semana, nivel, dias_restantes } ], ... }
```

Beneficios: una sola definicion de "critico" para todos los consumidores; el frontend del
Semaforo deja de bajar 15.000 registros para agregarlos en el browser; se puede filtrar por
seccion del lado del servidor.

**Esto requiere modificar el repo `micrositio-operaciones-tablero-sence`, que NO se toco en este
trabajo.** Cambiarlo implica ademas migrar `useSenceData.ts` e `InicioBPage.tsx` para que
consuman el nuevo endpoint en vez de su copia local, o quedan tres definiciones en vez de una.
Es un cambio con riesgo sobre una pagina en produccion: no se hace sin decidirlo explicitamente.

---

## Referencia rapida de archivos

| Archivo                                            | Que es                                  |
| -------------------------------------------------- | --------------------------------------- |
| `src/services/tablero-api-client.http.ts`          | contrato + paginacion                   |
| `src/services/order-status-promoter.ts`            | promocion de estado + agregacion por OC |
| `src/services/semaforo-sections.ts`                | filtros de entrada de la seccion A      |
| `src/services/urgency-classifier.ts`               | semana de curso + umbrales              |
| `src/services/course-lookup.ts`                    | compone los 4 + observabilidad          |
| `src/utils/dates.ts`                               | normalizacion ISO/epoch                 |
| `scripts/semaforo-probe.ts`                        | lectura en seco, no dispara nada        |
| `scripts/capture-real-sample.ts`                   | regenera el snapshot anonimizado        |
| `test/integration/http-tablero-api-client.spec.ts` | tests de contrato sobre dato real       |
| `web/test/sin-logica-semaforo.spec.ts`             | guarda: el front no clasifica           |
