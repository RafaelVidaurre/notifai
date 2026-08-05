import { Value } from '@sinclair/typebox/value'
import {
  NotificationDraft,
  type NotificationDraftT,
  IOS_SOUNDS,
  MACOS_SOUNDS,
  INTERRUPTION_LEVELS,
  REPLY_MAX_LENGTH,
  type Platform,
} from './notification.js'
import { buildApnsEnvelope, RECEIPT_TOKEN_LENGTH } from './apns.js'

/**
 * Capability Catalog contract. Unsupported fields must produce
 * explicit capability results, never silent loss.
 */

export type FieldStatus = 'supported' | 'unsupported' | 'downgraded'

export interface CapabilityField {
  /** JSON-pointer-ish path inside the draft, e.g. "presentation.title". */
  path: string
  status: FieldStatus
  /** Present when unsupported/downgraded: why the target surface cannot honor it. */
  reason?: string
  constraints?: Record<string, unknown>
}

export interface CapabilityDocument {
  schema_version: number
  platform: Platform
  /** Provider payload ceiling in bytes for this platform. */
  payload_limit_bytes: number
  sounds: string[]
  interruption_levels: string[]
  fields: CapabilityField[]
}

export const IOS_CAPABILITIES_V1: CapabilityDocument = {
  schema_version: 1,
  platform: 'ios',
  payload_limit_bytes: 4096,
  sounds: [...IOS_SOUNDS],
  interruption_levels: [...INTERRUPTION_LEVELS],
  fields: [
    { path: 'presentation.title', status: 'supported' },
    { path: 'presentation.body', status: 'supported' },
    { path: 'presentation.subtitle', status: 'supported' },
    // Never rendered on the banner by design: it is fetched and shown
    // in the companion's detail view, so it costs nothing against the envelope.
    { path: 'presentation.detail', status: 'supported' },
    {
      path: 'reply',
      status: 'supported',
      constraints: {
        max_length: REPLY_MAX_LENGTH,
        action: 'inline text',
        default_window_seconds: 86400,
      },
      reason:
        'Inline reply through the notification category; the button and placeholder text are fixed by the app.',
    },
    {
      path: 'presentation.image',
      status: 'supported',
      constraints: { max_bytes: 10 * 1024 * 1024, media_types: ['image/jpeg', 'image/png', 'image/gif'] },
      reason: 'Attached through the Notification Service Extension; text remains intelligible if media retrieval fails.',
    },
    { path: 'platform.ios.sound', status: 'supported', constraints: { allowed: [...IOS_SOUNDS, null] } },
    { path: 'platform.ios.badge', status: 'supported' },
    { path: 'platform.ios.thread_id', status: 'supported' },
    {
      path: 'platform.ios.category',
      status: 'unsupported',
      reason: 'Caller-selected categories are unsupported; the companion registers fixed, app-owned reply categories.',
    },
    {
      path: 'platform.ios.interruption_level',
      status: 'supported',
      constraints: {
        allowed: [...INTERRUPTION_LEVELS],
        downgraded_values: ['time_sensitive'],
        default: 'active',
      },
      reason:
        'passive and active are supported; time_sensitive is accepted but Time Sensitive breakthrough is unavailable. critical is unsupported.',
    },
    { path: 'platform.ios.relevance_score', status: 'supported' },
    { path: 'platform.ios.target_content_id', status: 'supported' },
    {
      path: 'platform.ios.custom_data',
      status: 'supported',
      constraints: { max_keys: 16, max_value_length: 512, namespace: 'notifai' },
    },
    {
      path: 'icon',
      status: 'unsupported',
      reason: 'iOS has no arbitrary per-notification app-icon field.',
    },
    {
      path: 'sound_file',
      status: 'unsupported',
      reason: 'Arbitrary sound files are unsupported; sounds come from the bundled semantic set.',
    },
    {
      path: 'localization',
      status: 'unsupported',
      reason: 'The V1 Companion App ships no localization catalogs, so loc-key fields cannot resolve.',
    },
  ],
}

/**
 * macOS UserNotifications support verified against Apple's UNNotificationContent
 * surface: title, subtitle, body, sound, badge, threadIdentifier,
 * interruptionLevel, relevanceScore, targetContentIdentifier, and attachments.
 * The framework exposes attachments, but the current companion path does not
 * attach remote images; the catalog reports that delivery downgrade below.
 * https://developer.apple.com/documentation/usernotifications/unnotificationcontent
 */
