import { Type, type Static } from '@sinclair/typebox'
import {
  NotificationDraft,
  PlatformSchema,
  ProviderSchema,
  REPLY_MAX_LENGTH,
  type Platform,
} from './notification.js'
import type {
  CompanionReceiptState,
  DeliveryState,
  OverallState,
  EvidenceStage,
} from './status.js'

/** REST v1 wire contract shared by server, CLI, dashboard, and Companion App. */

// ---------------------------------------------------------------------------
// Account access (the account shell is not product access)
// ---------------------------------------------------------------------------

/**
 * Stable access state returned to every authenticated client. `active` is
 * intentionally separate from the reason so later subscription and durable
 * payment-exemption decisions can extend the source without changing the
 * no-plan boundary or making Alpha look permanent.
 */
export const ACCESS_STATUSES = ['no_active_plan', 'active'] as const
export type AccountAccessStatus = (typeof ACCESS_STATUSES)[number]

/** Current Alpha source plus explicit slots for later paid V1 sources. */
export const ACCESS_REASONS = [
  'no_active_grant',
  'alpha_grant',
  'subscription',
  'payment_exemption',
] as const
export type AccountAccessReason = (typeof ACCESS_REASONS)[number]

export interface AccountAccessResponse {
  status: AccountAccessStatus
  reason: AccountAccessReason
  /** Alpha grants are temporary; future sources may also carry an expiry. */
  expires_at: string | null
}

// ---------------------------------------------------------------------------
// Machine pairing (Machine Access seam)
// ---------------------------------------------------------------------------

