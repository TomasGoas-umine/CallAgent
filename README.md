# Umine Voice

Agente de voz que detecta situaciones urgentes en el "Semaforo" operacional de Umine (riesgo
de conexion de alumnos a SENCE), llama automaticamente via Twilio + ElevenLabs, conversa con
la persona, y registra el resultado para seguimiento o derivacion a un humano.

Este repo contiene el **esqueleto MVP**, pensado para probarse 100% en local (sin AWS real,
sin llamadas reales). Ver `CLAUDE.md` para comandos, convenciones y reglas de seguridad;
`docs/context/PROJECT_CONTEXT.md` para el contexto de negocio; `docs/architecture/` para la
arquitectura y las decisiones tomadas; `docs/bpmn/` para los diagramas de proceso;
`docs/spec.csv` para el backlog.

## Quickstart

```bash
npm install
cp .env.example .env   # editar segun CLAUDE.md antes de correr el demo

npm run local:up             # DynamoDB local (dynalite o Docker, ver CLAUDE.md)
npm run local:create-tables
npm run local:seed
npm run local:server &
npm run local:demo
```

## Calidad

```bash
npm run build   # tsc --noEmit
npm run lint
npm test
```

No se realizan llamadas reales a Twilio/ElevenLabs en ningun test ni en el demo local — todo
corre contra implementaciones mock (ver `CLAUDE.md`).
