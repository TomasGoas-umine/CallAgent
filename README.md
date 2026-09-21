# Umine Voice (CallAgent)

Agente de voz que lee el **Semaforo operacional de Umine**, el tablero que vigila los cursos
SENCE, detecta las Ordenes de Compra en riesgo, llama por telefono a la persona responsable via
**Twilio y ElevenLabs**, conversa con ella y registra el resultado para seguimiento o derivacion a
un humano.

Este repo es el **MVP local**: un backend TypeScript mas un **micrositio de operacion** (`web/`)
para disparar y revisar llamadas a mano. Corre entero en tu maquina, sin AWS y, por defecto, sin
gastar un minuto de telefono.

> ## Ninguna llamada se dispara sola
>
> El plan de voz es **Starter**, con muy pocos minutos. Por eso **no hay cron, ni scheduler, ni
> polling, ni reintentos automaticos** habilitados (ADR-010).
>
> **Solo dos caminos pueden originar una llamada, y los dos nacen de un click de una persona:**
> el **Disparador** del micrositio, con modal de confirmacion obligatorio, y el **Tablero Mock**,
> cuando guardas una OC y ese cambio la vuelve llamable con el interruptor de su seccion
> encendido. Los dos terminan en `originateManualCall` y `dispatchFollowup`, que revalida todo por
> su cuenta. El **Tablero Original nunca llama**: es de solo lectura.
>
> Ademas hay una **whitelist dura de la etapa de pruebas** (`TELEFONOS_ETAPA_PRUEBAS` en
> `src/utils/env.ts`): hoy solo pueden sonar dos numeros. Cualquier otro se rechaza con
> `fuera_de_whitelist_pruebas` (403) **aunque este en la allowlist**. Es un cerrojo de etapa: no lo
> saques ni agregues numeros sin una decision explicita.

## Quickstart

Node 24. El `package.json` declara `>=24 <25`; con 22 funciona pero avisa.

```bash
npm install
cp .env.example .env         # los defaults ya son seguros: MOCK_PROVIDERS=true

npm run local:up             # DynamoDB local (dynalite, o Docker; ver CLAUDE.md)
npm run local:create-tables
npm run local:seed
npm run local:server         # API en http://localhost:3000

# en otra terminal: el micrositio
npm run web:install
npm run web:dev              # http://localhost:5173
```

Con eso ya se opera a mano, en **modo simulacion**: el disparador funciona de punta a punta pero
contra `MockElevenLabsClient`, asi que no suena ningun telefono. Para llamar de verdad, ver
[la guia completa](docs/GUIA-COMPLETA.md#llamadas-reales-salir-del-modo-simulacion).

> ⚠️ **`npm run local:server` no recarga solo** (`tsx` sin `--watch`, a proposito: el store del
> Tablero Mock vive en memoria del proceso). Si tocaste `src/` y el micrositio muestra tablas
> vacias o errores 404, el server quedo con codigo viejo: paralo y volve a levantarlo.

## Que vas a ver

El micrositio tiene cuatro vistas:

| Vista                | Que es                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **Tablero Mock**     | El banco de pruebas. OCs simuladas y editables: moves los datos y ves como reacciona el Semaforo |
| **Tablero Original** | El dato real del Semaforo, estrictamente de lectura                                              |
| **Dashboard**        | Los seguimientos con su resultado y transcripcion, mas el historial del agente                   |
| **Disparador**       | Elegir una OC llamable, confirmar en el modal y disparar UNA llamada                             |

El Semaforo evalua cada OC por **tres criterios independientes a la vez**: riesgo de conexion (A),
declaraciones juradas pendientes (B) y rectificacion (C). **A y B pueden originar llamadas; C
nunca** (ADR-012).

El resultado de una llamada vuelve al proyecto por **tres caminos** que comparten la misma logica:
`npm run calls:sync` contra la API de ElevenLabs, una segunda pasada contra Twilio para las
llamadas que nadie atendio, y el webhook post-call en tiempo real.

## Donde seguir leyendo

| Archivo                                 | Para que                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| **`docs/GUIA-COMPLETA.md`**             | **Empeza por aca.** Como funciona por dentro, la API completa, llamadas reales, estado |
| `CLAUDE.md`                             | Comandos, convenciones y reglas de seguridad. Leelo si vas a tocar codigo              |
| `docs/context/PROJECT_CONTEXT.md`       | Contexto de negocio: que es el Semaforo, SENCE, las declaraciones juradas              |
| `docs/context/ESTADO-PROYECTO.md`       | Resumen del proyecto entero, para pegar en otra herramienta                            |
| `docs/SEMAFORO_INTEGRACION.md`          | Contrato del `tablero-api`, paginacion, umbrales y limitaciones                        |
| `docs/architecture/ARCHITECTURE.md`     | Modelo de datos single table, handlers y flujo                                         |
| `docs/architecture/DECISIONS.md`        | ADRs, es decir por que las cosas son como son                                          |
| `docs/architecture/CALL-HISTORY.md`     | Historial del agente y conexion del webhook local                                      |
| `docs/architecture/ELEVENLABS-AGENT.md` | El agente de ElevenLabs: prompt, variables y como configurarlo                         |
| `docs/PRUEBAS_MANUALES_AGENTE.md`       | Guia de casos de prueba con el Tablero Mock                                            |
| `docs/spec.csv`                         | Backlog completo, 67 tickets, 17 abiertos                                              |
| `docs/status/`                          | Inventarios y auditorias fechadas                                                      |
| `web/README.md`                         | El micrositio y sus decisiones deliberadas                                             |

## Calidad

```bash
npm run build          # tsc --noEmit
npm run lint
npm run format:check
npm test               # 402 tests (unit e integracion contra dynalite real)

npm run web:build      # tsc --noEmit mas vite build del micrositio
npm run web:test       # 80 tests del front
```

**Ningun test llama de verdad a Twilio ni a ElevenLabs**, ni tampoco el demo ni el micrositio en
modo local: todo corre contra `MockElevenLabsClient`, y `MOCK_PROVIDERS=true` es el default.

## Estado

**Modo simulacion, operable de punta a punta.** El Semaforo completo, el Tablero Mock editable, el
disparo manual con todos los guardrails, el registro de llamadas y el historial del agente estan
implementados y con tests. `infra/` (CDK) esta construido pero **no desplegado**, y todavia declara
una `events.Rule` de cron que hay que deshabilitar antes de cualquier despliegue (UV-042).

Los pendientes con nombre y apellido estan en
[la guia completa](docs/GUIA-COMPLETA.md#estado-actual-y-pendientes) y en `docs/spec.csv`.