export const MACOS_CAPABILITIES_V1: CapabilityDocument = {
  schema_version: 1,
  platform: 'macos',
  payload_limit_bytes: 4096,
  sounds: [...MACOS_SOUNDS],
  interruption_levels: [...INTERRUPTION_LEVELS],
  fields: [
    { path: 'presentation.title', status: 'supported' },
    { path: 'presentation.body', status: 'supported' },
    { path: 'presentation.subtitle', status: 'supported' },
    // Never rendered on the banner by design: it is fetched and shown
    // in the companion's detail view, so it costs nothing against the envelope.
    { path: 'presentation.detail', status: 'supported' },
    // The Mac registers the reply category and answers through the same
    // ReplyOutbox as iOS. One difference worth naming: iOS renders
    // closed questions with a notification content extension, which macOS has
    // no equivalent of, so choices arrive as buttons in the app rather than on
    // the banner. The answer reaches the agent either way.
    { path: 'reply', status: 'supported' },
    {
      path: 'presentation.image',
      status: 'downgraded',
      reason:
        'Remote images are currently omitted on macOS; the text notification is still delivered.',
    },
    { path: 'platform.macos.sound', status: 'supported', constraints: { allowed: [...MACOS_SOUNDS, null] } },
    { path: 'platform.macos.badge', status: 'supported' },
    { path: 'platform.macos.thread_id', status: 'supported' },
    {
      path: 'platform.macos.category',
      status: 'unsupported',
      reason: 'Caller-selected categories are unsupported; the companion registers fixed, app-owned reply categories.',
    },
    {
      path: 'platform.macos.interruption_level',
      status: 'supported',
      constraints: {
        allowed: [...INTERRUPTION_LEVELS],
        downgraded_values: ['time_sensitive'],
        default: 'active',
      },
      reason:
        'passive and active are supported; time_sensitive is accepted but Time Sensitive breakthrough is unavailable. critical is unsupported.',
    },
    { path: 'platform.macos.relevance_score', status: 'supported' },
    { path: 'platform.macos.target_content_id', status: 'supported' },
    {
      path: 'platform.macos.custom_data',
      status: 'supported',
      constraints: { max_keys: 16, max_value_length: 512, namespace: 'notifai' },
    },
    {
      path: 'icon',
      status: 'unsupported',
      reason: 'macOS has no arbitrary per-notification app-icon field.',
    },
    {
      path: 'sound_file',
      status: 'unsupported',
      reason: 'Arbitrary sound files are unsupported; sounds come from the bundled semantic set.',
    },
    {
      path: 'localization',
      status: 'unsupported',
      reason: 'The V1 macOS Companion App ships no localization catalogs, so loc-key fields cannot resolve.',
    },
  ],
}

/** Platform-keyed catalog. Missing describes an intentionally unimplemented channel. */
export interface CapabilityRegistry {
  describe(platform: Platform): CapabilityDocument | null
}

export function createCapabilityRegistry(
  documents: readonly CapabilityDocument[],
): CapabilityRegistry {
  const byPlatform = new Map(documents.map((document) => [document.platform, document]))
  return {
    describe(platform) {
      return byPlatform.get(platform) ?? null
    },
  }
}

/** V1 publishes both APNs-backed companion surfaces. */
export const CAPABILITY_DOCUMENTS_V1 = [IOS_CAPABILITIES_V1, MACOS_CAPABILITIES_V1] as const
export const CAPABILITIES_V1 = createCapabilityRegistry(CAPABILITY_DOCUMENTS_V1)

export interface ValidationIssue {
  code: 'invalid_request' | 'unsupported_field' | 'payload_too_large'
  path: string
  message: string
}

export interface CapabilityWarning {
  path: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  errors: ValidationIssue[]
  warnings: CapabilityWarning[]
}

function isCapabilityDocumentList(
  value: CapabilityDocument | readonly CapabilityDocument[],
): value is readonly CapabilityDocument[] {
  return Array.isArray(value)
}

/**
 * Validate a draft against the schema and one or more capability documents. Shared by the
 * CLI (offline pre-flight with the bundled document) and the control plane
 * (authoritative check at submission).
 */
