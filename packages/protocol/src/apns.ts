import {
  DEFAULT_NOTIFICATION_KIND,
  effectiveKind,
  REPLY_CATEGORY_ID,
  REPLY_CHOICE_CATEGORY_ID,
  type NotificationDraftT,
  type Platform,
} from './notification.js'

export interface ApnsEnvelope {
  payload: Record<string, unknown>
  /** APNs priority derived from the selected platform interruption level. */
  priority: 10 | 5
  /**
   * APNs push type the transport must send. `background` is the silent state
   * sync of a `done` lifecycle draft; 5 is the only legal priority for it.
   */
  pushType: 'alert' | 'background'
}

/**
 * Pure APNs payload assembly shared by server rendering and client-side size
 * estimation. Transport headers such as expiration and collapse are owned by
 * the server's APNs renderer rather than the public draft.
 */
/** Dispatch-time Project identity resolved by the server. */
export interface ProjectIdentity {
  /** User-facing sender name; companions fall back to the identifier. */
  name?: string | null
  /** Generated public or custom signed avatar URL the NSE can fetch. */
  imageUrl?: string | null
}

/**
 * What a companion needs to name this delivery back to the server. The receipt
 * token is the delivery's own secret: it lets an extension
 * acknowledge arrival without a user session, which is why neither Notification
 * Service Extension touches the keychain any more.
 */
export interface EnvelopeIds {
  requestId: string
  deliveryId: string
  receiptToken?: string | null
}

/**
 * Encoded token width — a 16-byte truncated HMAC, base64url, no padding. It is
 * fixed by construction, which is what lets pre-flight size estimation reserve
 * the exact room the real token will take.
 */
export const RECEIPT_TOKEN_LENGTH = 22

export function buildApnsEnvelope(
  draft: NotificationDraftT,
  ids: EnvelopeIds,
  mediaUrl: string | null,
  platform: Platform = 'ios',
  projectIdentity: ProjectIdentity | null = null,
  /**
   * Server-owned close time of this request's reply window. Companions keep
   * their notification history on-device, so the deadline travels with
   * the notification instead of requiring a lookup to offer a reply later.
   */
  replyExpiresAt: Date | null = null,
): ApnsEnvelope {
  const options = draft.platform?.[platform]
  // A state change is not news (D-B): a `done` draft retires what it replaces
  // rather than announcing itself. Apple forbids alert, sound, and badge
  // alongside content-available, and the remaining aps keys only describe
  // visible notifications, so the silent form carries exactly one key.
  if (draft.lifecycle?.tier === 'done') {
    return {
      payload: {
        aps: { 'content-available': 1 },
        notifai: notifaiKey(draft, ids, mediaUrl, projectIdentity, replyExpiresAt, options),
      },
      priority: 5,
      pushType: 'background',
    }
  }
  const aps: Record<string, unknown> = {
    alert: {
      title: draft.presentation.title,
      ...(draft.presentation.subtitle !== undefined ? { subtitle: draft.presentation.subtitle } : {}),
      body: draft.presentation.body,
    },
  }
  // Omitted is the explicit silent form. Semantic names resolve to CAF files
  // bundled in the companion apps; 'default' stays the APNs keyword.
  if (options?.sound !== null) {
    const sound = options?.sound ?? 'default'
    aps['sound'] = sound === 'default' ? 'default' : `${sound}.caf`
  }
  if (options?.badge !== undefined && options.badge !== null) aps['badge'] = options.badge
  if (options?.thread_id !== undefined && options.thread_id !== null) aps['thread-id'] = options.thread_id
  // The capability document's default is active, so both estimate and send
  // now materialize the same APNs interruption-level rule.
  aps['interruption-level'] = options?.interruption_level ?? 'active'
  if (options?.relevance_score !== undefined && options.relevance_score !== null) {
    aps['relevance-score'] = options.relevance_score
  }
  if (options?.target_content_id !== undefined && options.target_content_id !== null) {
    aps['target-content-id'] = options.target_content_id
  }
  if (draft.reply !== undefined) {
    aps['category'] =
      draft.reply.kind === 'choice' ? REPLY_CHOICE_CATEGORY_ID : REPLY_CATEGORY_ID
  }
  if (mediaUrl !== null || draft.project !== undefined) {
    // The Notification Service Extension downloads and attaches the image
    // and applies the project's communication identity; text still shows if
    // the extension or downloads fail.
    aps['mutable-content'] = 1
  }

  const notifai = notifaiKey(draft, ids, mediaUrl, projectIdentity, replyExpiresAt, options)

  return {
    payload: { aps, notifai },
    priority: options?.interruption_level === 'passive' ? 5 : 10,
    pushType: 'alert',
  }
}

