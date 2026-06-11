/**
 * Whether an image tag is MUTABLE — i.e. CI/registry can rewrite it in
 * place, so a locally-cached copy may be stale and we must pull fresh on
 * every spawn.
 *
 *   - mutable   → `:latest`, `:dev`, `:main`, `:edge`, `:nightly`,
 *                 `:stable`, `:canary` (rolling tags that get overwritten)
 *   - immutable → `:0.1.0`, `:1.2.3`, `:sha-abc123`, any pinned version
 *                 (never changes under the same name → cache is the truth)
 *   - local     → `:dev-local`, `:local`, or anything not in a registry
 *                 (treated as immutable: cache is the only source)
 *
 * Only the TAG part matters (after the last `:`, but not a registry port
 * like `host:5000/img`). A reference with no tag defaults to `latest` in
 * Docker, so we treat that as mutable too.
 */
const MUTABLE_TAGS = new Set(['latest', 'dev', 'main', 'edge', 'nightly', 'stable', 'canary'])

export function isMutableTag(imageRef: string): boolean {
    return MUTABLE_TAGS.has(extractTag(imageRef))
}

/**
 * Pull the tag out of an image reference. Handles a registry host with a
 * port (`ghcr.io/x/y:tag`, `localhost:5000/x:tag`) by only treating the
 * part after the LAST `/` as the name:tag, then splitting that on `:`.
 * No tag → `latest` (Docker's default).
 */
function extractTag(imageRef: string): string {
    const lastSlash = imageRef.lastIndexOf('/')
    const nameAndTag = lastSlash === -1 ? imageRef : imageRef.slice(lastSlash + 1)
    const colon = nameAndTag.indexOf(':')
    return colon === -1 ? 'latest' : nameAndTag.slice(colon + 1)
}
