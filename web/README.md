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
- **El telefono nunca se muestra completo en el tablero.** La API devuelve solo `***1234`. El
  numero completo entra solo por el desplegable de la allowlist (que viene de `/api/health`), y
  ahi tambien se muestra enmascarado.
- **Nunca hay input libre de telefono.** El desplegable se puebla **solo** con
  `ALLOWLIST_NUMBERS`. Si la allowlist esta vacia, el boton queda deshabilitado con esa razon
  visible.
- **El modal de confirmacion es obligatorio.** El boton "Disparar llamada…" solo abre el modal;
  el `POST /api/calls` sale unicamente del boton del modal (hay un test que lo verifica).
- **La idempotency key se genera al abrir el modal**, no al confirmar: si el operador hace doble
  click en "Confirmar", el segundo POST llega con la misma key y el backend responde
  `already_processed` sin originar una segunda llamada.
- **El banner de modo es permanente y no se puede cerrar.** La diferencia entre
  `MOCK_PROVIDERS=true` y `false` es la diferencia entre una simulacion y gastar minutos reales.

## Razones de bloqueo del boton

`razonesDeBloqueo()` en `src/components/Disparador.tsx` calcula y muestra el motivo (kill switch,
cuota agotada, allowlist vacia, numero fuera de allowlist, curso no CRITICO, fuera de ventana
horaria). Es **solo UX**: el backend vuelve a evaluar todo y es el que manda (403 / 429 / 503).
Nunca se origina una llamada sin pasar por `POST /api/calls`.
