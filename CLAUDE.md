# Kujira — Supervisor (`kj-supervisor`)

> **⚙️ Flujo de desarrollo (2026-06-30, endurecido 2026-08-24 y 2026-09-05) —
> léelo antes de tocar nada.**
> Ramas + **Pull Request**, nunca commit directo a `main` (varios agentes/personas
> en paralelo; `main` auto-despliega vía Dokploy al mergear). Trabajo en paralelo →
> un **`git worktree` por tarea, SIEMPRE** (compartir el working dir = un solo HEAD
> → os pisáis al cambiar de rama). **El directorio principal no es un puesto de
> trabajo**: se deja limpio sobre una base al día que nadie esté tocando — en
> `main`, o desprendido sobre `origin/main` si un worktree ya tiene `main`. Crea
> la rama desde `origin/main` explícitamente —
> `git worktree add -b <rama> ../wt/kj-supervisor-<tarea> origin/main` — y antes de
> abrir el PR comprueba con `git log --oneline origin/main..HEAD` que sólo llevas
> tus commits: ramificar desde donde otro ha parcado su tarea te mete su trabajo
> dentro del PR y no avisa. Y **no se desarrolla Kujira dentro de Kujira-prod**:
> el core/deploy se hace con agentes de fuera (Claude Code + worktrees + CI);
> dogfooding solo en tareas auxiliares aisladas. La línea que cierra el issue
> va **en inglés y en su propia línea** — `Closes #233` —, aunque el resto del PR
> sea español: GitHub sólo reconoce close/fix/resolve, así que «Cierra #233» es
> prosa y no cierra nada (le pasó a 38 de los 38 PRs de kj-backend que decían
> cerrar un issue). El workflow `link-issues` la traduce si se te olvida, pero
> sólo si abre la línea.
>
> **Y TU PR se vigila hasta mergearlo — cada ~3 minutos.** Tuyo quiere decir
> **abierto por ti en esta sesión**: los demás no se tocan, ni para mergearlos
> aunque estén verdes y aprobados, ni para arreglarles un check rojo. Que un PR
> ajeno esté listo no lo hace tuyo — quien lo abrió sabe si está esperando algo,
> y mergear por encima le quita esa decisión. Sin PRs propios abiertos no hay
> nada que vigilar: no se monta una ronda para mirar los de otros. El check aquí es
> `build` (build + `bun test`). Revisan **@n0v4-SYS** (Nova) todo y **@SOKY-SYS**
> (SOKI) además `/.github/`, `Dockerfile*`, `docker*.yml`, `.env.example`,
> `package.json`, `/src/client/auth/`, `/src/oauth/`,
> `/src/handlers/oauth-exchange/` y `/src/docker/`. Verde y aprobado →
> `gh pr merge <n> --squash --delete-branch`; rojo → `gh run view <id>
> --log-failed` antes de tocar nada; comentarios → aplicarlos o contestar. Los
> comentarios de revisión son **en línea** y no salen en `gh pr view`:
> `gh api repos/calltek/kj-supervisor/pulls/<n>/comments`. Un PR desatendido no
> falla, se queda quieto — y aquí eso significa que la flota sigue con el
> supervisor viejo. Norma completa en `kj-backend/CLAUDE.md` §6 (decisión
> 2026-09-05).

Container Docker que vive en cada VPS de un cliente de Kujira. Mantiene
una conexión WebSocket persistente con el control (`kj-backend`) y
orquesta el ciclo de vida de los agentes Claude locales: levanta,
detiene, pausa, reanuda y reporta el estado real.

> **Estado actual (2026-09-05)**: en producción en los VPS de clientes. Sobre lo
> que este apartado describía en mayo (hitos 1–6: conexión, auth, protocolo,
> ciclo de vida de containers, métricas, reconciliación y el pipeline
> bidireccional de stdio con `dockerode.attach`), se ha añadido:
>
> - **Copias del volumen del agente** (`handlers/agent-backup/`): snapshot a R2
>   y restauración sobre el volumen vivo. Es el trabajo más reciente del repo y
>   el más delicado — la noche del 2026-08-27 se perdieron copias por **tres
>   caminos a la vez**, arreglados en el mismo PR. Léelo antes de tocar aquí.
> - **`agent:exec`** (`handlers/agent-exec/`): ejecuta un comando dentro del
>   container, que es lo que permite que un cron corra un script en vez de
>   inyectar un turno de conversación.
> - **Canje de OAuth** (`src/oauth/` + `handlers/oauth-exchange/`): el flujo PKCE
>   de Claude se completa en la máquina del cliente, para que el token no viaje
>   de más.
> - **Dedup de comandos por `request_id`** y el contrato `EVENT_DELIVERY`: la
>   mitad de supervisor de la entrega garantizada. La otra mitad, el
>   `CommandOutbox`, ya existe en el control.
>
> El **provisioning por WebSocket está muerto**: el alta va por bundle HTTP y el
> `agent_token` lo escribe `install.sh` en `<config_dir>/token` (§2.1).

