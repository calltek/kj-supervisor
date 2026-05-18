# Kujira — Supervisor (`kj-supervisor`)

Container Docker que vive en cada VPS de un cliente de Kujira. Mantiene
una conexión WebSocket persistente con el control (`kj-backend`) y
orquesta el ciclo de vida de los agentes Claude locales: levanta,
detiene, pausa, reanuda y reporta el estado real.

> **Estado actual (2026-05-18)**: Hitos 1–5 vivos + **pipeline de
> stream del agente** (Hito 6 implementado por adelantado, ver §9). El
> supervisor mantiene la conexión, autentica con provisioning/agent
> token, negocia versión de protocolo, ejecuta `agent:spawn`/`stop`/
> `pause`/`resume` y, lo nuevo: hace `dockerode.attach` a cada
> container del agente, parsea su salida stream-json y reenvía cada
> evento al control como `agent:output`. También acepta `agent:input`
> del control y lo escribe al stdin del container. Adiós `tmux
> attach` para hablar con un agente.

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

**Cuatro responsabilidades**:

1. **Mantener viva la conexión** con el control (auth, hello, ping).
2. **Recibir comandos** versionados y ejecutarlos vía Docker
   (`agent:spawn`/`stop`/`pause`/`resume`).
3. **Reportar** el estado real (push de `agent:status`,
   `agent:metrics`).
4. **Hacer de relé bidireccional del stdio** de cada agente: leer su
   stream-json y reenviar cada evento como `agent:output`,
   `agent:auth_required` o `agent:error`; aceptar `agent:input` del
   control y escribirlo al stdin del container.

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
                `agent:resume` / `agent:input` y los ejecuta
7. Supervisor → para cada container vivo: attach a stdio, parse
                stream-json y push `agent:output` / `agent:auth_required`
                / `agent:error`
8. Supervisor → push `agent:status` (lifecycle) y `agent:metrics`
                (loop por container)
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
| `agent:spawn` | C → A ack | `docker pull` + `docker run` con `Tty:false` + `OpenStdin:true`, luego attach al stdio |
| `agent:stop` | C → A ack | `docker stop`/`kill` (también detacha el stream) |
| `agent:pause` | C → A ack | `docker pause` |
| `agent:resume` | C → A ack | `docker unpause` |
| `agent:input` | C → A ack | escribir línea `{"type":"user",...}\n` al stdin del container |
| `agent:status` | A → C push | tras spawn / stop / health check |
| `agent:metrics` | A → C push | loop por container |
| `agent:output` | A → C push | un evento stream-json del agente; seq monotónico por `agent_id` |
| `agent:auth_required` | A → C push | OAuth token rechazado; el control abre approval HITL |
| `agent:error` | A → C push | errores categorizados de `system/api_retry` (`rate_limit`, `billing_error`, …) |

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

## 6. Estructura del repo (actual)

```
kj-supervisor/
├── CLAUDE.md                              ← este fichero
├── README.md                              ← quickstart + scripts
├── package.json
├── bunfig.toml
├── biome.json
├── tsconfig.json
├── Dockerfile                             ← multi-stage Alpine
├── install-supervisor.sh                  ← one-liner installer para el VPS
├── scripts/
│   └── pull-protocol.ts                   ← descarga protocol.ts del control
└── src/
    ├── main.ts                            ← wires everything together
    ├── protocol.ts                        ← generado, NO editar a mano
    ├── logger.ts
    ├── config/
    │   └── settings.ts                    ← env + validación
    ├── client/
    │   ├── auth/auth.ts                   ← bootstrap (provisioning ↔ agent_token)
    │   └── control/control.client.ts      ← wrapper Socket.IO al control
    ├── docker/
    │   ├── client/client.ts               ← KJDocker: pull, run (con attach stdio), stop, pause, attach
    │   ├── events-watcher/events-watcher.ts ← stream de docker events; detacha streams en die/stop/kill/destroy
    │   └── operation-tracker/             ← marca operaciones supervisor-driven para que el watcher las ignore
    ├── agent-stream/                      ← ★ pipeline del stdio de cada agente
    │   ├── stream-manager.ts              ← Map<agent_id, attach-duplex>; attach/write/detach
    │   ├── stream-parser.ts               ← NDJSON tolerante (recupera de SIGKILL que trunca la última línea)
    │   └── stream-classifier.ts           ← mapea evento → agent:output [+ agent:auth_required | agent:error]
    ├── handlers/
    │   ├── agent-spawn/                   ← pull + run + attach al stream
    │   ├── agent-lifecycle/               ← stop / pause / resume
    │   ├── agent-input/                   ← ★ escribe input del operador al stdin
    │   └── supervisor-upgrade/            ← blue/green swap del propio supervisor
    └── reporters/
        ├── health/                        ← health:ping loop
        ├── server-metrics/                ← server:metrics loop
        ├── agent-status/                  ← push helpers de agent:status
        ├── agent-metrics/                 ← agent:metrics loop por container vivo
        └── status-heartbeat/              ← heartbeat de SPAWNING durante el pull
```

