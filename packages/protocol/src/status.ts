/**
 * Status vocabulary per AD-006. The word "delivered" is intentionally absent:
 * Provider Acceptance is not evidence that a notification was displayed or
 * seen, and Companion Receipt is best-effort diagnostic evidence only.
 */

export const DELIVERY_STATES = [
  'queued',
  'retry_scheduled',
  'provider_accepted',
  'provider_rejected',
  'outcome_unknown',
  'expired',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** States from which no further dispatch attempt may run. */
export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
  'provider_accepted',
  'provider_rejected',
  'outcome_unknown',
  'expired',
]

export const OVERALL_STATES = [
  'pending',
  'provider_accepted_all',
  'provider_accepted_partial',
  'provider_rejected_all',
] as const
export type OverallState = (typeof OVERALL_STATES)[number]

export const EVIDENCE_STAGES = [
  'accepted',
  'queued',
  'attempt_started',
  'provider_accepted',
  'provider_rejected',
  'retry_scheduled',
  'outcome_unknown',
  'expired',
  'registration_invalidated',
  'companion_received',
  'reply_received',
] as const
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number]

/** Summarize per-Delivery states into one overall request state. */
export function summarizeOverall(states: readonly DeliveryState[]): OverallState {
  if (states.length === 0) return 'pending'
  const accepted = states.filter((s) => s === 'provider_accepted').length
  const rejectedLike = states.filter(
    (s) => s === 'provider_rejected' || s === 'expired' || s === 'outcome_unknown',
  ).length
  const settled = accepted + rejectedLike
  if (settled < states.length) return 'pending'
  if (accepted === states.length) return 'provider_accepted_all'
  if (accepted === 0) return 'provider_rejected_all'
  return 'provider_accepted_partial'
}

export const ERROR_CODES = [
  'auth_required',
  'machine_revoked',
  'no_active_devices',
  'unknown_device',
  'unsupported_field',
  'payload_too_large',
  'invalid_request',
  'pairing_not_found',
  'pairing_expired',
  'pairing_already_used',
  'rate_limited',
  'not_found',
  'conflict',
  'reply_not_enabled',
  'reply_window_closed',
  /** The submitted choice is not one this question offered; never retryable. */
  'unknown_choice',
  'internal_error',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    /** Stable machine-actionable next step, e.g. "Run `notifai auth login`." */
    next_action?: string
    details?: unknown
  }
}
