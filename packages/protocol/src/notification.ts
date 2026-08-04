import { Type, type Static } from '@sinclair/typebox'
import { LIFECYCLE_END_STATES, LIFECYCLE_TIERS } from './lifecycle.js'

/**
 * The common Notification Request envelope, schema_version 1.
 *
 * The public contract never exposes raw APNs JSON. Provider-owned keys
 * (topic, push type, mutable-content, expiration, provider request ID) are
 * renderer/implementation concerns and are deliberately absent here.
 */

export const NOTIFICATION_SCHEMA_VERSION = 1

/** Fixed identifiers registered by the iOS Companion App for inline replies. */
export const REPLY_CATEGORY_ID = 'notifai.reply'
/**
 * Closed questions carry their own category so the notification presents the
 * answers only. Sharing one category would put a free-text field beside the
 * buttons and invite the open-ended answer the agent asked not to receive.
 */
export const REPLY_CHOICE_CATEGORY_ID = 'notifai.reply.choice'
export const REPLY_ACTION_ID = 'notifai.reply.text'
export const REPLY_MAX_LENGTH = 4000

/** Device platforms known to the public contract. Delivery support is registry-owned. */
export const PLATFORMS = ['ios', 'macos'] as const
export type Platform = (typeof PLATFORMS)[number]
export const PlatformSchema = Type.Union(PLATFORMS.map((platform) => Type.Literal(platform)))

/** Push providers known to the public contract. Platform routing chooses the adapter. */
export const PROVIDERS = ['apns'] as const
export type Provider = (typeof PROVIDERS)[number]
export const ProviderSchema = Type.Union(PROVIDERS.map((provider) => Type.Literal(provider)))

export const ImageRef = Type.Object(
  {
    media_id: Type.String({ pattern: '^med_[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
)

/**
 * Long-form detail, for reading rather than glancing (D-059, NotifAI-n9f).
 *
 * 16 KiB of markdown — comfortably more than the whole APNs envelope, which is
 * the point. This never rides the push: the envelope is 4096 bytes and the
 * banner already spends part of it, so the companion fetches this on open, the
 * same shape as the existing media path. Held to the server's 72-hour content
 * retention like every other piece of presentation content.
 */
export const DETAIL_MAX_BYTES = 16 * 1024

export const Presentation = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 512 }),
    body: Type.String({ minLength: 1, maxLength: 2048 }),
    subtitle: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /**
     * Markdown shown only in the companion app's detail view. The banner is
     * unaffected: `title` and `body` remain the whole of what a glance gets,
     * and an agent that has more to say puts it here instead of overstuffing
     * the body it knows will be truncated.
     */
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: DETAIL_MAX_BYTES })),
    image: Type.Optional(ImageRef),
  },
  { additionalProperties: false },
)

export const TargetSelector = Type.Union([
  Type.Object({ mode: Type.Literal('all') }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal('selected'),
      device_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
])

export const DeliveryPolicy = Type.Object(
  {
    /** AD-007: 24h default; 0 requests one immediate attempt with no retries. */
    ttl_seconds: Type.Integer({ minimum: 0, maximum: 7 * 24 * 3600, default: 86400 }),
    /** AD-007: no collapse by default; opting in requests replacement semantics. */
    collapse_key: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()], {
      default: null,
    }),
  },
  { additionalProperties: false },
)

/**
 * One answer in a closed question. The id is the agent-facing token — stable,
 * machine-checkable, and never shown to the user; the label is the human text
 * rendered on the button.
 */
export const ReplyChoice = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]*$' }),
    label: Type.String({ minLength: 1, maxLength: 40 }),
  },
  { additionalProperties: false },
)
export type ReplyChoiceT = Static<typeof ReplyChoice>

/**
 * Upper bound on choices in one question. Held low deliberately: the buttons
 * render in the expanded notification, where vertical space is scarce and a
 * long list stops being answerable at a glance.
 */
export const REPLY_MAX_CHOICES = 6

