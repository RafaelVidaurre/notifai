/**
 * Notification lifecycle vocabulary — a separate axis from the delivery
 * status in status.ts. DELIVERY_STATES describe dispatch: whether a provider
 * accepted a push. This axis describes what a notification wants from the
 * user, which is orthogonal: a question whose push was accepted is still
 * unanswered, and an answered question may have deliveries still in flight.
 *
 * The shape is one scan question — "does this want something from me?" —
 * so the tiers are few and coarse on purpose (D-C). How a question ended is
 * detail INSIDE `done`, never a peer of the tiers.
 */

export const LIFECYCLE_TIERS = [
  /** Wants an answer; blocks the user's scan until it has one. */
  'needs_you',
  /** Wants to be read; news the user has not seen yet. */
  'new',
  /** Wants nothing; history. The `state` detail says how it ended. */
  'done',
] as const
export type LifecycleTier = (typeof LIFECYCLE_TIERS)[number]

/**
 * How a `done` notification ended. Only meaningful alongside tier `done`;
 * validators reject it on any other tier rather than letting a state float
 * free of the question it closes.
 */
export const LIFECYCLE_END_STATES = [
  /** Answered from a device the question was pushed to. */
  'answered',
  /** Answered somewhere the push never reached, e.g. the agent's terminal. */
  'answered_elsewhere',
  /** Nobody answered before the question stopped being live. */
  'expired',
  /** Replaced by a newer question before any answer arrived. */
  'superseded',
] as const
export type LifecycleEndState = (typeof LIFECYCLE_END_STATES)[number]

/**
 * Lifecycle absent means `new`: an ordinary send is news by default, and
 * pre-lifecycle clients change meaning for nothing they already send.
 */
export const DEFAULT_LIFECYCLE_TIER: LifecycleTier = 'new'