Lo nuevo respecto al plan original es `src/agent-stream/` y
`src/handlers/agent-input/` — el pipeline bidireccional con el stdio
del container. El resto sigue la misma forma.

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

### Hito 1 — Handshake mínimo ✅

Pipe `pull-protocol`, settings, auth (provisioning ↔ agent_token),
cliente Socket.IO al control, `server:hello`, persistencia del
`agent_token` a disco, `health:ping` loop. Cubierto por tests unitarios
del auth helper. Validado contra `kj-backend` en local.

### Hito 2 — Spawn de containers ✅

`agent:spawn` handler que pulls + runs vía dockerode. Push de
`agent:status { SPAWNING → RUNNING }` con `container_id`. Labels
`kj-agent` / `kj-agent-id` para discovery posterior. `agent:spawn` ack
inmediato (recibido ≠ completado); el outcome real va por push.

### Hito 3 — Stop / pause / resume + push de status ✅

Handlers de los tres eventos restantes + `agent-status.reporter` con
push helpers para emitir transiciones de estado. `operation-tracker`
diferencia operaciones supervisor-driven de eventos docker externos
(operador con shell que hace `docker stop` manualmente).

### Hito 4 — `server:metrics` y `agent:metrics` ✅

Reporter de host `/proc/loadavg` + `/proc/uptime`; reporter por agente
via `docker inspect`. Hoy reporta `uptime_seconds`; `tokens_used` y
`cost_micro` pendientes de extraer del `result` event del stream-json
(ver §9 Hito 7).

### Hito 5 — Reconciliación + supervisor upgrade ✅

- **Reconcile**: al `ready` del client, el supervisor lista
  `docker ps --label kj-agent`, mapea cada container a su `agent_id`
  por el label `kj-agent-id` y manda el array en
  `server:hello.containers`. El control resuelve orphans/ghosts.
- **Upgrade**: handler de `supervisor:upgrade-required` que hace
  `docker pull` del target image, levanta un container nuevo
  (compartiendo el volumen `/etc/kj-supervisor`) y lo deja tomar el
  relevo. El viejo se apaga cuando el nuevo emite su propio
  `server:hello`.

### Hito 6 — Pipeline de stream del agente ✅ (hecho 2026-05-18)

★ Pieza nueva, central para que el frontend pueda mostrar la
conversación viva. Tres añadidos:

- **`docker/client.ts`**: el `runContainer` ahora crea con
  `Tty:false` + `OpenStdin:true` + `AttachStdin/Out/Err:true`. Métodos
  nuevos `attachContainer(container_id)` y `demuxAttachStream(...)`.
- **`agent-stream/`** (módulo nuevo):
  - `stream-manager`: `Map<agent_id, attach-duplex>`. `attach(opts)`
    abre el duplex, demuxa stdout/stderr, conecta el parser. `write(payload)`
    serializa un user message como una línea NDJSON y la escribe a
    stdin. `detach(agent_id)` cierra el duplex.
  - `stream-parser`: NDJSON tolerante. Recupera de una última línea
    truncada por SIGKILL; salta empty/invalid lines sin morir.
  - `stream-classifier`: mapea cada evento a un `agent:output` y, si
    aplica, también a `agent:auth_required` (token rechazado) o
    `agent:error` (rate_limit / billing / server_error / …).
- **`handlers/agent-input/`**: handler nuevo que entrega cada
  `agent:input` al stdin del container correspondiente. Ack
  `AGENT_NOT_RUNNING` si no hay stream vivo.
- **`docker/events-watcher`** extendido: cualquier
  `die`/`stop`/`kill`/`destroy` también detacha el stream, evitando
  refs muertas.

`agent-spawn.handler.ts` ahora inyecta `KJ_SESSION_ID` y
`CLAUDE_CODE_OAUTH_TOKEN` al env del container y llama
`streams.attach()` inmediatamente después del `docker start`.

### Hito 7 — Pendientes post-stream

- **Extraer `usage` real**: el `result` event del stream-json trae
  `total_cost_usd` y `usage.{input,output,cache_*}_tokens`. Hoy
  `agent-metrics.reporter` los publica como `"0"`. Wiring listo, falta
  parsear desde el classifier y persistir en `Agent.tokens_used` /
  `Agent.cost_micro`.