---

## 1. Visión

El supervisor es la **única pieza** que el cliente instala en su propio
VPS. Habla con el control en `api.kujira.so` por una conexión Socket.IO
persistente y traduce comandos del control en operaciones Docker sobre
el host:

```
┌──────────────────────────────┐         ┌────────────────────────────────┐
│ kj-backend (control)         │         │ VPS del cliente                │
│ - api.kujira.so              │◀──TLS──▶│ ┌────────────────────────────┐ │
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
curl -fsSL https://api.kujira.so/install.sh | \
    sudo PROVISIONING_TOKEN=kjprov_... bash
```

`install.sh` instala Docker si falta, **canjea el `provisioning_token` por el
bundle** contra `POST /provisioning/bundle`, escribe el `agent_token` resultante
en `<config_dir>/token` con modo `0600`, lanza el container del supervisor y
desaparece.

> **El canje es HTTP, no WebSocket.** El supervisor arranca ya con su
> `agent_token` en disco y nunca ve un `kjprov_`. La rama `provisioning` del
> handshake WS existió y **se retiró** (2026-05-24): si un texto de este fichero
> o una variable `KJ_PROVISIONING_TOKEN` sugiere otra cosa, es residuo.

### 2.2 El container del supervisor

```bash
docker run -d \
  --name kj-supervisor \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/kj-supervisor:/etc/kj-supervisor \
  -e KJ_CONTROL_URL=https://api.kujira.so \
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
| Docker | **`dockerode`** | Decidido al implementar el Hito 2 y sin vuelta atrás: todo `src/docker/` va por la librería, incluido el attach al stdio y el watcher de eventos. |
| Lint + format | **Biome 2** | Mismo que el control. |
| Tests | **`bun test`** | 22 ficheros hoy. La integración real contra Docker sigue sin automatizarse. |
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
GET https://api.kujira.so/protocol   →  text/typescript
```

Mismo patrón que vcs-astro usa para `swagger.json`. El script vive en
`scripts/pull-protocol.ts` y corre en `prebuild`:

```typescript
// scripts/pull-protocol.ts
import { writeFileSync } from 'fs'

const env = process.argv[2] || 'production'
const url =
    env === 'development'
        ? 'http://localhost:5050/protocol'
        : 'https://api.kujira.so/protocol'

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
diff <(cat src/protocol.ts) <(curl -s https://api.kujira.so/protocol)
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
├── install-supervisor.sh                  ← copia vieja; el instalador que
│                                            se distribuye lo sirve el control
│                                            en `<control>/install.sh`
├── scripts/
│   └── pull-protocol.ts                   ← descarga protocol.ts del control
└── src/
    ├── main.ts                            ← wires everything together
    ├── protocol.ts                        ← generado, NO editar a mano
    ├── logger.ts
    ├── config/
    │   └── settings.ts                    ← env + validación
    ├── client/
    │   ├── auth/auth.ts                   ← lee el agent_token del disco
    │   ├── control/control.client.ts      ← wrapper Socket.IO al control
    │   └── control/command-dedup.ts       ← dedup por request_id (LRU 2k + TTL 5 min)
    ├── oauth/                              ← ★ canje PKCE de Claude, del lado del cliente
    ├── docker/
    │   ├── client/client.ts               ← KJDocker: pull, run (con attach stdio), stop, pause, attach
    │   ├── events-watcher/events-watcher.ts ← stream de docker events; detacha streams en die/stop/kill/destroy
    │   ├── image-tag.ts                   ← isMutableTag: qué tags se re-pullean en cada spawn
    │   └── operation-tracker/             ← marca operaciones supervisor-driven para que el watcher las ignore
    ├── agent-stream/                      ← ★ pipeline del stdio de cada agente
    │   ├── stream-manager.ts              ← Map<agent_id, attach-duplex>; attach/write/detach
    │   ├── stream-parser.ts               ← NDJSON tolerante (recupera de SIGKILL que trunca la última línea)
    │   └── stream-classifier.ts           ← mapea evento → agent:output [+ agent:auth_required | agent:error]
    ├── handlers/
    │   ├── agent-spawn/                   ← pull + run + attach al stream
    │   ├── agent-lifecycle/               ← stop / pause / resume
    │   ├── agent-input/                   ← escribe input del operador al stdin
    │   ├── agent-sync/                    ← re-attach masivo tras reconectar
    │   ├── agent-image-update/            ← re-pull + recreate preservando el volumen
    │   ├── agent-backup/                  ← ★ snapshot del volumen a R2 y restauración
    │   ├── agent-exec/                    ← ★ ejecutar un comando dentro del container
    │   ├── oauth-exchange/                ← ★ canje PKCE en la máquina del cliente
    │   └── supervisor-upgrade/            ← blue/green swap del propio supervisor
    └── reporters/
        ├── health/                        ← health:ping loop
        ├── server-metrics/                ← server:metrics loop
        ├── agent-status/                  ← push helpers de agent:status
        ├── agent-metrics/                 ← agent:metrics loop por container vivo
        └── status-heartbeat/              ← heartbeat de SPAWNING durante el pull
```

