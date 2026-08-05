/**
 * What "set up" means, in one place.
 *
 * `init` and `doctor` used to each carry their own idea of this — a fixed
 * five-step script in one, a flat list of checks in the other — which is two
 * copies of the same knowledge that can disagree, and did: doctor called
 * missing hooks fine while init offered to install them, and only doctor knew
 * what a revoked credential looked like.
 *
 * So the model lives here and both commands render it. `doctor` shows every
 * state at once, because a report is what it is for. `init` walks the same
 * list in order and stops at the first thing standing in the way, because
 * someone handed five tasks does none of them. An agent gets the same states
 * through a third renderer that never prompts.
 *
 * The ordering is a dependency chain, not a preference: there is no point
 * asking the server about devices before there is a credential to ask with,
 * and no point reporting a stale contract to someone who cannot reach the
 * server at all. Assessment stops descending when a prerequisite is missing
 * and marks what follows `unknown` rather than guessing.
 */

/** Whether the gap can be closed from here, and by whom. */
export type Remedy =
  /**
   * The CLI can do it unattended — no prompt, no human. `command` is how a
   * reader would ask for it later, for the case where it was declined or
   * skipped; it is never needed to perform the action.
   */
  | { by: 'cli'; summary: string; command?: string }
  /**
   * A human at this terminal. `interactive` marks the ones the CLI can drive
   * on their behalf when someone is actually watching — a browser sign-in is
   * the CLI's to launch but the human's to complete, so an agent must still
   * treat it as out of reach.
   */
  | { by: 'user-here'; summary: string; command: string; interactive?: boolean }
  /**
   * A human somewhere else entirely — phone in hand, app store, permission
   * dialog. The class the old init could only print a sentence about, and the
   * one most likely to end an onboarding.
   */
  | { by: 'user-elsewhere'; summary: string }

export type StateStatus =
  /** Satisfied. */
  | 'ready'
  /** Not satisfied, and it stands in the way. */
  | 'gap'
  /** Not satisfied, and that is a legitimate choice. */
  | 'optional-gap'
  /** A prerequisite is missing, so this was never evaluated. */
  | 'unknown'

export interface ReadinessState {
  id: string
  /** Human words for what this is, not the field name. */
  title: string
  status: StateStatus
  /** The current condition, phrased so it reads under either renderer. */
  detail: string
  remedy?: Remedy
}

export interface Readiness {
  states: ReadinessState[]
}

/** The first thing standing in the way, or null when nothing is. */
export function firstBlocker(readiness: Readiness): ReadinessState | null {
  return readiness.states.find((s) => s.status === 'gap') ?? null
}

/**
 * Ready enough to be useful, which is not the same as every box ticked.
 *
 * Hooks and the agent skill are genuinely optional — `send` works without
 * them — so an install that declined both is finished, not half-done. Saying
 * otherwise trains people to ignore the summary line.
 */
export function isReady(readiness: Readiness): boolean {
  return firstBlocker(readiness) === null
}

/** Everything that could still be done, blocking or not, in dependency order. */
export function openItems(readiness: Readiness): ReadinessState[] {
  return readiness.states.filter((s) => s.status === 'gap' || s.status === 'optional-gap')
}