- **Re-attach tras reinicio del supervisor**: hoy si el supervisor
  reinicia con containers vivos, el reconcile recupera los `agent_id`
  pero **no reattacha** automáticamente — necesita el `session_id` y el
  control no se lo está re-empujando. Solución limpia: nuevo
  `agent:sync` del control que envíe `{ agent_id, session_id,
  oauth_token }` para cada container que el supervisor ha listado en
  el `server:hello`.
- **Backpressure del stream**: si un agente verboso emite cientos de
  `stream_event` por segundo y nadie está suscrito a `/operator`, hoy
  el supervisor empuja igualmente y el control descarta. Optimización:
  el control le puede decir al supervisor "para de empujar de este
  `agent_id`" cuando la room esté vacía.

---

## 10. Cómo construir y probar localmente

```bash
# Setup
bun install
bun run pull-protocol:dev   # descarga protocol.ts de localhost:5050

# Dev sin Docker (handler tests rápidos)
bun --watch src/main.ts

# Tests
bun test                    # 69 unit pasan al cierre de Hito 6

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

### Probar el stream end-to-end

Con un agente `kj-agent-base` ya pulleado y un OAuth token configurado
en `KJ_DEFAULT_CLAUDE_OAUTH_TOKEN` en el `.env` del backend:

```bash
# 1. Spawn vía API HTTP del backend
curl -X POST -H "Authorization: Bearer <JWT>" \
  http://localhost:5050/org/<org_id>/agent/<agent_id>/start

# 2. Conecta un cliente Socket.IO al namespace /operator del backend
#    auth: { token: <mismo JWT> }
#    emit 'agent:subscribe' { agent_id }
#    listen 'agent:output' → verás los eventos stream-json de claude

# 3. Manda un mensaje al agente
#    emit 'agent:input' { agent_id, message: "Hola" }
#    el supervisor lo escribirá al stdin del container; la respuesta
#    viene como agent:output siguientes
```

---

## 11. Estado del control local — listo para arrancar Hito 1

El backend (`kj-backend`) en `localhost:5050` ya tiene un Server creado
esperando a este supervisor. Datos preparados el **2026-05-17**:

### Recursos creados en el control

| Recurso | ID | Detalle |
|---|---|---|
| **Backend URL** | — | `http://localhost:5050` |
| **Usuario** | `1` | `supervisor-dev@kujira.local` |
| **Organization** | `1` | `Kujira Dev`, plan `FREE` |
| **Server** | `1` | `dev-laptop`, status `OFFLINE` esperando supervisor |

Los secretos vivos (provisioning_token, password, JWT) están en el
fichero **`.env.local`** del repo (gitignored). Plantilla en
[.env.example](.env.example).

### Arrancar de cero

```bash
# 1. Levanta el backend (en otra terminal)
cd ~/Git/kj-backend
bun run docker:dev   # postgres + redis
bun run dev          # API en :5050

# 2. Verifica que responde
curl http://localhost:5050/ping
# → { "name": "Kujira API", ... }

# 3. Copia .env.example → .env.local y rellena los valores con los del repo
cp .env.example .env.local
# Editar .env.local con el provisioning_token actual

# 4. Cuando exista el código del Hito 1
bun install
bun run pull-protocol:dev
bun --watch src/main.ts
```

### Si el provisioning_token expira o se gasta

```bash
JWT="<JWT del usuario, en .env.local>"
curl -s -X POST http://localhost:5050/org/1/server/1/regenerate-provisioning-token \
  -H "Authorization: Bearer $JWT" | jq -r '.provisioning_token'
```

Devuelve un nuevo `kjprov_...` e **invalida** cualquier `agent_token`
persistente anterior. Si el supervisor ya tenía un token guardado en
disco (`local/etc-kj-supervisor/token`), bórralo antes de reintentar.

Si el JWT también expiró (7 días desde su emisión), refresca con:

```bash
curl -s -X POST http://localhost:5050/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"supervisor-dev@kujira.local","password":"<password>"}' \
  | jq -r '.token'
```

### Qué validar después del primer handshake

Tras `bun --watch src/main.ts` con el `.env.local` cargado, debes ver
(aproximadamente):

```
supervisor starting
auth resolved { mode: "provisioning" }
socket connected, waiting for control:ready
control:ready received
agent_token persisted to disk
handshake complete { protocol_version: 1 }
pong { server_time: ... }            ← cada 30s
```

Y en el control (BD):

```sql
-- server #1 ahora ONLINE con agent_token_hash poblado
SELECT id, status, provisioning_token IS NULL AS provisioning_consumed,
       agent_token_hash IS NOT NULL AS has_agent_token, last_seen_at
FROM server WHERE id = 1;
-- → ONLINE | t | t | <reciente>
```

Reinicios posteriores del supervisor: ya **no** necesita
`KJ_PROVISIONING_TOKEN`. Lee el agent_token del disco
(`local/etc-kj-supervisor/token`) y reconecta directo.

---

## 12. Referencias

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