Las piezas marcadas ★ son lo posterior al plan original: el canje de OAuth, las
copias del volumen y la ejecución de comandos. El pipeline bidireccional de
stdio (`src/agent-stream/` + `handlers/agent-input/`) tampoco estaba en el plan
y hoy es el eje del repo. El resto sigue la misma forma.

---

## 7. Variables de entorno

> **¿Necesitas una credencial?** Está en `<workspace>/.env.shared` —
> `C:\Users\5013r\Documents\Git\Kujira\.env.shared`, al lado de los repos y
> fuera de todos ellos a propósito. Ahí van los IDs y tokens de servicio
> (`kjtk_*`) de las organizaciones reales; el usuario los mantiene. No los
> pidas por el chat, no los inventes y **no los copies dentro de un repo** — ni
> a un `.env.local` gitignoreado: gitleaks escanea el historial en cada PR.
> Detalle y reglas en `kj-backend/CLAUDE.md` §5.

Son **cuatro**. La lista viva es `src/config/settings.ts`.

| Variable | Requerida | Descripción |
|---|---|---|
| `KJ_CONTROL_URL` | sí | URL del control (`https://api.kujira.so`). Sin barra final. |
| `KJ_CONFIG_DIR` | no | Default `/etc/kj-supervisor`. Aquí vive el `token` que escribió `install.sh`. Override para dev. |
| `KJ_LOG_LEVEL` | no | Default `info`. `debug`, `warn`, `error` válidos; cualquier otra cosa aborta el arranque. |
| `KJ_SUPERVISOR_CONTAINER` | no | Nombre del propio container, para el blue/green del auto-upgrade. |

> **Ya NO existen** `KJ_PROVISIONING_TOKEN`, `KJ_AGENT_TOKEN`,
> `KJ_PING_INTERVAL_MS` ni `KJ_METRICS_INTERVAL_MS`. Las dos primeras murieron
> al colapsar el auth en un solo camino (el token se lee del disco, §2.1); los
> intervalos son constantes del código. Siguieron documentadas aquí meses
> después de desaparecer — si una receta te las pasa por `-e`, se ignoran en
> silencio.

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

**Estado (2026-06-03)**: `agent-spawn.handler` siembra **ambos**:
`memories[]` → `.claude/memories/` y `skills[]` → `.claude/skills/`
(cada skill ya llega como `<name>/SKILL.md` con su frontmatter
sintetizado por el control; el supervisor solo lo deposita). Purga
previa en los dos directorios para limpiar tras unassign/rename/
archive. Nota: `syncBuiltinSkills` del wrapper re-escribe sus
built-in (kj-mcp) al boot, **después** del purge — no colisionan
mientras los nombres de skill de operador no choquen con un built-in.

