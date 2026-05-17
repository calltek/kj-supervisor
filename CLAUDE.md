# Kujira — Supervisor (`kj-supervisor`)

Container Docker que vive en cada VPS de un cliente de Kujira. Mantiene
una conexión WebSocket persistente con el control (`kj-backend`) y
orquesta el ciclo de vida de los agentes Claude locales: levanta,
detiene, pausa, reanuda y reporta el estado real.

> **Estado actual**: repo recién creado. Sin código aún. La primera tarea
> es el **Hito 1 — handshake mínimo** (ver §9). El protocolo está
> totalmente especificado del lado control y testeado contra un cliente
> simulado.

---

## 1. Visión

El supervisor es la **única pieza** que el cliente instala en su propio
VPS. Habla con el control en `api.kujira.run` por una conexión Socket.IO
persistente y traduce comandos del control en operaciones Docker sobre
el host:

```
┌──────────────────────────────┐         ┌────────────────────────────────┐
│ kj-backend (control)         │         │ VPS del cliente                │
│ - api.kujira.run             │◀──TLS──▶│ ┌────────────────────────────┐ │
│ - Postgres = fuente verdad   │         │ │ kj-supervisor              │ │
│ - Socket.IO server /agents   │         │ │  - 1 container Docker      │ │
└──────────────────────────────┘         │ │  - 1 WS al control         │ │
                                          │ │  - bind: docker.sock       │ │
                                          │ │  - bind: /etc/kj-supervisor│ │
                                          │ └────────────────────────────┘ │
                                          │                                │
                                          │ ┌────────────────────────────┐ │
                                          │ │ Containers de agentes      │ │
                                          │ │  - kj-agent-sales:0.1.0    │ │
                                          │ │  - kj-agent-support:0.1.0  │ │
                                          │ │  - ...                     │ │
                                          │ └────────────────────────────┘ │
                                          └────────────────────────────────┘
```

**Tres responsabilidades**:

1. **Mantener viva la conexión** con el control (auth, hello, ping).
2. **Recibir comandos** versionados y ejecutarlos vía Docker
   (spawn/stop/pause/resume).
3. **Reportar** el estado real (push de `agent:status`, `agent:metrics`,
   `agent:log`).

El supervisor **NO**:

- Habla HTTP con el control (todo va por WS).
- Expone puertos en el host (solo egress saliente).
- Ejecuta código del cliente (eso lo hacen los containers de agentes,
  él solo los orquesta).
- Almacena estado de negocio (el control y los volúmenes lo tienen).

---

## 2. Modelo de despliegue

### 2.1 Instalación

El cliente recibe del operador (vía panel admin) un comando del estilo:

```bash
curl -fsSL https://kujira.run/install-supervisor.sh | \
    KJ_PROVISIONING_TOKEN=kjprov_... KJ_CONTROL_URL=https://api.kujira.run sh
```

El script instala Docker si falta, crea `/etc/kj-supervisor/`, lanza el
container del supervisor y desaparece. El supervisor toma el control
desde ahí.

### 2.2 El container del supervisor

```bash
docker run -d \
  --name kj-supervisor \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/kj-supervisor:/etc/kj-supervisor \
  -e KJ_CONTROL_URL=https://api.kujira.run \
  -e KJ_SUPERVISOR_CONTAINER=kj-supervisor \
  ghcr.io/calltek/kj-supervisor:latest
```

**Mínimo de privilegios fuera del docker socket** — sin `--privileged`,
sin `--cap-add`, sin red de host.

### 2.3 Persistencia local

`/etc/kj-supervisor/` (montado dentro del container) guarda:

- `token` — el `agent_token` persistente, modo `0600`. Sin él, el
  supervisor no puede reconectarse y tiene que volver a aprovisionarse.
- `config.json` (futuro) — overrides locales si los necesitamos.

Volúmenes por agente (creados al spawn):

- `kj-agent-<agent_id>-data` — montado en `/home/agent/` dentro de cada
  container de agente. Aquí viven `.claude/skills/`, `.claude/memories/`
  y datos persistentes del agente.

---

## 3. Stack

