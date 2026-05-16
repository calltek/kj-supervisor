# kj-agent

Supervisor de Kujira. Container Docker que vive en cada VPS de un
cliente, mantiene una conexión WebSocket persistente con el control
(`kj-backend`) y orquesta los containers de los agentes Claude locales.

> **Estado**: repo recién creado. Sin código aún. Ver [CLAUDE.md](CLAUDE.md)
> para visión, stack, protocolo, estructura planeada y la hoja de ruta
> de 6 hitos.

## Inicio rápido (cuando exista código)

```bash
bun install
bun run pull-protocol:dev   # descarga src/protocol.ts del control en localhost:5050
bun --watch src/main.ts
```

## Estructura

Ver [CLAUDE.md §6](CLAUDE.md#6-estructura-del-repo-planeada).

## Protocolo con el control

Documentación operativa completa:
[kj-backend/docs/supervisor-protocol.md](../kj-backend/docs/supervisor-protocol.md).

Fuente de verdad del wire format:
[kj-backend/src/modules/agent-gateway/protocol.ts](../kj-backend/src/modules/agent-gateway/protocol.ts).

## Licencia

Privado, Calltek.
