# kj-supervisor

Supervisor de Kujira. Container Docker que vive en cada VPS de un
cliente, mantiene una conexión WebSocket persistente con el control
(`kj-backend`) y orquesta los containers de los agentes Claude locales.

> **Estado**: MVP completo (handshake, spawn/stop/pause/resume, métricas,
> drift detection, reconciliación, auto-update). Ver [CLAUDE.md](CLAUDE.md)
> para visión, stack y protocolo.

## Instalación en un VPS

```bash
curl -fsSL https://kujira.run/install-supervisor.sh | \
    KJ_CONTROL_URL=https://api.kujira.so \
    KJ_PROVISIONING_TOKEN=kjprov_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
    sh
```

El script detecta el OS, instala Docker si falta, crea
`/etc/kj-supervisor/` y lanza el container `kj-supervisor` con la
imagen `ghcr.io/calltek/kj-supervisor:latest`.

## Quickstart (dev local sin Docker)

```bash
# 1. Instalar dependencias
bun install

# 2. Descargar el wire format del control local
bun run pull-protocol:dev

# 3. Crear un Server desde el panel del backend → copia el provisioning_token
cat > .env <<EOF
KJ_CONTROL_URL=http://localhost:5050
KJ_PROVISIONING_TOKEN=kjprov_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOF

# 4. Arrancar el supervisor
mkdir -p local/etc-kj-supervisor
KJ_CONFIG_DIR=./local/etc-kj-supervisor KJ_LOG_LEVEL=debug bun --watch src/main.ts
```

Esperado en primer arranque:

```
supervisor starting
auth resolved { mode: "provisioning" }
socket connected, waiting for control:ready
control:ready received
agent_token persisted to disk
handshake complete { protocol_version: 1 }
pong { server_time: ... }            ← cada 30s
```

Tras el primer handshake, `local/etc-kj-supervisor/token` contiene el
`agent_token` persistente (mode `0600`). Reinicios posteriores leen ese
token del disco y el control acepta la reconexión sin necesidad del
`provisioning_token` (que ya fue consumido).

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `KJ_CONTROL_URL` | sí | — | URL base del control (`http://localhost:5050`, `https://api.kujira.so`). |
| `KJ_PROVISIONING_TOKEN` | en bootstrap | — | Token de un solo uso. Tras el primer handshake se descarta. |
| `KJ_AGENT_TOKEN` | no | — | Override del token persistente. Útil en dev; en prod se lee del disco. |
| `KJ_CONFIG_DIR` | no | `/etc/kj-supervisor` | Dónde guardar el `token`. |
| `KJ_SUPERVISOR_CONTAINER` | en Docker | — | Nombre del propio container. Necesario para el blue/green self-upgrade. |
| `KJ_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Arranca `src/main.ts` con watch. |
| `bun run start` | Arranca `src/main.ts` sin watch. |
| `bun run pull-protocol[:dev]` | Descarga `src/protocol.ts` del control (prod / `localhost:5050`). |
| `bun run check` | Lint + format check con Biome. |
| `bun run lint` | Lint + format con auto-fix. |
| `bun test` | Tests unit con Bun. |
| `bun run build` | Compila a `dist/` (tras `prebuild` que refresca el protocolo). |

## Protocolo con el control

Documentación operativa completa:
[kj-backend/docs/supervisor-protocol.md](../kj-backend/docs/supervisor-protocol.md).

Fuente de verdad del wire format:
[kj-backend/src/modules/agent-gateway/protocol.ts](../kj-backend/src/modules/agent-gateway/protocol.ts).

## Estructura

Ver [CLAUDE.md §6](CLAUDE.md#6-estructura-del-repo-planeada).

## Licencia

Privado, Calltek.