| Capa | Elección | Notas |
|---|---|---|
| Runtime | **Bun 1.x** | TS nativo, sin transpile en dev. Mismo runtime que el control. |
| Lenguaje | TypeScript 5.9+ | strict mode. |
| Socket.IO | `socket.io-client` v4 | Cliente, no servidor. El control es el servidor. |
| Docker | `dockerode` o spawn de `docker` CLI | Decidir al implementar Hito 2. dockerode es más expresivo, CLI más simple. |
| Lint + format | **Biome 2** | Mismo que el control. |
| Tests | `bun test` para unit, vitest para integración Docker (futuro) | |
| Logging | Pino estructurado | Vuelca a stdout (Docker recoge). |
| Build | Bun + Dockerfile multi-stage | Imagen final Alpine. |

### Convenciones heredadas de kj-backend

- **Idioma del código**: inglés. Comentarios, errores, logs.
- **Naming**:
  - Ficheros: `snake_case.suffix.ts` o `kebab-case.ts`.
  - Clases: `PascalCase` con prefijo `KJ` para primitivas propias.
  - snake_case para campos de objetos y wire format (`agent_id`, `tokens_used`).
- **Estructura**: `src/` con módulos. Cada módulo autocontenido.
- **Sin punto y coma, comillas simples, 4 espacios, ancho 100**.

---

## 4. El protocolo con el control (resumen)

> **Fuente de verdad**: el fichero `protocol.ts` se descarga del control
> en build time. Ver §5 más abajo.
>
> **Especificación completa** con secuencias, ejemplos y errores:
> [kj-backend/docs/supervisor-protocol.md](../kj-backend/docs/supervisor-protocol.md).
> Léelo entero antes de implementar nada.

### 4.1 Flujo a alto nivel

```
1. Supervisor → conecta a /agents con auth.{provisioning|agent}_token
2. Control    → emite `control:ready` cuando termina la auth
3. Supervisor → emite `server:hello` con versión + containers vivos
4. Control    → ack `{ accepted: true, agent_token? }`  (token solo 1ª vez)
              → reconcilia BD ↔ supervisor en background
5. Supervisor → bucle de `health:ping` cada 30s
6. Supervisor → recibe `agent:spawn` / `agent:stop` / `agent:pause` /
                `agent:resume` y los ejecuta vía Docker
7. Supervisor → push `agent:status`, `agent:metrics`, `agent:log` cuando
                pase algo digno de reportar
```

### 4.2 Eventos a implementar

| Evento | Dirección | Quién implementa |
|---|---|---|
| **Inmutables** (siempre fluyen) | | |
| `control:ready` | C → A push | escuchar y disparar `server:hello` |
| `server:hello` | A → C ack | emitir con `containers: docker ps` |
| `health:ping` / `pong` | A → C ack | loop cada 30s |
| `server:metrics` | A → C ack | loop cada 60s, leer `/proc` |
| `supervisor:upgrade-required` | C → A push | blue/green swap (Hito 6) |
| `protocol:error` | bidi push | log + disconnect |
| **Versionados** (requieren versión común) | | |
| `agent:spawn` | C → A ack | `docker pull` + `docker run` |
| `agent:stop` | C → A ack | `docker stop`/`kill` |
| `agent:pause` | C → A ack | `docker pause` |
| `agent:resume` | C → A ack | `docker unpause` |
| `agent:status` | A → C push | tras spawn / stop / health check |
| `agent:metrics` | A → C push | loop por container |
| `agent:log` | A → C push | drenar `docker logs` |

---

## 5. Cómo se obtiene `protocol.ts`

El backend expone su `protocol.ts` (la fuente de verdad del wire format)
en un endpoint público:

```
GET https://api.kujira.run/protocol   →  text/typescript
```

Mismo patrón que vcs-astro usa para `swagger.json`. Tener un script
`scripts/pull-protocol.ts` que se ejecute en `prebuild`:

```typescript
// scripts/pull-protocol.ts
import { writeFileSync } from 'fs'

const env = process.argv[2] || 'production'
const url =
    env === 'development'
        ? 'http://localhost:5050/protocol'
        : 'https://api.kujira.run/protocol'

console.log(`🌍 Pulling protocol from ${url}`)
const source = await fetch(url).then((r) => r.text())
writeFileSync('./src/protocol.ts', source)
console.log(`✓ Wrote ${source.length} bytes`)
```

```json
// package.json
{
  "scripts": {
    "prebuild": "bun run scripts/pull-protocol.ts",
    "pull-protocol": "bun run scripts/pull-protocol.ts",
    "pull-protocol:dev": "bun run scripts/pull-protocol.ts development"
  }
}
```

Cada `bun run build` recompila el supervisor contra la versión más
reciente del protocolo. Si el control bumpea `PROTOCOL_VERSION` el
siguiente build del supervisor lo refleja automáticamente.

