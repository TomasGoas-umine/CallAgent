# Umine Voice

Agente de voz que detecta situaciones urgentes en el "Semaforo" operacional de Umine (riesgo
de conexion de alumnos a SENCE), llama via Twilio + ElevenLabs, conversa con la persona, y
registra el resultado para seguimiento o derivacion a un humano.

Este repo contiene el **MVP local**: backend TypeScript + un **micrositio de operacion**
(`web/`) para disparar y revisar llamadas a mano. Se prueba 100% en local, sin AWS real y sin
llamadas reales.

> ## Ninguna llamada se dispara sola
>
> El plan de voz es **Starter**: muy pocos minutos. Por eso **no hay cron, ni scheduler, ni
> polling, ni reintentos automaticos** habilitados. La unica forma de originar una llamada es
> que una persona apriete el boton en el micrositio (`POST /api/calls`). Cada disparo pasa por
> revalidacion contra el Semaforo, allowlist, ventana horaria, cuota diaria persistente y una
> escritura condicional anti doble disparo. Si vas a tocar algo de esto, lee primero
> `CLAUDE.md` y `docs/architecture/DECISIONS.md` (ADR-010).
>
> `infra/` (CDK, **no desplegado**) todavia declara una `events.Rule` de cron para el
> evaluador: **hay que deshabilitarla antes de cualquier despliegue** (ticket UV-042).

Documentacion: `CLAUDE.md` (comandos, convenciones y reglas de seguridad) ·
`docs/context/PROJECT_CONTEXT.md` (contexto de negocio) · `docs/architecture/` (arquitectura y
ADRs) · `docs/bpmn/` (diagramas de proceso) · `docs/spec.csv` (backlog) ·
`docs/status/` (inventarios de estado) · `web/README.md` (micrositio).

## Quickstart

```bash
npm install
cp .env.example .env   # editar segun CLAUDE.md antes de correr

npm run local:up             # DynamoDB local (dynalite o Docker, ver CLAUDE.md)
npm run local:create-tables
npm run local:seed
npm run local:server         # API en http://localhost:3000

# en otra terminal: el micrositio
npm run web:install
npm run web:dev              # http://localhost:5173
```

Con eso ya se puede operar a mano: la pestana **Tablero** muestra los 15 cursos del Semaforo,
**Disparador** dispara una llamada (simulada) y **Dashboard** muestra el resultado.

El flujo automatico (evaluador en lote) sigue existiendo y se puede probar con
`npm run local:demo` — ver `CLAUDE.md`.

## API de operacion

| Metodo | Ruta             | Que hace                                                                                           |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`    | Kill switch, `DRY_RUN`, `MOCK_PROVIDERS`, cuota usada/restante, ventana horaria, allowlist         |
| GET    | `/api/tablero`   | Los 15 cursos con urgencia, semana, % de conexion, dias restantes, contacto y telefono enmascarado |
| GET    | `/api/calls`     | Followups con su ultimo resultado clasificado                                                      |
| GET    | `/api/calls/:id` | Detalle del followup + todas sus llamadas con transcripcion                                        |
| POST   | `/api/calls`     | **Dispara UNA llamada manual.** `Idempotency-Key` obligatoria                                      |

Codigos de `POST /api/calls`:

| Codigo | Cuando                                                                                 |
| ------ | -------------------------------------------------------------------------------------- |
| 201    | La llamada se origino (`dialing`)                                                      |
| 200    | La misma `Idempotency-Key` ya se uso (`already_processed`) — no se origina una segunda |
| 400    | Falta `Idempotency-Key` o falta `clientId`/`orderNumber`/`phone`                       |
| 403    | El numero no esta en la allowlist, o el destinatario esta `do_not_call`                |
| 404    | La OC ya no aparece en el Semaforo                                                     |
| 409    | Fuera de la ventana horaria, o el curso ya no es CRITICO                               |
| 429    | Cuota diaria agotada                                                                   |
| 503    | `KILL_SWITCH=true`                                                                     |
| 502    | El proveedor rechazo la originacion                                                    |

## Calidad

```bash
npm run build          # tsc --noEmit
npm run lint
npm run format:check
npm test               # 117 tests (unit + integracion contra dynalite real)

npm run web:build      # tsc --noEmit + vite build del micrositio
npm run web:test       # 20 tests del front (vitest + jsdom)
```

No se realizan llamadas reales a Twilio/ElevenLabs en ningun test, ni en el demo, ni desde el
micrositio en modo local — todo corre contra `MockElevenLabsClient` (`MOCK_PROVIDERS=true` es
el default). Ver `CLAUDE.md`, seccion "Reglas de seguridad".