### Hot-reload de skills sin restart (`agent:skills_changed`, 2026-06-09)
Cuando el **operador** (re)asigna/edita/archiva una skill de un agente
**RUNNING**, el control empuja el push `agent:skills_changed`
(`{ agent_id, skills[] }`, el set vivo completo). El handler en `main.ts`
(`onPush`):
1. Re-siembra `.claude/skills/` en el volumen con `seedVolumeFiles`
   (`purge:true` + rewrite — **idéntico** al seed de spawn; el payload
   se construye con el mismo `buildSkillsPayload` del backend, así que
   los SKILL.md son byte-a-byte iguales a los del spawn).
2. Manda al stdin del container un envelope **de control**
   `{type:'skills_changed'}` vía el nuevo
   `AgentStreamManager.writeControl` (NO es un envelope MCP ni
   stream-json input; el wrapper lo reconoce por su `type`).
El wrapper recicla su pool de procesos Claude para que relean el
catálogo de skills (lo lee una vez al boot). **Sin restart de
container, sin perder la conversación** (`--resume`); las sesiones
ocupadas terminan su turno antes de reciclarse (lado wrapper). Es
**best-effort**: si el agente no tiene stream vivo localmente, el push
se descarta y el próximo `agent:spawn` siembra el set fresco igual.
Detalle de la cadena en kj-backend §6 decisión 2026-06-09 y agent-base
Hito 9.

> **No obvio**: `agent:image:update` **NO** re-siembra skills/memorias
> (solo recrea el container preservando el volumen). El reseed a disco
> ocurre en `agent:spawn` o vía `agent:skills_changed`.

### Pull de imagen: tags mutables siempre se re-pullean (2026-06-11)
El `agent:spawn` saltaba el pull si la imagen ya existía localmente **por
nombre de tag**, sin mirar el registry. Bug en prod: un rebuild de
`base:latest` en CI no llegaba al VPS — un agente nuevo reusaba la copia
cacheada vieja y arrancaba la imagen antigua (sin `--skip-permissions` →
Claude colgado, **ni respuesta ni error**).

Fix en `image-tag.ts` (`isMutableTag`): el cache solo se respeta para tags
**inmutables**.
- **Mutables** (`:latest`, `:dev`, `:main`, `:edge`, `:nightly`, `:stable`,
  `:canary`, y sin-tag → `latest`) → **pull en cada spawn** (barato si ya
  está al día: solo chequea el manifest, no re-baja capas).
- **Inmutables** (`:0.1.0`, `:sha-…`) y **locales** (`:dev-local`, `:local`,
  nunca en un registry) → cache-first como antes.
- Un tag mutable sin match en el registry (un `:latest` construido en local)
  → si el pull falla, **fallback a la cache** → los flujos dev siguen.
- Maneja bien el puerto del registry (`localhost:5000/img:tag` → el tag es
  `tag`, no `5000`).
El handler `agent:image:update` YA pulleaba-primero (por eso `update-image`
arregló Cypher a mano); esto alinea el spawn. 5 unit tests.

> **Operativa**: para refrescar un `:latest` en un agente ya corriendo sin
> esperar a un respawn, `update-image` lo fuerza. Para los agentes nuevos,
> el spawn ya re-pullea los mutables solo.

### Idempotencia de comandos — dedup por `request_id` (2026-06-10)
Todo comando C→A lleva un `request_id` obligatorio. El supervisor
**deduplica** sobre él en `src/client/control/command-dedup.ts`: un wrapper
en `onCommand` (control.client.ts) recuerda el **ack** de la 1ª ejecución
por `request_id` (LRU 2k entradas + TTL 5 min, in-memory) y, ante un
`request_id` repetido, **re-ackea SIN re-ejecutar el handler**. Así un
reintento de un comando `at-least-once` (cuando el control reenvíe porque
perdió el ack pero el comando ya corrió) **no doble-spawnea / doble-
entrega**. In-memory a propósito: la ventana solo cubre el horizonte de
reintento; tras un reinicio del supervisor el mapa nace vacío, pero el
`agent:sync` del reconnect reconcilia el estado → sin drift. 7 unit tests
en `command-dedup.test.ts`.

El **contrato de entrega** (qué comandos son best-effort vs deben llegar)
vive en `EVENT_DELIVERY` del `protocol.ts` (lado backend, fuente de
verdad). El **motor outbox** que explota este dedup (persistir+reintentar
los `at-least-once`) es **tarea futura del control** — el supervisor ya
está listo. Ver kj-backend §6 decisión 2026-06-10.

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