/**
 * The custom `notifai` payload key — everything companions need that is not
 * APNs presentation. Assembled once so the silent `done` form publishes the
 * same identifiers as the alert it retires.
 */
function notifaiKey(
  draft: NotificationDraftT,
  ids: EnvelopeIds,
  mediaUrl: string | null,
  projectIdentity: ProjectIdentity | null,
  replyExpiresAt: Date | null,
  options?: NonNullable<NotificationDraftT['platform']>[Platform],
): Record<string, unknown> {
  const kind = effectiveKind(draft)
  return {
    request_id: ids.requestId,
    delivery_id: ids.deliveryId,
    // The delivery's own secret, spent on exactly one thing: acknowledging
    // that this push arrived. Costs 40 bytes of a 4096-byte envelope and buys
    // an extension that needs no session, no keychain and no entitlement.
    ...(ids.receiptToken != null ? { receipt_token: ids.receiptToken } : {}),
    ...(draft.event !== undefined ? { event: draft.event } : {}),
    // Only when it says something. `update` is what a reader assumes in its
    // absence, and the envelope is 4096 bytes — no key earns space by
    // restating the default.
    ...(kind !== DEFAULT_NOTIFICATION_KIND ? { kind } : {}),
    // The lifecycle axis rides every push so companions can render
    // needs-you / new / done without a server lookup; on a background
    // retirement it is the whole message.
    ...(draft.lifecycle !== undefined ? { lifecycle: draft.lifecycle } : {}),
    // The two correlation ids do different jobs on a retirement: the
    // collapse key (also the APNs apns-collapse-id) removes the DELIVERED
    // notification, while retires_request_id finds the on-device HISTORY
    // entry — keyed by request id — and marks it done.
    ...(draft.lifecycle?.tier === 'done' && draft.lifecycle.retires_request_id !== undefined
      ? { retires_request_id: draft.lifecycle.retires_request_id }
      : {}),
    ...(draft.delivery.collapse_key !== null ? { collapse_key: draft.delivery.collapse_key } : {}),
    ...(draft.project !== undefined ? { project: draft.project } : {}),
    // Session badge input; companions hash it into a shape+color.
    ...(draft.session !== undefined ? { session: draft.session } : {}),
    // Sender identity for communication-style presentation.
    ...(projectIdentity?.name != null ? { project_name: projectIdentity.name } : {}),
    ...(projectIdentity?.imageUrl != null ? { project_image_url: projectIdentity.imageUrl } : {}),
    ...(options?.custom_data !== undefined ? { data: options.custom_data } : {}),
    ...(mediaUrl !== null ? { media_url: mediaUrl } : {}),
    // A flag, never the content. Long-form detail is up to 16 KiB and
    // the whole envelope is 4096 bytes, so the companion is told there is
    // something to fetch and fetches it when the user opens the notification.
    ...(draft.presentation.detail !== undefined ? { has_detail: true } : {}),
    // Only meaningful alongside the reply category, and only the server knows
    // the absolute deadline; the companion offers or retires its in-app
    // composer from this value.
    ...(draft.reply !== undefined && replyExpiresAt !== null
      ? { reply_expires_at: replyExpiresAt.toISOString() }
      : {}),
    // The choice set travels with the notification for the same reason the
    // deadline does: the content extension and the in-app picker must render
    // labels with no network round-trip and no server lookup.
    ...(draft.reply?.kind === 'choice' && draft.reply.choices !== undefined
      ? { reply_choices: draft.reply.choices }
      : {}),
  }
}