export function validateDraft(
  draft: unknown,
  capabilities: CapabilityDocument | readonly CapabilityDocument[] = IOS_CAPABILITIES_V1,
): ValidationReport {
  const errors: ValidationIssue[] = []
  const warnings: CapabilityWarning[] = []

  if (!Value.Check(NotificationDraft, draft)) {
    for (const err of [...Value.Errors(NotificationDraft, draft)].slice(0, 20)) {
      errors.push({
        code: 'invalid_request',
        path: err.path.replaceAll('/', '.').replace(/^\./, ''),
        message: err.message,
      })
    }
    return { ok: false, errors, warnings }
  }

  const documents: readonly CapabilityDocument[] = isCapabilityDocumentList(capabilities)
    ? capabilities
    : [capabilities]
  const typed = draft as NotificationDraftT

  // `kind` and `choices` are two halves of one statement, and the schema can
  // only check them separately. A closed question with no answers, or answers
  // that collide on id, would reach the device as an unanswerable notification.
  if (typed.reply !== undefined) {
    const { kind, choices } = typed.reply
    if (kind === 'choice') {
      if (choices === undefined) {
        errors.push({
          code: 'invalid_request',
          path: 'reply.choices',
          message: "A reply of kind 'choice' must list the choices to offer.",
        })
      } else {
        const seen = new Set<string>()
        for (const choice of choices) {
          if (seen.has(choice.id)) {
            errors.push({
              code: 'invalid_request',
              path: 'reply.choices',
              message: `Duplicate choice id '${choice.id}' — ids identify the answer to the agent and must be unique.`,
            })
            break
          }
          seen.add(choice.id)
        }
      }
    } else if (choices !== undefined) {
      errors.push({
        code: 'invalid_request',
        path: 'reply.choices',
        message: "Choices are only meaningful with kind: 'choice'.",
      })
    }
  }

  // Declaring a question without opening a reply window would render an
  // answering affordance on the device that nothing can satisfy — the user
  // taps, and the answer has nowhere to go. Asking is a thing you do, not a
  // label you apply.
  if (typed.kind === 'question' && typed.reply === undefined) {
    errors.push({
      code: 'invalid_request',
      path: 'kind',
      message:
        "kind: 'question' needs a reply block — a question the user cannot answer is not one. Use `notifai ask`, or send with a reply request.",
    })
  }

  // How something ended is detail inside `done`; on any other tier it would
  // claim an ending the notification has not had.
  if (typed.lifecycle !== undefined && typed.lifecycle.tier !== 'done') {
    if (typed.lifecycle.state !== undefined) {
      errors.push({
        code: 'invalid_request',
        path: 'lifecycle.state',
        message: "A lifecycle end state is only meaningful with tier: 'done'.",
      })
    }
    if (typed.lifecycle.retires_request_id !== undefined) {
      errors.push({
        code: 'invalid_request',
        path: 'lifecycle.retires_request_id',
        message: "Retiring another request is only meaningful with tier: 'done'.",
      })
    }
  }

  for (const document of documents) {
    const options = typed.platform?.[document.platform]
    if (options?.category !== undefined && options.category !== null) {
      errors.push({
        code: 'unsupported_field',
        path: `platform.${document.platform}.category`,
        message: findReason(document, `platform.${document.platform}.category`),
      })
    }

    for (const field of document.fields) {
      const value = draftValueAtPath(typed, field.path)
      const downgradedValues = field.constraints?.downgraded_values
      const isDowngradedValue =
        Array.isArray(downgradedValues) && downgradedValues.includes(value)
      if (
        value !== undefined &&
        value !== null &&
        (field.status === 'downgraded' || isDowngradedValue)
      ) {
        warnings.push({
          path: field.path,
          message:
            field.reason ??
            `The field ${field.path} is delivered with reduced behavior on ${document.platform}.`,
        })
      }
    }

    const estimated = estimateApnsPayloadBytes(typed, document.platform)
    if (estimated > document.payload_limit_bytes) {
      errors.push({
        code: 'payload_too_large',
        path: documents.length === 1 ? 'presentation' : `platform.${document.platform}`,
        message:
          documents.length === 1
            ? `Estimated APNs payload is ${estimated} bytes; the limit is ${document.payload_limit_bytes}.`
            : `Estimated ${document.platform} APNs payload is ${estimated} bytes; the limit is ${document.payload_limit_bytes}.`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function findReason(capabilities: CapabilityDocument, path: string): string {
  const field = capabilities.fields.find((f) => f.path === path)
  return field?.reason ?? `The field ${path} is not supported on ${capabilities.platform}.`
}

function draftValueAtPath(draft: NotificationDraftT, path: string): unknown {
  let value: unknown = draft
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

/**
 * Conservative byte accounting for the exact APNs envelope. A fixed-length
 * signed media URL keeps pre-flight validation safe before a real URL exists.
 */
export function estimateApnsPayloadBytes(draft: NotificationDraftT, platform: Platform = 'ios'): number {
  const envelope = buildApnsEnvelope(
    draft,
    {
      requestId: 'req_00000000000000000000000000',
      deliveryId: 'del_00000000000000000000000000',
      // Fixed width by construction (a truncated HMAC), so a placeholder
      // reserves exactly the room the real token will take.
      receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
    },
    draft.presentation.image ? 'https://x.invalid/'.padEnd(500, 'a') : null,
    platform,
    // A project may resolve to a sender name and signed avatar URL at
    // dispatch; reserve worst-case room so acceptance implies deliverability.
    draft.project !== undefined
      ? { name: 'n'.padEnd(128, 'n'), imageUrl: 'https://x.invalid/'.padEnd(500, 'a') }
      : null,
    // ISO-8601 instants are fixed width, so any date reserves the real room.
    draft.reply !== undefined ? new Date(0) : null,
  )
  return new TextEncoder().encode(JSON.stringify(envelope.payload)).length
}