### El mapa `session→conversation` se pre-siembra desde el control (2026-06-04)
`AgentStreamManager` mapea el `session_id` de cada conversación a su
`conversation_id` (BD) para estampar `agent:output` con la conversación
correcta. Ese mapa se poblaba **solo** al recibir un `agent:input`, así
que tras un respawn del agente o un restart del supervisor nacía vacío
→ el `agent:output` salía sin `conversation_id` → el control caía a un
routing por "la conversación más reciente" (y antes, peor: fan-out que
duplicaba con >1 operador interno).

Fix: `agent:spawn` y `agent:sync` ahora llevan `conversations[]`
(`AgentConversationRoute[]` = session_id→conversation_id de las OPEN del
agente). `attach()` siembra `conversation_id_by_session` con ellas, así
el output va etiquetado desde el primer turno del run, sin esperar un
input. (El handler de `agent:image:update` recrea el stream pero su
payload no trae `conversations[]` — ese primer output cae al fallback
del control; mejora menor pendiente.) Ver kj-backend §6 decisión
2026-06-04 (canales) para la otra capa del fix.

### Canales externos: el supervisor NO los toca (2026-06-04)
El conector de cada transporte (Telegram/…) vive **en el backend**
(`providers/channel-transport/`), no en el supervisor ni en un MCP
vecino al agente. El agente envía/recibe por canales vía la tool MCP
`channel_send` (sale por `mcp:request` como cualquier otra) y el
webhook entrante llega directo al backend. El supervisor solo
reenvía `mcp:request` y entrega el `agent:input` resultante — agnóstico
al transporte. (Si la escala lo pide algún día, el conector podría
moverse a un `kj-channel-core` MCP en el VPS; hoy centralizado.)

---

## 9. Hoja de ruta

> El alcance de cada hito está pensado para ser commiteable, probable y
> útil por sí solo. Mismo patrón que el kj-backend.
>
> Empezó siendo "6 hitos". Repasada el 2026-09-05: todo lo marcado ✅ está en
> producción, y lo único abierto es el último apartado. **No hay Hito 8**: ese
> número se usó para el cajón de pendientes y quedó escrito detrás del 9, así
> que al ordenarlo se ha renumerado. La numeración no significa nada; el orden
> sí.

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

### Hito 7 — Stream completo + métricas reales + agent:sync ✅ (hecho 2026-05-24)

- **Métricas event-driven**: `stream-classifier` extrae `usage` +
  `total_cost_usd` del evento `result` y emite `agent:metrics` con
  `tokens_delta` / `cost_delta_micro` (BigInt strings). El loop
  periódico de `agent-metrics.reporter` sigue ticando pero solo para
  refrescar `uptime_seconds` (deltas 0). El backend acumula con
  `increment`, así el supervisor queda stateless: un restart no
  pierde cuentas.
- **`agent:sync`**: nuevo handler en `src/handlers/agent-sync/`. El
  control lo emite justo después del `server:hello` / reconcile con
  `{agent_id, container_id, session_id, oauth_token}` por cada
  container vivo. `streams.attach(...)` se ejecuta en paralelo
  (`Promise.allSettled`); failures individuales se warnean pero no
  rompen el batch.
- **Server self-reporting**: `server:hello` carga `cpu_cores`,
  `ram_mb`, `os` extraídos por el supervisor; `server:metrics` añade
  `cpu_percent` (delta entre snapshots) y `ram_percent`. El backend
  los persiste en `Server` para que la lista del operador los muestre.

### Hito 9 — agent:image:update + push contact_profile ✅ (hecho 2026-06-02/03)

- **Nuevo evento `agent:image:update`** (control → supervisor).
  Maneja dos escenarios bajo el mismo handler:
  - Re-pull del mismo tag (operador pulsó "Forzar actualización"
    porque GHCR re-buildeó la imagen).
  - Bump a una versión nueva del catálogo (`Agent.image_id`
    cambió primero en BD; el push lleva el nuevo `image_tag`).
