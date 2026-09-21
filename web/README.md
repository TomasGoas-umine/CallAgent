# web/ — micrositio de operacion de Umine Voice

React + Vite, sin libreria de UI (CSS plano, todo prefijado con `uv-`). Paquete
**independiente** del repo raiz: tiene su propio `package.json`, su propio `tsconfig.json` y su
propio `node_modules`. No importa nada de `../src` — las formas de las respuestas de la API se
declaran a mano en `src/types.ts`, a proposito, para que este directorio se pueda mover tal cual
a un core de Umine.

## Correrlo

Necesita el server local del repo raiz corriendo (es quien expone `/api/*`):

```bash
# terminal 1, en la raiz del repo
npm run local:up && npm run local:create-tables && npm run local:seed
npm run local:server

# terminal 2
cd web
npm install
npm run dev        # http://localhost:5173
```

En desarrollo Vite proxea `/api` a `http://localhost:3000` (configurable con
`UMINE_VOICE_API_TARGET`), asi que el front siempre llama a rutas relativas y no hace falta CORS.

> ⚠️ **Vite recarga solo; el server de la raiz NO.** Si cambiaste algo en `../src` y las tablas
> aparecen vacias, el server del `:3000` quedo con codigo viejo: paralo y volve a correr
> `npm run local:server`. El cliente HTTP detecta ese caso y lo dice explicitamente en vez de
> mostrar "Not Found" (ver `src/api.ts` y `test/api.spec.ts`).

```bash
npm run build      # tsc --noEmit + vite build -> dist/
npm run typecheck
npm test           # vitest (jsdom)
```

## Las cuatro vistas

| Vista                | Que muestra                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tablero Mock**     | OCs simuladas y **editables** en la propia tabla, en las TRES secciones del Semaforo (A Riesgo Conexion, B Riesgo DJ, C Rectificacion) como vinetas colapsables. Al guardar, el backend recalcula las tres. **Las secciones A y B pueden originar una llamada REAL** (ADR-012), cada una con su propio interruptor; **C nunca llama.** |
| **Tablero Original** | El dato real de `tablero-api`, **estrictamente de lectura**: las TRES secciones del Semaforo (A Riesgo Conexion, B Riesgo DJ, C Rectificacion) en vinetas colapsables. No crea candidatos, ni seguimientos, ni llamadas.                                                                                                               |
| **Dashboard**        | Los followups con estado, origen, duracion, resultado clasificado y campos extraidos. Fila expandible con la transcripcion. Refresco solo con boton.                                                                                                                                                                                   |
| **Disparador**       | Elegir un curso CRITICO + un numero de la allowlist, ver el modal de confirmacion y disparar UNA llamada.                                                                                                                                                                                                                              |

**Solo el Tablero Mock y el Disparador pueden llamar.** El Tablero Original no tiene ningun boton
de disparo y no debe tenerlo; hay un test que lo verifica.

### Tablero Mock — decisiones deliberadas

- **El guardado es explicito, por fila.** No se guarda al teclear: una edicion puede originar una
  llamada telefonica real, asi que tiene que ser un acto deliberado. La fila con cambios sin
  guardar queda resaltada.
- **Solo se editan los campos que el Semaforo real usa para la criticidad**, y cada seccion edita
  los de SU criterio (ver la tabla de abajo). Ni montos, ni RUT, ni OTIC: no intervienen en
  ninguna de las tres. La lista de estados del desplegable la manda el backend, no esta
  hardcodeada aca.
- **Las tres secciones son tres vistas del MISMO juego de OCs**, no tres listas distintas: la
  misma OC se evalua por los tres criterios a la vez, igual que en el Semaforo real. Puede estar
  en dos secciones al mismo tiempo, o en ninguna. Cada tabla muestra todas las OCs, con las de su
  seccion primero y, para el resto, el motivo por el que quedan fuera — es un editor, y hace
  falta poder agarrar una OC cualquiera y llevarla a la seccion que se quiere probar.
- **Hay un interruptor de llamadas automaticas POR SECCION**, dentro de la vineta de cada
  tablero, y arranca apagado. Encender el de riesgo de conexion **no** enciende el de
  declaraciones juradas: son dos criterios distintos y el operador prueba uno a la vez. Encender
  uno tampoco llama por si solo — hace falta guardar una edicion que produzca la transicion en
  esa seccion. La seccion C no tiene interruptor porque no llama.
- **El interruptor vive dentro del `<summary>`**, que es el mismo elemento que colapsa la
  seccion: por eso el `<label>` detiene la propagacion del click. Sin eso, encender las llamadas
  ademas cerraba el tablero. Hay un test que lo fija.
