/**
 * The Docker network the agents reach kj-keychain by.
 *
 * Before, an agent called kj-keychain at `host.docker.internal:9890`: the port
 * published on the bridge gateway, i.e. a connection from a container to the
 * HOST. A machine whose firewall drops what enters the host (a Plesk with
 * `INPUT DROP`) drops that too, and every credential reference fails — `/r`,
 * SSH, `/sql`, `/mail`. Container to container is forwarded traffic, not
 * input, and gets through.
 *
 * So kj-keychain and every agent are also on a network of ours, and the agents
 * call it by its container name on it. The network is:
 *  - **internal**: no gateway, so it adds no default route — an agent's way
 *    out is still the default bridge, exactly as before — and nothing on it
 *    reaches outside;
 *  - **a user-defined bridge**, which is what gives the agents Docker's
 *    embedded DNS (`127.0.0.11`) and with it the name `kj-keychain`;
 *  - **labelled**: one with this name and without the label is somebody
 *    else's, and is not used.
 *
 * Agents made before keep the old address in their env, and the port stays
 * published on the gateway for them, until they are recreated (spawn or image
 * update), which moves them here.
 */

import { KEYCHAIN_AGENT_PORT, KEYCHAIN_CONTAINER } from '../keychain/control-protocol'

export const KEYCHAIN_NETWORK = 'kj-keychain-net'
/** Label our network carries: without it, a network of that name is not ours. */
export const KEYCHAIN_NETWORK_LABEL = 'kj-keychain-net'

/** The env var the launcher reads (kj-agent-base `model-credentials.ts`). */
export const KEYCHAIN_ENDPOINT_ENV = 'KJ_KEYCHAIN_ENDPOINT'
/** Through our network: container to container. */
export const KEYCHAIN_NETWORK_ENDPOINT = `http://${KEYCHAIN_CONTAINER}:${KEYCHAIN_AGENT_PORT}`
/** Through the host: what agents got before, and still get without the network. */
export const KEYCHAIN_HOST_ENDPOINT = `http://host.docker.internal:${KEYCHAIN_AGENT_PORT}`

/**
 * An agent's env with its kj-keychain address set to `endpoint`. Only an env
 * that already HAS the variable changes: an agent without a token has no
 * business with kj-keychain, and gets nothing added.
 */
export function withKeychainEndpoint(env: string[], endpoint: string): string[] {
    const prefix = `${KEYCHAIN_ENDPOINT_ENV}=`
    return env.map((e) => (e.startsWith(prefix) ? `${prefix}${endpoint}` : e))
}