### Drift en CI

```bash
diff <(cat src/protocol.ts) <(curl -s https://api.kujira.run/protocol)
```

---

## 6. Estructura del repo (planeada)

```
kj-supervisor/
├── CLAUDE.md                 ← este fichero
├── README.md                 ← quickstart + scripts
├── package.json
├── bunfig.toml
├── biome.json
├── tsconfig.json
├── Dockerfile                ← multi-stage Alpine
├── docker-compose.yml        ← dev local con backend en localhost:5050
├── scripts/
│   └── pull-protocol.ts      ← descarga protocol.ts del control
└── src/
    ├── main.ts               ← entry point: arranca client + handlers
    ├── protocol.ts           ← generado, NO editar a mano
    ├── config/
    │   └── settings.ts       ← variables de entorno + validación
    ├── client/
    │   ├── control.client.ts ← conexión Socket.IO al control
    │   ├── auth.ts           ← lectura/escritura del token de disco
    │   └── reconnect.ts      ← backoff exponencial
    ├── handlers/
    │   ├── agent-spawn.handler.ts
    │   ├── agent-stop.handler.ts
    │   ├── agent-pause.handler.ts
    │   ├── agent-resume.handler.ts
    │   └── supervisor-upgrade.handler.ts
    ├── reporters/
    │   ├── health.reporter.ts          ← health:ping loop
    │   ├── server-metrics.reporter.ts  ← server:metrics loop
    │   ├── agent-status.reporter.ts    ← agent:status push helpers
    │   ├── agent-metrics.reporter.ts   ← agent:metrics loop por agent vivo
    │   └── agent-log.reporter.ts       ← drena docker logs
    ├── docker/
    │   ├── client.ts         ← wrapper sobre dockerode/CLI
    │   ├── volumes.ts        ← crear/escribir volúmenes de agente
    │   └── containers.ts     ← spawn/stop/pause/resume primitives
    └── reconcile/
        └── boot.ts           ← docker ps al arrancar, lista containers para server:hello
```

No es definitiva — irá ajustándose. Pero es buen norte para el Hito 1.

---

## 7. Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `KJ_CONTROL_URL` | sí | URL del control (`https://api.kujira.run`). |
| `KJ_PROVISIONING_TOKEN` | en bootstrap | Token de un solo uso del operador. Tras el primer handshake se borra del disco. |
| `KJ_AGENT_TOKEN` | tras bootstrap | Token persistente. Se guarda en `/etc/kj-supervisor/token` mode `0600`. |
| `KJ_CONFIG_DIR` | no | Default `/etc/kj-supervisor`. Override para dev. |
| `KJ_LOG_LEVEL` | no | Default `info`. `debug`, `warn`, `error` válidos. |
| `KJ_PING_INTERVAL_MS` | no | Default `30000`. |
| `KJ_METRICS_INTERVAL_MS` | no | Default `60000`. |

---

## 8. Decisiones tomadas (heredadas del backend)

### Protocolo `pull` y nada de push externo
Decidido en kj-backend §6 (2026-05-03). El supervisor inicia y mantiene
la conexión. El control nunca abre una conexión al VPS. Solo el WS
existente puede entregar comandos al supervisor.

### Skills/memorias se entregan en `agent:spawn`
El supervisor las escribe al volumen ANTES de levantar el container. El
agente Claude **dentro** del container no habla con el backend — solo
lee de su volumen local. Defensa en profundidad.

### `agent_token` solo viaja una vez
El control responde el `agent_token` en el ack de `server:hello` solo
si el supervisor entró con `provisioning_token`. **Guárdalo a disco
inmediatamente** o se pierde para siempre y el operador tiene que
regenerar el provisioning desde el panel.

### Source of truth = base de datos del control
Si el supervisor tiene un container vivo que el control no conoce
("orphan"), el control le manda `agent:stop force=true` en el siguiente
`server:hello`. Si el control cree que un agente está RUNNING y el
supervisor no lo lista ("ghost"), el control lo flipa a ERROR.

### Sin replay de comandos perdidos
Si `agent:spawn` se manda durante una desconexión, no se acumula. Al
reconectar, el operador (o el panel) reintenta. Lo cubre la
reconciliación + decisión humana.

---

## 9. Hoja de ruta (6 hitos)

> El alcance de cada hito está pensado para ser commiteable, probable y
> útil por sí solo. Mismo patrón que el kj-backend.

