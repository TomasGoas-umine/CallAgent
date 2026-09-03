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

```bash
npm run build      # tsc --noEmit + vite build -> dist/
npm run typecheck
npm test           # vitest (jsdom)
```

## Las tres vistas

| Vista          | Que muestra                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tablero**    | Los cursos del Semaforo con urgencia, cliente, curso, OC, semana, % de conexion, dias restantes, contacto y telefono **enmascarado**. Filtro por urgencia.                                 |
| **Dashboard**  | Los followups con estado, origen, duracion, resultado clasificado y campos extraidos. Fila expandible (pide el detalle al abrirse) con la transcripcion completa. Refresco solo con boton. |
| **Disparador** | Elegir un curso CRITICO + un numero de la allowlist, ver el modal de confirmacion y disparar UNA llamada.                                                                                  |

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
