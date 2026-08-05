import {
  CLI_SOUNDS,
  INTERRUPTION_LEVELS,
  NOTIFICATION_SCHEMA_VERSION,
  type IosOptionsT,
  type LifecycleT,
  type MacosOptionsT,
  type NotificationDraftT,
  NOTIFICATION_KINDS,
  PLATFORMS,
  type Platform,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import type { CliConfig } from './config.js'

type CliSound = (typeof CLI_SOUNDS)[number]

export interface SendFlags {
  title: string
  body: string
  subtitle?: string
  /** Long-form markdown for the app's detail view; never on the banner. */
  detail?: string
  event?: string
  /** What this notification is: update (default), done, or question. */
  kind?: string
  project?: string
  session?: string
  device?: string[]
  all?: boolean
  ttl?: number
  collapseKey?: string
  sound?: string
  badge?: number
  threadId?: string
  level?: string
  relevance?: number
  targetContentId?: string
  data?: string[]
  image?: string
  /** Enable the inline reply action for this Notification Request. */
  reply?: boolean
  /** How long the server accepts a reply after submission. */
  replyWindow?: number
  /**
   * Answer labels; turns the reply into a closed question. One value splits on
   * commas; repeating the flag passes each label through verbatim.
   */
  replyChoice?: string | string[]
  /** Platform whose optional notification fields these flags configure. */
  platform?: string
  /**
   * Lifecycle position of this send; not a user-facing flag. Hooks set it so
   * questions and their retirements ride the wire as what they are.
   */
  lifecycle?: LifecycleT
}

export type DraftBuild =
  | { ok: true; draft: NotificationDraftT; platform: Platform }
  | { ok: false; error: string }

/** Merge flags over resolved config into a Notification Request draft. */
export function buildDraft(config: CliConfig, flags: SendFlags): DraftBuild {
  if (!flags.title || !flags.body) return { ok: false, error: 'Both --title and --body are required.' }
  const platform = resolvePlatform(flags.platform)
  if (!platform) {
    return { ok: false, error: `Unknown platform "${flags.platform}" — use ${PLATFORMS.join(' or ')}.` }
  }

  const deviceIds = flags.all ? null : (flags.device?.length ? flags.device : config.devices.value)
  const targets: NotificationDraftT['targets'] =
    deviceIds && deviceIds.length > 0 ? { mode: 'selected', device_ids: deviceIds } : { mode: 'all' }

  const sound = flags.sound ?? config.sound.value
  if (sound !== null && sound !== undefined && !CLI_SOUNDS.includes(sound as CliSound)) {
    return {
      ok: false,
      error: `Unknown sound "${sound}" — supported: ${CLI_SOUNDS.map((value) => `"${value}"`).join(', ')}.`,
    }
  }
  const level = flags.level ?? config.interruption_level.value
  if (
    level !== null &&
    level !== undefined &&
    !INTERRUPTION_LEVELS.includes(level as (typeof INTERRUPTION_LEVELS)[number])
  ) {
    return { ok: false, error: `Unknown interruption level "${level}".` }
  }

  const options: IosOptionsT & MacosOptionsT = {}
  if (sound === 'none') options.sound = null
  else if (sound !== null && sound !== undefined) {
    options.sound = sound as Exclude<(typeof CLI_SOUNDS)[number], 'none'>
  }
  if (flags.badge !== undefined) options.badge = flags.badge
  if (flags.threadId !== undefined) options.thread_id = flags.threadId
  if (level !== null && level !== undefined) {
    options.interruption_level = level as (typeof INTERRUPTION_LEVELS)[number]
  }
  if (flags.relevance !== undefined) options.relevance_score = flags.relevance
  if (flags.targetContentId !== undefined) options.target_content_id = flags.targetContentId
  if (flags.data?.length) {
    const data: Record<string, string> = {}
    for (const pair of flags.data) {
      const eq = pair.indexOf('=')
      if (eq <= 0) return { ok: false, error: `--data expects key=value, got "${pair}".` }
      data[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    options.custom_data = data
  }

  if (
    flags.kind !== undefined &&
    !NOTIFICATION_KINDS.includes(flags.kind as (typeof NOTIFICATION_KINDS)[number])
  ) {
    return {
      ok: false,
      error: `Unknown kind "${flags.kind}" — supported: ${NOTIFICATION_KINDS.map((kind) => `"${kind}"`).join(', ')}.`,
    }
  }

  const ttl = flags.ttl ?? config.ttl_seconds.value
  const collapse = flags.collapseKey ?? config.collapse_key.value

  const project = flags.project ?? config.project.value
  // Harnesses can export NOTIFAI_SESSION once instead of passing the flag
  // on every send.
  const session = flags.session ?? process.env['NOTIFAI_SESSION']

  // Ids are derived from labels so an agent writing a one-liner does not have
  // to invent them, but they stay the stable thing it branches on afterwards.
  const choices = parseChoices(flags.replyChoice)
  if (choices === 'invalid') {
    return {
      ok: false,
      error: CHOICE_USAGE,
    }
  }

  const draft: NotificationDraftT = {
    schema_version: NOTIFICATION_SCHEMA_VERSION,
    ...(flags.event !== undefined ? { event: flags.event } : {}),
    ...(flags.kind !== undefined
      ? { kind: flags.kind as (typeof NOTIFICATION_KINDS)[number] }
      : {}),
    ...(flags.lifecycle !== undefined ? { lifecycle: flags.lifecycle } : {}),
    ...(project !== null && project !== undefined ? { project } : {}),
    ...(session !== undefined && session !== '' ? { session } : {}),
    presentation: {
      title: flags.title,
      body: flags.body,
      ...(flags.subtitle !== undefined ? { subtitle: flags.subtitle } : {}),
      ...(flags.detail !== undefined && flags.detail.trim() !== ''
        ? { detail: flags.detail }
        : {}),
      ...(flags.image !== undefined ? { image: { media_id: flags.image } } : {}),
    },
    targets,
    delivery: { ttl_seconds: ttl, collapse_key: collapse },
    ...(flags.reply
      ? {
          reply: {
            expires_in_seconds: flags.replyWindow ?? 86400,
            ...(choices !== null ? { kind: 'choice' as const, choices } : {}),
          },
        }
      : {}),
    ...(Object.keys(options).length > 0
      ? platform === 'ios'
        ? { platform: { ios: options } }
        : { platform: { macos: options } }
      : {}),
  }
  return { ok: true, draft, platform }
}

function resolvePlatform(value: string | undefined): Platform | null {
  if (value === undefined) return 'ios'
  return (PLATFORMS as readonly string[]).includes(value) ? (value as Platform) : null
}

/** Human one-screen receipt summary; agents use --json instead. */
export function formatReceipt(receipt: SubmissionReceipt): string {
  const lines: string[] = []
  const overall =
    receipt.overall === 'provider_accepted_all'
      ? 'accepted by the push provider for every device'
      : receipt.overall === 'provider_accepted_partial'
        ? 'accepted for some devices'
        : receipt.overall === 'provider_rejected_all'
          ? 'rejected for every device'
          : 'still in flight'
  lines.push(`request ${receipt.request_id}${receipt.replayed ? ' (replayed)' : ''}: ${overall}`)
  for (const d of receipt.deliveries) {
    const detail = d.provider_reason ? ` (${d.provider_reason})` : ''
    lines.push(`  ${d.device_name}: ${d.state}${detail}`)
  }
  for (const w of receipt.warnings) lines.push(`  warning ${w.path}: ${w.message}`)
  return lines.join('\n')
}

/** Stable exit codes: 0 ok/pending, 1 rejected everywhere. */
export function receiptExitCode(receipt: SubmissionReceipt): number {
  return receipt.overall === 'provider_rejected_all' ? 1 : 0
}

/**
 * `"Staging,Production"` -> `[{id:'staging',label:'Staging'}, ...]`.
 *
 * A single occurrence splits on commas, which keeps the common one-liner
 * short. Repeating the flag is the escape hatch, and the only way to write a
 * label that itself contains a comma: passing `"Yes, ship it,No"` as one value
 * silently yields three choices, and nothing downstream can detect that the
 * agent meant two.
 */
export function parseChoices(
  value: string | string[] | undefined,
): { id: string; label: string }[] | null | 'invalid' {
  if (value === undefined) return null
  const raw = Array.isArray(value) ? value : [value]
  if (raw.length === 0) return null
  const labels = (raw.length === 1 ? (raw[0] ?? '').split(',') : raw)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (labels.length < 2 || labels.length > 6) return 'invalid'
  const choices = labels.map((label) => ({ id: slugify(label), label }))
  if (choices.some((choice) => choice.id === '')) return 'invalid'
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return 'invalid'
  return choices
}

/** Message shared by every surface that accepts choice labels. */
export const CHOICE_USAGE =
  'Choices must be 2-6 non-empty labels, unique once slugified. One value splits on ' +
  'commas ("Staging,Production"); repeat the flag when a label contains a comma.'

/**
 * Catches the split that looked like it worked.
 *
 * `--choice "macOS parity,Long-form detail,Nothing, I'll review"` produced four
 * buttons rather than three, because the third label contained a comma. Nothing
 * downstream can detect it — the labels are all well-formed — and the CLI
 * cheerfully echoed the wrong list back, so the user saw buttons the agent
 * never intended.
 *
 * The tell is a comma followed by a space. A delimiter list is written
 * "Yes,No"; prose is written "Nothing, I'll review". That is a heuristic and it
 * will occasionally be wrong, which is exactly why this warns and names the
 * escape hatch rather than rejecting: the split may well have been intended.
 */
export function ambiguousChoiceSplit(value: string | string[] | undefined): string | null {
  if (value === undefined || Array.isArray(value)) return null
  if (!/,\s/.test(value)) return null
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return (
    `Heads up: "${value}" was split on commas into ${parts.length} answers ` +
    `(${parts.join(' / ')}). If one of those labels was meant to contain a comma, ` +
    'pass --choice once per answer instead.'
  )
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}
