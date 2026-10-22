/**
 * Cómo un contenedor de agente nombra a la máquina donde corre.
 *
 * Hace falta para los modelos que viven EN esa máquina: un Ollama escuchando en
 * `11434` del host es, desde dentro del contenedor, un `localhost` que apunta al
 * propio contenedor. Sin un nombre para el host, el agente no tiene forma de
 * llegar a un modelo que está literalmente al lado.
 *
 * `host.docker.internal` es el nombre que Docker Desktop (macOS, Windows) ya
 * resuelve solo. En Linux **no existe** salvo que se pida, y se pide así: un
 * `ExtraHosts` con el destino especial `host-gateway`, que el demonio traduce a
 * la IP de la puerta de enlace del bridge. Sin esta línea, la misma
 * configuración que funciona en el portátil de alguien falla en su VPS, y falla
 * con un DNS que no resuelve — que se lee como «el modelo no contesta».
 *
 * **Esto no amplía lo que un contenedor puede alcanzar.** En bridge ya podía
 * hablar con el host por la IP de la pasarela (`172.17.0.1` y compañía): lo que
 * añade es un NOMBRE estable para esa misma dirección, que es lo que permite
 * que una conexión guardada diga `http://host.docker.internal:11434` en vez de
 * una IP que cambia con la red de Docker de cada máquina. Poner límites de
 * verdad a la salida del contenedor es otro trabajo, y sigue pendiente.
 *
 * Vive aquí y no repetido en cada `createContainer` por lo mismo que
 * `agentHardening`: hay DOS caminos que crean contenedores de agente (arranque y
 * recreación por imagen) y ya divergieron una vez, dejando agentes recreados sin
 * las capabilities que sus vecinos sí tenían. El clon blue/green NO es uno de
 * ellos: es el propio supervisor, y no lleva el alias (#34).
 */
export const HOST_ALIAS = 'host.docker.internal'

const HOST_ALIAS_ENTRY = `${HOST_ALIAS}:host-gateway`

/** El `ExtraHosts` que da a un contenedor el nombre de su propia máquina. */
export function agentHostAliases(): string[] {
    return [HOST_ALIAS_ENTRY]
}

/**
 * Los `ExtraHosts` de un contenedor de agente recreado: SÓLO el alias del host,
 * diga lo que diga el de origen. `dropped` son las entradas del origen que no
 * pasan, para que quien llama deje traza de ellas.
 *
 * No se hereda nada porque `ExtraHosts` reescribe el `/etc/hosts` del
 * contenedor: una línea `api.github.com:10.x.x.x` puesta a mano en el origen
 * sobreviviría a cada actualización de imagen y apuntaría a un agente con
 * credenciales a donde quisiera quien la puso (#34). Ningún agente legítimo
 * lleva otro `ExtraHosts` — sólo lo crea `runContainer`, y sólo con el alias —,
 * así que lo que aparezca aquí no viene de Kujira. Es el mismo criterio que
 * `withoutDockerSocket`: lo que se copia del origen no puede ser la puerta por
 * la que un contenedor tocado a mano contagia a todos los que vengan después.
 *
 * Tampoco se respeta un `host.docker.internal` fijado a otra IP: es el nombre
 * por el que el agente llega a su modelo, y desviarlo es el mismo ataque.
 */
export function recreatedHostAliases(existing: string[] | null | undefined): {
    hosts: string[]
    dropped: string[]
} {
    const dropped = (existing ?? []).filter((entry) => !isHostAliasEntry(entry))
    return { hosts: agentHostAliases(), dropped }
}

/** Docker no distingue mayúsculas en los nombres de host: aquí tampoco. */
function isHostAliasEntry(entry: string): boolean {
    return entry.trim().toLowerCase() === HOST_ALIAS_ENTRY
}

/**
 * Si un error de `createContainer` es el demonio rechazando `host-gateway`.
 *
 * Pasa en Docker Engine < 20.10 (`invalid IP address in add-host:
 * "host-gateway"`) y en uno moderno que no sabe qué IP darle (`unable to derive
 * the IP value for host-gateway`). Se mira el mensaje y nada más: cualquier otro
 * fallo de create tiene que seguir subiendo tal cual.
 */
export function isHostGatewayUnsupported(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return /add-host|host-gateway/i.test(message)
}