### Hito 1 — Handshake mínimo

**Objetivo**: el supervisor conecta al control, autentica, mantiene viva
la conexión con `health:ping`. **Sin Docker todavía**. Sin nada más.

- `scripts/pull-protocol.ts` que descarga `protocol.ts`.
- `src/config/settings.ts` con env vars validados.
- `src/client/auth.ts` con lectura/escritura del token.
- `src/client/control.client.ts` con Socket.IO + auth + reconexión.
- `src/main.ts` arranca el cliente, escucha `control:ready`, emite
  `server:hello { containers: [] }`, guarda `agent_token` si vino.
- Loop de `health:ping` cada 30s.
- Tests: unit del auth helper. Integración manual contra `localhost:5050`.

**Validación**: con `kj-backend` corriendo en local y un Server creado
desde el panel, el supervisor debe pasar el handshake, ver el server en
ONLINE en BD, y seguir vivo indefinidamente.

### Hito 2 — Spawn un container Alpine de prueba

**Objetivo**: handler de `agent:spawn` que ejecuta `docker run`. La
imagen no necesita ser real — puede ser `alpine:latest` con
`sleep infinity` para validar el flujo Docker.

- `src/docker/client.ts` wrapper.
- `src/docker/containers.ts` con `spawn`, `inspect`.
- `src/handlers/agent-spawn.handler.ts` que ack inmediato + push
  `agent:status { status: RUNNING, container_id }` cuando el container
  está vivo.
- Label `kj-agent` en cada container para descubrirlos luego.

### Hito 3 — Stop / pause / resume + push de status

- Handlers de los 3 eventos restantes.
- Cada uno mata/pausa el container y push del status final correspondiente.

### Hito 4 — `server:metrics` y `agent:metrics`

- Reporter de host: `/proc/loadavg` + `/proc/uptime`.
- Reporter por agente: `docker stats --no-stream` para tokens/cost
  (cuando exista esa info; por ahora solo uptime).

### Hito 5 — Reconciliación en el `server:hello`

- `docker ps --filter "label=kj-agent" -q` al boot.
- Mapeo container ↔ agent_id desde el label `kj-agent-id=<n>` que
  añadimos al spawn.
- Mandar el array en `server:hello.containers`.

### Hito 6 — Auto-update del propio supervisor

- Handler de `supervisor:upgrade-required`.
- `docker pull <target_image_tag>`.
- Blue/green swap del propio container con el volumen `/etc/kj-supervisor`
  compartido.
- La nueva instancia notifica al control "soy la nueva", la antigua se
  apaga.

---

## 10. Cómo construir y probar localmente

> A escribir mientras se implementa el Hito 1.

Plan provisional:

```bash
# Setup
bun install
bun run pull-protocol:dev   # descarga protocol.ts de localhost:5050

# Dev
bun --watch src/main.ts

# Build de imagen Docker
docker build -t kj-supervisor:dev .
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ./local/etc-kj-supervisor:/etc/kj-supervisor \
  -e KJ_CONTROL_URL=http://host.docker.internal:5050 \
  -e KJ_PROVISIONING_TOKEN=kjprov_xxx \
  -e KJ_SUPERVISOR_CONTAINER=kj-supervisor \
  kj-supervisor:dev
```

---

## 11. Referencias

- **Especificación del protocolo** (lectura obligada):
  [kj-backend/docs/supervisor-protocol.md](../kj-backend/docs/supervisor-protocol.md).
- **Arquitectura completa de Kujira**:
  [kj-backend/docs/architecture.md](../kj-backend/docs/architecture.md).
- **Estado de negocio (backend)**:
  [kj-backend/CLAUDE.md](../kj-backend/CLAUDE.md).
- **Fuente de verdad del wire format**:
  [kj-backend/src/modules/agent-gateway/protocol.ts](../kj-backend/src/modules/agent-gateway/protocol.ts).
- **Tests del control que simulan supervisores** (excelente referencia
  para validar tu implementación):
  [kj-backend/src/modules/agent-gateway/tests/](../kj-backend/src/modules/agent-gateway/tests/) y
  [kj-backend/src/modules/agent/tests/agent-lifecycle.e2e.ts](../kj-backend/src/modules/agent/tests/agent-lifecycle.e2e.ts) /
  [agent-reconcile.e2e.ts](../kj-backend/src/modules/agent/tests/agent-reconcile.e2e.ts).