/**
 * Upper bound on a reply window, pinned to the server's 72-hour content
 * retention (AD-008). A longer window would outlive the stored draft, and the
 * server cannot accept an answer to a question it has already forgotten — a
 * choice reply arriving after the sweep was rejected as `unknown_choice` and
 * permanently discarded by the device outbox.
 */
export const REPLY_MAX_WINDOW_SECONDS = 72 * 3600

/** Opt-in reply channel (D-045). Presence enables the reply action. */
export const ReplyRequest = Type.Object(
  {
    /** How long the server accepts a reply for this Notification Request. */
    expires_in_seconds: Type.Integer({
      minimum: 60,
      maximum: REPLY_MAX_WINDOW_SECONDS,
      default: 86400,
    }),
    /**
     * `text` is the D-045 free-text composer. `choice` asks a closed question
     * so the agent gets a checkable token back instead of prose it has to
     * interpret. Optional rather than merely defaulted: `Value.Check` does not
     * apply defaults, so a required `kind` would invalidate every reply block
     * written before this field existed.
     */
    kind: Type.Optional(
      Type.Union([Type.Literal('text'), Type.Literal('choice')], { default: 'text' }),
    ),
    /** Required by and only meaningful for `kind: 'choice'`. */
    choices: Type.Optional(
      Type.Array(ReplyChoice, { minItems: 2, maxItems: REPLY_MAX_CHOICES }),
    ),
  },
  { additionalProperties: false },
)

/**
 * Semantic sound names shipped by the iOS Companion App (D-037). Names are
 * intents, not file names, so future channels can map them to their own
 * sound/importance mechanisms.
 */
export const IOS_SOUNDS = ['default', 'done', 'attention', 'alert'] as const
/** Semantic sound names shipped by the macOS Companion App. */
export const MACOS_SOUNDS = ['default', 'done', 'attention', 'alert'] as const
/** CLI spelling adds `none` for the contract's explicit silent (`null`) value. */
export const CLI_SOUNDS = [...IOS_SOUNDS, 'none'] as const

export const INTERRUPTION_LEVELS = ['passive', 'active', 'time_sensitive'] as const

export const IosOptions = Type.Object(
  {
    /** A bundled semantic sound name, or null (silent). */
    sound: Type.Optional(Type.Union([...IOS_SOUNDS.map((sound) => Type.Literal(sound)), Type.Null()])),
    badge: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    thread_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    /** Action categories are deferred with notification-interaction design (D-028). */
    category: Type.Optional(Type.Null()),
    interruption_level: Type.Optional(
      Type.Union(INTERRUPTION_LEVELS.map((l) => Type.Literal(l))),
    ),
    relevance_score: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    target_content_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    /** Namespaced, size-bounded custom data delivered under the `notifai` key. */
    custom_data: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 512 }), {
        maxProperties: 16,
      }),
    ),
  },
  { additionalProperties: false },
)

/**
 * macOS UserNotifications options carried in the shared APNs alert envelope.
 * Sounds come from the bundled semantic set; arbitrary sound files and
 * action categories remain explicit capability-document exclusions.
 */
export const MacosOptions = Type.Object(
  {
    sound: Type.Optional(Type.Union([...MACOS_SOUNDS.map((sound) => Type.Literal(sound)), Type.Null()])),
    badge: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    thread_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    /** Notification actions are deferred with notification-interaction design (D-028). */
    category: Type.Optional(Type.Null()),
    interruption_level: Type.Optional(
      Type.Union(INTERRUPTION_LEVELS.map((level) => Type.Literal(level))),
    ),
    relevance_score: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    target_content_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    /** Namespaced custom data delivered under the `notifai` key. */
    custom_data: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 512 }), {
        maxProperties: 16,
      }),
    ),
  },
  { additionalProperties: false },
)

/**
 * Sender-chosen Project identifier slug (D-038). Projects are registered
 * lazily and idempotently on first send; there is no explicit registration
 * step for agents. Lowercase to keep identifiers canonical across machines.
 */
export const PROJECT_IDENTIFIER_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'

/**
 * Sender-declared position on the lifecycle axis. `state` is detail inside
 * the `done` tier — how the question ended — and is rejected on other tiers
 * by validateDraft, which the schema alone cannot express.
 */