- **`AgentImageUpdateHandler`** en
  `src/handlers/agent-image-update/`:
  1. Ack inmediato `{ok: true, accepted: true}`.
  2. Background: heartbeat "pulling…" + `docker pull` (con
     `registry_credentials` opcionales que el control puede
     mandar — patrón idéntico a `agent:spawn`).
  3. Si el pull falla **y** `imageExistsLocally(tag) === true`,
     continúa con el cache. Cubre dev (tags built localmente)
     y producción con creds aún por configurar.
  4. Según `restart_after` + estado previo:
     - `restart_after=true` + container vivo → swap via
       `recreateContainerWithImage` (preserva
       Env/Mounts/Labels/RestartPolicy/NetworkMode/GroupAdd
       **y** el stdio config: `OpenStdin/AttachStdin/AttachStdout
       /AttachStderr/Tty=false`) → reattach stdio leyendo
       `KJ_SESSION_ID` del Env del nuevo container.
     - `restart_after=false` + container vivo → stop+remove,
       status STOPPED, el operador arranca a mano.
     - Sin container previo → solo refresh la cache, status STOPPED.
  - 10 tests unitarios en
    `agent-image-update.handler.test.ts` cubren los 4 caminos +
    pull failure (con y sin cache) + recreate failure +
    propagation de `registry_credentials` a `pullImage`.
- **Bug nasty descubierto en producción**: la primera versión de
  `recreateContainerWithImage` copiaba Env/Mounts/Labels pero
  **olvidaba el stdio config**. Resultado: container nuevo con
  stdin cerrado, wrapper hace `createInterface({input: process
  .stdin})` y nunca recibe nada. Status RUNNING, heartbeats fine,
  pero ninguna respuesta del agente. Fix: replicar el stdio
  config de `runContainer` también en el recreate
  (`Tty:false, OpenStdin:true, StdinOnce:false, AttachStdin:true,
  AttachStdout:true, AttachStderr:true`).

- **Pushes `contact_profile:updated` y `memory:updated` — obsoletos
  (2026-06-03).** Ambos eran log-only end-to-end (el supervisor los
  reenviaba al container vía `mcp.forwardPushToContainer` y el MCP
  bridge solo los logueaba). El backend ya **no los emite**: el aviso
  de "tu nota / memoria cambió, reléela" se materializa como un
  mensaje SYSTEM persistido en BD que el backend antepone como
  `<system-reminder>` al próximo `agent:input` real (ver
  `kj-backend/CLAUDE.md` y `kj-agent-base` Hito 7 — por qué
  `resources` capability y la inyección de turno por stdin se
  descartaron). Estado en el supervisor:
  - `contact_profile:updated`: handler `onPush` **eliminado** +
    `ContactProfileUpdatedPush` fuera del `protocol.ts` (del
    backend; la copia generada aquí se purga al próximo
    `pull-protocol`).
  - `memory:updated`: el handler `onPush('memory:updated')` sigue en
    `main.ts` pero queda **inerte** (el backend no emite). Limpieza
    pendiente menor: borrarlo + `MemoryUpdatedPush` en la siguiente
    pasada del protocolo.
  La invalidación real del volumen del container nunca dependió de
  estos pushes — va por `Agent.sync_pending` + el ciclo de sync.

### Hito 10 — Copias, ejecución y OAuth ✅ (2026-06 → 2026-08)

Lo que se hizo después de que esta hoja de ruta dejara de mantenerse. Va aquí
para que el orden de los hitos vuelva a ser el orden en que pasaron.

- **`agent:backup` / `agent:restore`** (`handlers/agent-backup/`): empaqueta el
  volumen `/home/agent` y lo sube al destino R2 de la organización; restaurar
  vuelca sobre el volumen vivo. **Es la parte más delicada del repo**: la noche
  del 2026-08-27 se perdieron copias por tres caminos distintos a la vez, y los
  tres se arreglaron en el mismo PR. Antes de tocar aquí, léelo.
- **`agent:exec`** (`handlers/agent-exec/`): ejecuta un comando dentro del
  container y devuelve su salida. Es lo que permite que un cron del control
  corra un script en vez de inyectar un turno de conversación.
- **Canje de OAuth** (`src/oauth/` + `handlers/oauth-exchange/`): el flujo PKCE
  de Claude se completa en la máquina del cliente, así el token no se pasea ni
  se queda en el control mientras se negocia.
- **Dedup por `request_id`** (`client/control/command-dedup.ts`) y el contrato
  `EVENT_DELIVERY`: la mitad de supervisor de la entrega garantizada. La otra
  mitad, el `CommandOutbox`, ya existe en el control.

