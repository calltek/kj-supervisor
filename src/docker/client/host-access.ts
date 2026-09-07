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
 * `agentHardening`: hay TRES caminos que crean contenedores de agente (arranque,
 * clon blue/green y recreación por imagen) y ya divergieron una vez, dejando
 * agentes recreados sin las capabilities que sus vecinos sí tenían.
 */
export const HOST_ALIAS = 'host.docker.internal'

/** El `ExtraHosts` que da a un contenedor el nombre de su propia máquina. */
export function agentHostAliases(): string[] {
    return [`${HOST_ALIAS}:host-gateway`]
}

/**
 * Los `ExtraHosts` de un contenedor recreado: los que tuviera, más el alias del
 * host si le faltaba.
 *
 * Se conserva lo que había en vez de imponer la lista porque un `ExtraHosts`
 * puesto a mano en el contenedor de origen es parte de cómo ese agente alcanza
 * lo suyo — el mismo criterio con el que la recreación hereda `CapAdd` y
 * `Devices` del origen y no de la intención del control. Y se añade el alias
 * porque un agente recreado tiene que poder llegar al host igual que uno recién
 * arrancado: ésa es exactamente la deriva que este módulo existe para evitar.
 */
export function withHostAlias(existing: string[] | null | undefined): string[] {
    const kept = existing ?? []
    return kept.some((entry) => entry.startsWith(`${HOST_ALIAS}:`))
        ? [...kept]
        : [...kept, ...agentHostAliases()]
}