export const BeginPairingRequest = Type.Object(
  {
    machine_name: Type.String({ minLength: 1, maxLength: 128 }),
    /** SHA-256 hex of the locally generated 256-bit machine secret. */
    credential_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    /** SHA-256 hex of the one-time poll verifier; proves the poller began this pairing. */
    poll_verifier_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
)
export type BeginPairingRequestT = Static<typeof BeginPairingRequest>

export interface BeginPairingResponse {
  pairing_id: string
  /** Short human-checkable code shown in both CLI and approval page. */
  code: string
  approve_url: string
  expires_at: string
  poll_interval_seconds: number
}

export const PollPairingRequest = Type.Object(
  { poll_verifier: Type.String({ minLength: 32, maxLength: 128 }) },
  { additionalProperties: false },
)
export type PollPairingRequestT = Static<typeof PollPairingRequest>

export interface PollPairingResponse {
  status: 'pending' | 'approved' | 'expired' | 'denied'
  machine_id?: string
}

export interface PairingDetailsResponse {
  pairing_id: string
  machine_name: string
  code: string
  status: 'pending' | 'approved' | 'expired' | 'denied'
  expires_at: string
}

export interface MachineSummary {
  machine_id: string
  name: string
  status: 'active' | 'revoked'
  approved_at: string
  revoked_at: string | null
  last_seen_at: string | null
}

export interface ListMachinesResponse {
  machines: MachineSummary[]
}

// ---------------------------------------------------------------------------
// Device Registry (Companion App seam)
// ---------------------------------------------------------------------------

export const RegisterInstallationRequest = Type.Object(
  {
    /** Stable random identifier generated once per app installation. */
    installation_id: Type.String({ pattern: '^ins_[A-Za-z0-9_-]{10,64}$' }),
    platform: PlatformSchema,
    display_name: Type.String({ minLength: 1, maxLength: 128 }),
    app_version: Type.String({ minLength: 1, maxLength: 32 }),
  },
  { additionalProperties: false },
)
export type RegisterInstallationRequestT = Static<typeof RegisterInstallationRequest>

export const PutRegistrationRequest = Type.Object(
  {
    provider: ProviderSchema,
    environment: Type.Union([Type.Literal('development'), Type.Literal('production')]),
    /** Hex APNs device token as handed to the companion app. */
    token: Type.String({ pattern: '^[a-f0-9]{32,512}$' }),
  },
  { additionalProperties: false },
)
export type PutRegistrationRequestT = Static<typeof PutRegistrationRequest>

export interface PutRegistrationResponse {
  registration_version: number
}

export const ReportHealthRequest = Type.Object(
  {
    permission_status: Type.Union([
      Type.Literal('authorized'),
      Type.Literal('provisional'),
      Type.Literal('denied'),
      Type.Literal('not_determined'),
    ]),
    alerts_enabled: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type ReportHealthRequestT = Static<typeof ReportHealthRequest>

export interface RoutableDevice {
  device_id: string
  display_name: string
  platform: Platform
  permission_status: string
  registration_healthy: boolean
  last_seen_at: string | null
}

export interface ListDevicesResponse {
  devices: RoutableDevice[]
}

// ---------------------------------------------------------------------------
// Notification submission and evidence
// ---------------------------------------------------------------------------

export const SubmitNotificationRequest = Type.Object(
  {
    idempotency_key: Type.String({ minLength: 8, maxLength: 128 }),
    draft: NotificationDraft,
  },
  { additionalProperties: false },
)
export type SubmitNotificationRequestT = Static<typeof SubmitNotificationRequest>

export interface DeliveryOutcome {
  delivery_id: string
  device_id: string
  device_name: string
  state: DeliveryState
  attempts: number
  provider_status: number | null
  provider_reason: string | null
  provider_id: string | null
  updated_at: string
}

export interface SubmissionReceipt {
  request_id: string
  /** True when idempotency returned a previously accepted request. */
  replayed: boolean
  overall: OverallState
  deliveries: DeliveryOutcome[]
  warnings: { path: string; message: string }[]
}

export interface EvidenceEvent {
  stage: EvidenceStage
  source: string
  reason: string | null
  attempt: number | null
  occurred_at: string
}

/**
 * Derived from the first Companion Receipt event for one Delivery. Unknown
 * means only that no receipt has been observed; it is not a timeout or failure.
 */
export interface CompanionReceiptEvidence {
  state: CompanionReceiptState
  observed_at: string | null
  /** First companion_received minus first provider_accepted, when both exist. */
  latency_ms: number | null
}

export interface EvidenceSnapshot {
  request_id: string
  event: string | null
  accepted_at: string
  overall: OverallState
  deliveries: (DeliveryOutcome & {
    companion_receipt: CompanionReceiptEvidence
    events: EvidenceEvent[]
  })[]
}

// ---------------------------------------------------------------------------
// Companion Receipt (best-effort diagnostic; not proof of display)
// ---------------------------------------------------------------------------

export const CompanionReceiptRequest = Type.Object(
  {
    delivery_id: Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' }),
    /**
     * The delivery's own secret, taken from the push payload. Present, it is
     * the whole authorization and no user session is needed — which is what
     * keeps Notification Service Extensions out of the keychain. Absent, the
     * request falls back to a bearer token, so companions installed before the
     * token existed keep reporting.
     */
    receipt_token: Type.Optional(Type.String({ minLength: 16, maxLength: 64 })),
  },
  { additionalProperties: false },
)
export type CompanionReceiptRequestT = Static<typeof CompanionReceiptRequest>

// ---------------------------------------------------------------------------
// Inline replies (opaque text carried from Companion App to agent)
// ---------------------------------------------------------------------------

export const SubmitReplyRequest = Type.Object(
  {
    delivery_id: Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' }),
    text: Type.String({ minLength: 1, maxLength: REPLY_MAX_LENGTH }),
    /** Device-generated id; makes outbox retries idempotent. */
    client_reply_id: Type.String({ minLength: 8, maxLength: 64 }),
    /**
     * Set when the user answered a closed question. The server validates it
     * against that request's choice set and rewrites `text` to the canonical
     * label, so a stored choice reply cannot disagree with what was asked.
     */
    choice_id: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    /**
     * Which surface the user actually answered from. Two iOS
     * routes converge here — the custom text action and the system
     * message-style field, which arrives as a SiriKit intent — and a third is
     * the in-app composer. They looked identical once stored, so a regression
     * in one of them was indistinguishable from a regression in another
     * without device logs.
     *
     * Optional and open: a device that does not send it is not wrong, and an
     * unknown value is recorded rather than rejected, because rejecting a
     * reply over a diagnostic field would lose the answer.
     */
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  },
  { additionalProperties: false },
)
export type SubmitReplyRequestT = Static<typeof SubmitReplyRequest>

/** The reply surfaces the companions know how to name. */
export const REPLY_SOURCES = [
  /** iOS custom UNTextInputNotificationAction, reached by long-press. */
  'action',
  /** iOS system message-style field, delivered as an INSendMessageIntent. */
  'intent',
  /** The notification content extension's answer buttons. */
  'choice',
  /** The companion app's own detail-view composer or picker. */
  'app',
] as const

export interface ReplyView {
  reply_id: string
  /** Monotonic cursor within the Notification Request. */
  seq: number
  delivery_id: string
  device_id: string
  device_name: string
  text: string
  /** The agent-facing token for a closed question; null for free text. */
  choice_id: string | null
  /** Which surface it was answered from, when the device said. */
  source: string | null
  created_at: string
}

export interface ListRepliesResponse {
  request_id: string
  /** Null when the Notification Request did not request replies. */
  reply_expires_at: string | null
  replies: ReplyView[]
}

// ---------------------------------------------------------------------------
// Media intake
// ---------------------------------------------------------------------------

export const CreateMediaUploadRequest = Type.Object(
  {
    media_type: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/png'),
      Type.Literal('image/gif'),
    ]),
    size_bytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
)
export type CreateMediaUploadRequestT = Static<typeof CreateMediaUploadRequest>

export interface CreateMediaUploadResponse {
  media_id: string
  upload_url: string
  /** Headers the client must send with the PUT upload. */
  upload_headers: Record<string, string>
  expires_at: string
}

// ---------------------------------------------------------------------------
// Projects (lazy identity; user-facing customization surface)
// ---------------------------------------------------------------------------

export const UpdateProjectRequest = Type.Object(
  {
    display_name: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    /** A ready media id to use as the avatar, or null to clear it. */
    image_media_id: Type.Optional(
      Type.Union([Type.String({ pattern: '^med_[A-Za-z0-9_-]+$' }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
)
export type UpdateProjectRequestT = Static<typeof UpdateProjectRequest>

export interface ProjectView {
  project_id: string
  identifier: string
  display_name: string | null
  image_media_id: string | null
  /** Public generated avatar URL, or a short-lived signed URL for custom media. */
  image_url: string | null
  last_seen_at: string
}

export interface ListProjectsResponse {
  projects: ProjectView[]
}