### Hito 11 — Pendientes futuros

- ~~**Limpiar el flujo WS-provisioning muerto**~~ ✅. `auth.ts`/`settings.ts`/
  `main.ts` quedaron colapsados en un solo camino y las variables zombi
  desaparecieron (§7). Este punto llevaba desde mayo dado por pendiente en un
  fichero que ya no describía el código.
- **Backpressure del stream**: si un agente verboso emite cientos de
  `stream_event` por segundo y nadie está suscrito a `/operator`, hoy
  el supervisor empuja igualmente y el control descarta. Optimización:
  el control le puede decir al supervisor "para de empujar de este
  `agent_id`" cuando la room esté vacía.
- **`agent:image:update` no lleva `conversations[]`**, así que el primer
  `agent:output` tras un swap de imagen cae al enrutado de reserva del control
  (§8, decisión 2026-06-04). Mejora menor, conocida.

---

## 10. Cómo construir y probar localmente

```bash
# Setup
bun install
bun run pull-protocol:dev   # descarga protocol.ts de localhost:5050

# Dev sin Docker (handler tests rápidos)
bun --watch src/main.ts

# Tests
bun test                    # 22 ficheros de test

# Build de imagen Docker
docker build -t kj-supervisor:dev .
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ./local/etc-kj-supervisor:/etc/kj-supervisor \
  -e KJ_CONTROL_URL=http://host.docker.internal:5050 \
  -e KJ_SUPERVISOR_CONTAINER=kj-supervisor \
  kj-supervisor:dev
```

### Probar el stream end-to-end

Con un agente `kj-agent-base` ya pulleado y un OAuth token configurado
en el agente vía `PATCH /org/:org_id/agent/:id` (campo `claude_oauth_token`):

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

## 11. Levantar un entorno de desarrollo

> Esta sección fue durante meses "Estado del control local — listo para arrancar
> Hito 1": los IDs de un Server y una organización concretos de mayo de 2026, un
> `provisioning_token` que caducó, y pasos escritos en futuro ("cuando exista el
> código del Hito 1"). Nada de eso servía ya. Lo que sigue es el procedimiento,
> sin datos que caduquen.

Necesitas el control corriendo, una organización con un servidor, y el
`agent_token` de ese servidor en el disco.

```bash
# 1. El control, en otra terminal
cd ../kj-backend
bun run docker:dev   # postgres + redis
bun run dev          # API en :5050
curl http://localhost:5050/ping

# 2. Este repo
bun install
bun run pull-protocol:dev
cp .env.example .env.local     # KJ_CONTROL_URL + KJ_CONFIG_DIR=./local/etc-kj-supervisor
```

**El `agent_token`.** No se pasa por env: se lee de `<KJ_CONFIG_DIR>/token`. En
producción lo escribe `install.sh` tras canjear el `provisioning_token` por el
bundle (§2.1). En local, o corres ese mismo `install.sh` apuntando al control de
desarrollo, o pides el bundle a mano:

```bash
# Genera un provisioning_token desde el panel (o por API) para tu servidor, y:
curl -s -X POST http://localhost:5050/provisioning/bundle \
  -H 'Content-Type: application/json' \
  -d '{"provisioning_token":"kjprov_..."}'
# Guarda el agent_token que devuelve:
mkdir -p ./local/etc-kj-supervisor
printf '%s' '<agent_token>' > ./local/etc-kj-supervisor/token
chmod 600 ./local/etc-kj-supervisor/token
```

```bash
# 3. Arranca
bun --watch src/main.ts
```

Un handshake correcto se ve así (aproximadamente):

```
supervisor starting
socket connected, waiting for control:ready
control:ready received
handshake complete { protocol_version: N }
pong { server_time: ... }            ← cada 30s
```

Y en la BD del control, el servidor pasa a `ONLINE` con `last_seen_at` reciente:

```sql
SELECT id, status, agent_token_hash IS NOT NULL AS has_agent_token, last_seen_at
FROM server WHERE id = <tu server>;
```

**Si el token deja de valer**, regenerar el provisioning del servidor invalida
cualquier `agent_token` anterior — borra `./local/etc-kj-supervisor/token` antes
de reintentar, o el supervisor seguirá presentando el viejo.

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