- **El panel de configuracion al pie siempre esta visible**, con el umbral activo por semana, el
  valor original del Semaforo, cuales estan modificados y un boton para restaurar. Se editan en
  un modal. Esos umbrales deciden **cuando se llama**, no la criticidad que muestra el tablero.
- **Los telefonos de terceros van enmascarados.** La unica excepcion es la whitelist de pruebas
  que se muestra completa al pie: es el numero del propio operador, misma regla que ya aplica la
  allowlist en `GET /api/health`.

#### Que edita cada seccion, y cual llama

| Seccion                 | Campos editables ahi                                                                       | ¿Llama?                       |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| **A · Riesgo Conexion** | estado, inicio, termino, inscritos, conexiones, contacto/empresa/curso y telefono de la OC | si, con su interruptor        |
| **B · Riesgo DJ**       | termino del curso, conectados, con DJ                                                      | si, con SU propio interruptor |
| **C · Rectificacion**   | estado de la OC, ultima actualizacion                                                      | **no** — sin interruptor      |

Una OC pertenece a **una sola** seccion de voz a la vez y el backend la decide (`evaluation.seccion`):
si esta en riesgo de DJ llama por declaraciones juradas, y si no, por conexion. De ahi salen el
motivo del agente (`riesgo_dj_critico` / `riesgo_conexion_critico`) y **cual de los dos
interruptores la gobierna**. El front no lo recalcula.

La seccion C **no tiene forma de llamar**: no es que el boton este escondido, es que no existe un
interruptor para ella y el backend rechaza con `seccion_invalida` cualquier intento de
encenderla. Una OC Final que no llega se resuelve con el OTIC, no con el alumno (ADR-011).

La seccion A arranca abierta y las otras dos cerradas: entrar al tablero no puede significar tres
tablas largas de golpe.

### Tablero Original — las tres secciones del Semaforo

Cada seccion es una **vineta colapsable** con su contador de OCs, igual que en el micrositio
original. Las tres tienen su propia escala y **no se comparan entre si**:

| Seccion                 | Criterio                                                  | Escala                      |
| ----------------------- | --------------------------------------------------------- | --------------------------- |
| **A · Riesgo Conexion** | % de conexion contra lo esperado para la semana del curso | umbrales por semana (S1-S4) |
| **B · Riesgo DJ**       | dias que lleva el curso cerrado sin Declaracion Jurada    | >3d ALERTA, >7d CRITICO     |
| **C · Rectificacion**   | dias que lleva la OC esperando la OC Final del OTIC       | >15d ALERTA, >30d CRITICO   |

Las tres salen de **una sola** lectura de `tablero-api` (`readSemaforoSecciones`) y llegan ya
filtradas y clasificadas por el backend: este directorio solo filtra por nivel, ordena y pinta.
El filtro "Filtro por urgencia" se aplica a las tres a la vez; `Como el Semaforo` significa "lo
que el Semaforo real muestra en cada seccion" (en A eso esconde los NORMAL; en B y C no hay nada
extra que esconder porque el gate ya lo hizo del lado del backend).

**Ninguna de las tres puede llamar aca**, y B y C no pueden llamar en ningun lado: una DJ que
falta o una OC Final que no llega se resuelven con el OTIC, no con el alumno (ADR-011).

### Tablero Original — carga bajo demanda + cache

Leer `tablero-api` de verdad son ~6.000 registros paginados y tarda ~22 s. Por eso:

- **No se carga al montar la app**: se lee la primera vez que se abre esa pestana. El resto del
  micrositio no espera por eso.
- **El backend cachea la lectura 5 minutos** (`ORIGINAL_CACHE_TTL_MS`), asi que volver a la
  pestana es instantaneo. El dato de fondo solo cambia cada 30 min (cron del SENCE Sync), asi que
  la cache no puede mostrar nada mas viejo de lo que ya estaria sin ella. El boton **Recargar**
  manda `?refresh=1` y fuerza una lectura fresca.
- **Entrar a la pestana limpia el error anterior** y reintenta. Sin eso, un fallo en la primera
  visita (tipico: el server local con codigo viejo) dejaba la pestana en blanco para siempre
  hasta recargar la pagina entera.

### La regla que no se puede romper

`web/` **no clasifica nada**. No hay umbrales, ni semanas de curso, ni estados del Semaforo
hardcodeados en este directorio: todo llega calculado desde el backend.
`test/sin-logica-semaforo.spec.ts` falla si alguien copia esa logica aca. Ver
`docs/SEMAFORO_INTEGRACION.md` §8-bis en la raiz del repo.

