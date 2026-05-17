/**
 * Tracks which container_ids currently have a supervisor-driven
 * operation in flight (stop, pause, resume, remove). The events
 * watcher consults this set to tell "we did this" (ignore — the
 * handler will push the final status itself) from "someone else
 * did this" (push status so the control learns about the drift).
 *
 * Operations are scoped per container; multiple handlers won't
 * race on the same container in practice (the control serializes
 * via Postgres state machine), but the set is fine even if they did.
 */

export class OperationTracker {
    private readonly inflight = new Set<string>()

    track(container_id: string): void {
        this.inflight.add(container_id)
    }

    untrack(container_id: string): void {
        this.inflight.delete(container_id)
    }

    isTracked(container_id: string): boolean {
        return this.inflight.has(container_id)
    }
}
