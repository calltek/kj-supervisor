/**
 * Machine codes that travel next to `agent:status.last_action` when the
 * text describes a failure (or the drain wait before an image update).
 *
 * `last_action` stays as the technical detail (docker's own words); the
 * code is what lets the panel show a sentence in the customer's language
 * without parsing that text. The control stores it and turns an unknown
 * code into null, and an absent code means "no code" — so adding one here
 * before the control knows it is harmless, but keep this list in sync with
 * the control's.
 */
export const LAST_ACTION_CODES = [
    'spawn_failed',
    'image_pull_failed',
    'volume_seed_failed',
    'docker_run_failed',
    'image_update_failed',
    'stop_after_pull_failed',
    'recreate_failed',
    'drain_wait',
    'stop_failed',
    'pause_failed',
    'resume_failed',
    'restore_failed',
] as const

export type LastActionCode = (typeof LAST_ACTION_CODES)[number]