## Decisiones que no se deben deshacer sin pensarlo

- **`base: './'` y cero rutas absolutas.** El micrositio se embebe bajo un path que hoy no
  conocemos. Los assets del build son relativos y **no hay router**: las tres vistas se cambian
  con estado local (`useState`), asi el micrositio no se apropia de la URL del host.
- **La base de la API es configurable en runtime.** `src/api.ts` resuelve, en orden:
  `window.__UMINE_VOICE_API_BASE__` -> `VITE_API_BASE` (build) -> `/api`. Para embeber, lo mas
  simple es setear el global antes de cargar el bundle.
- **Sin polling.** Los datos se cargan al montar y despues solo cuando el operador aprieta
  Refrescar (o despues de un disparo). Es deliberado: el plan es Starter y el sistema no debe
  hacer nada por su cuenta.
- **En el tablero los telefonos de terceros van enmascarados** (`***1234`). Los numeros
  AUTORIZADOS (los de `ALLOWLIST_NUMBERS`, que son del propio operador) si se muestran
  completos en el disparador y en el modal: el operador necesita ver a cual esta llamando, y el
  modal es el ultimo momento para darse cuenta de que se equivoco de numero.
- **El numero se puede escribir a mano.** El desplegable ofrece los autorizados, el del curso
  (marcado "NO autorizado" si no esta en la allowlist) y la opcion de escribirlo a mano —
  precargada con el del curso, porque el caso normal es tener que corregirlo (el telefono real
  no existe en la cadena de datos del Semaforo, ver UV-024).

  Esto **no** debilita la proteccion: el guardrail de allowlist vive en el backend, asi que
  cualquier numero fuera de `ALLOWLIST_NUMBERS` responde 403 sin llamar a nadie. El front solo
  adelanta el motivo y mantiene el boton bloqueado. **Nunca muevas el chequeo de allowlist al
  front, ni lo uses como si fuera la unica barrera.**

- **El precargado del numero pasa una sola vez**, al elegir "escribir a mano". No puede vivir en
  un efecto que reaccione a "el campo esta vacio": ahi se vuelve a llenar solo en cuanto el
  operador borra, y termina escribiendo sobre el numero viejo (bug real, ya corregido).
- **El modal de confirmacion es obligatorio.** El boton "Disparar llamada…" solo abre el modal;
  el `POST /api/calls` sale unicamente del boton del modal (hay un test que lo verifica).
- **La idempotency key se genera al abrir el modal**, no al confirmar: si el operador hace doble
  click en "Confirmar", el segundo POST llega con la misma key y el backend responde
  `already_processed` sin originar una segunda llamada.
- **El banner de modo es permanente y no se puede cerrar.** La diferencia entre
  `MOCK_PROVIDERS=true` y `false` es la diferencia entre una simulacion y gastar minutos reales.

## Razones de bloqueo del boton

`razonesDeBloqueo()` en `src/components/Disparador.tsx` calcula y muestra el motivo (kill switch,
cuota agotada, allowlist vacia, formato de telefono invalido, numero fuera de allowlist, curso no
CRITICO, fuera de ventana horaria). Es **solo UX**: el backend vuelve a evaluar todo y es el que
manda (403 / 429 / 503). Nunca se origina una llamada sin pasar por `POST /api/calls`.

## Paleta y tema (claro/oscuro)

Los colores son los del micrositio de **Cotizaciones** de Umine: teal como acento (botones
primarios, textos de enfasis, tab/opcion seleccionada, folios y OC), violeta como secundario
(origen del followup), superficies casi negras en oscuro, bordes de 1px y radios de 7–10px.

Todo vive en `src/styles.css` como **custom properties prefijadas** (`--uv-*`) declaradas en
`:root`, y los componentes solo consumen tokens — nunca hex directo. Reglas para no romperlo:

- **El tema lo decide el sistema operativo** (`@media (prefers-color-scheme: dark)`). No hay
  toggle ni preferencia guardada **a proposito**: el micrositio se embebe en un core de Umine que
  ya tendra el suyo, y un switch propio se desincronizaria del host. `index.html` declara
  `<meta name="color-scheme" content="light dark">` para que los controles nativos y los
  scrollbars sigan la misma preferencia.
- **El tema claro es el default en `:root`; el oscuro solo redefine tokens.** Ningun color se
  define unicamente dentro del `@media` — si no, el tema claro se queda sin ese valor.
- Los selectores de celda de tabla necesitan la misma especificidad que `.uv-table td`
  (`.uv-table td.uv-num`), si no el `text-align: left` base gana.