export const Lifecycle = Type.Object(
  {
    tier: Type.Union(LIFECYCLE_TIERS.map((tier) => Type.Literal(tier))),
    state: Type.Optional(Type.Union(LIFECYCLE_END_STATES.map((state) => Type.Literal(state)))),
    /**
     * The request id of the question this `done` draft retires. Collapse keys
     * are optional and were never persisted by companions, so neither the
     * delivered-notification removal nor the history-entry update can rely on
     * one; the request id always exists.
     */
    retires_request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
export type LifecycleT = Static<typeof Lifecycle>

/**
 * What kind of thing this notification *is* (D-060).
 *
 * A third axis, and deliberately not a rename of either of the other two.
 * `lifecycle` says whether something still wants the user; `interruption_level`
 * says how loudly to arrive. Neither can express the difference between "the
 * deploy finished" and "the build is still running" — both are ordinary news
 * that wants nothing and arrives quietly, yet a user scanning a day of them
 * cares which is which. Rafael, 2026-08-03: "semantically users care about
 * these details".
 *
 * Three values, because three is what an agent can actually be trusted to
 * choose between. Kept closed so the companion can render each one rather than
 * printing whatever word the agent invented.
 */
export const NOTIFICATION_KINDS = [
  /** Ordinary news. The default, and the honest answer most of the time. */
  'update',
  /** Asks the user something. Implied by a `reply` block; see below. */
  'question',
  /** A body of work finished. The one an agent should reach for on completion. */
  'done',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** Absent means `update`: a send that says nothing about itself is news. */
export const DEFAULT_NOTIFICATION_KIND: NotificationKind = 'update'

/**
 * The kind a draft actually has.
 *
 * A `reply` block is a question by construction, so asking is never something
 * the sender has to declare twice — and never something it can get wrong. Only
 * the `update`/`done` distinction is genuinely the sender's to make.
 */
export function effectiveKind(draft: NotificationDraftT): NotificationKind {
  if (draft.reply !== undefined) return 'question'
  return draft.kind ?? DEFAULT_NOTIFICATION_KIND
}

export const NotificationDraft = Type.Object(
  {
    schema_version: Type.Literal(NOTIFICATION_SCHEMA_VERSION),
    /** The user-chosen Agent Event name; free-form, no closed taxonomy. */
    event: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /**
     * What this notification is (see NOTIFICATION_KINDS). Absent means
     * `update`. Optional rather than defaulted because `Value.Check` does not
     * apply defaults, and a required field would invalidate every draft
     * written before this one existed.
     */
    kind: Type.Optional(Type.Union(NOTIFICATION_KINDS.map((kind) => Type.Literal(kind)))),
    /**
     * What this notification wants from the user (see lifecycle.ts). Absent
     * means `new`. A draft whose tier is `done` is a state change, not news:
     * renderers deliver it silently and companions retire what it replaces.
     */
    lifecycle: Type.Optional(Lifecycle),
    /** Optional Project identity; lazily recorded server-side (D-038). */
    project: Type.Optional(Type.String({ pattern: PROJECT_IDENTIFIER_PATTERN })),
    /**
     * Opaque per-sender-session identifier (D-042). Companions derive a
     * deterministic avatar badge from it so concurrent agent sessions are
     * visually distinguishable; never interpreted server-side.
     */
    session: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    presentation: Presentation,
    targets: TargetSelector,
    delivery: DeliveryPolicy,
    reply: Type.Optional(ReplyRequest),
    platform: Type.Optional(
      Type.Object(
        { ios: Type.Optional(IosOptions), macos: Type.Optional(MacosOptions) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type DeliveryPolicyT = Static<typeof DeliveryPolicy>
export type ReplyRequestT = Static<typeof ReplyRequest>
export type IosOptionsT = Static<typeof IosOptions>
export type MacosOptionsT = Static<typeof MacosOptions>
export type NotificationDraftT = Static<typeof NotificationDraft>

export function defaultDeliveryPolicy(): DeliveryPolicyT {
  return { ttl_seconds: 86400, collapse_key: null }
}
