import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  CAPABILITIES_V1,
  REPLY_MAX_WINDOW_SECONDS,
  validateDraft,
  type ListRepliesResponse,
  type Platform,
  type ReplyView,
} from '@notifai/protocol'
import { sha256Hex } from '@notifai/protocol/node'
import {
  ApiCallError,
  NetworkError,
  createClient,
  type ApiClient,
  type ClientOptions,
} from './client.js'
import {
  BOOLEAN_CONFIG_KEYS,
  CONFIG_KEYS,
  NUMERIC_CONFIG_KEYS,
  findProjectConfigPath,
  findProjectLocalConfigPath,
  globalConfigPath,
  loadConfig,
  sessionConfigPath,
  type CliConfig,
  type ConfigKey,
  type FlagOverrides,
} from './config.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import {
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
  pruneAbandonedSessions,
  readProjectSession,
  registerQuestion,
  type HookContext,
  type HookEnvelope,
} from './hooks.js'
import { readIdleSeconds } from './idle.js'
import {
  HARNESSES,
  applyPlan,
  buildCursorHookConfig,
  buildHookConfig,
  codexConfigPath,
  codexLayerDir,
  codexProjectRoot,
  codexTrustKey,
  detectHarness,
  findInstallations,
  handlerEvent,
  loadCursorSettings,
  loadSettings,
  mergeCursorHooks,
  mergeHooks,
  removeCursorHooks,
  removeHooks,
  settingsFile,
  type Harness,
  type Installation,
} from './install-hooks.js'
import {
  isOurOpencodePlugin,
  opencodePluginSource,
} from './opencode-plugin.js'
import {
  CHOICE_USAGE,
  ambiguousChoiceSplit,
  buildDraft,
  formatReceipt,
  parseChoices,
  receiptExitCode,
  type SendFlags,
} from './send.js'

export interface CommandIo {
  out(line: string): void
  err(line: string): void
  /** Interactive confirmation; resolves `fallback` (default false) when not interactive. */
  confirm(question: string, fallback?: boolean): Promise<boolean>
  openUrl(url: string): void
  /**
   * True only when a human is demonstrably driving a terminal. Everything below
   * is optional sugar that MUST only be called behind this flag: an agent that
   * reaches an interactive prompt does not error, it hangs — the prompt
   * libraries wait on stdin for ever — so the gate is bypass, not handling.
   * Test fakes leave all of this undefined and exercise the plain paths.
   */
  interactive?: boolean
  select?(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string | null>
  intro?(title: string): Promise<void>
  outro?(message: string): Promise<void>
  note?(message: string, title?: string): Promise<void>
  spinner?(message: string): Promise<CommandSpinner | null>
  check?(ok: boolean, message: string): Promise<void>
}

export interface CommandSpinner {
  message(message: string): void
  stop(message: string): void
  error(message: string): void
}

export interface CommandDeps {
  io: CommandIo
  store: CredentialStore
  env: NodeJS.ProcessEnv
  cwd: string
  /** Test seam; production uses fetch against base_url. */
  clientFactory?: (baseUrl: string, bearer: string | null, options?: ClientOptions) => ApiClient
  /** Test seam for bounded polling without wall-clock sleeps. */
  now?: () => number
  /** Test seam for retry/backoff timing. */
  sleep?: (milliseconds: number) => Promise<void>
  /** Test seam for the OS idle probe; production shells out to the platform. */
  idleSeconds?: () => number | null
}

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  noReply: 3,
  auth: 4,
  network: 5,
} as const

function makeClient(
  deps: CommandDeps,
  baseUrl: string,
  bearer: string | null,
  options?: ClientOptions,
): ApiClient {
  return (deps.clientFactory ?? createClient)(baseUrl, bearer, options)
}

function resolvedBaseUrl(config: CliConfig, credential: MachineCredential | null): string {
  return config.base_url.source === 'default' && credential ? credential.baseUrl : config.base_url.value
}

function authedClient(deps: CommandDeps, config: CliConfig): { client: ApiClient; baseUrl: string } | null {
  const credential = deps.store.load()
  if (!credential) {
    deps.io.err('Not signed in. Run `notifai login` first.')
    return null
  }
  const baseUrl = resolvedBaseUrl(config, credential)
  return {
    client: makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`),
    baseUrl,
  }
}

function reportError(deps: CommandDeps, err: unknown): number {
  if (err instanceof ApiCallError) {
    deps.io.err(`${err.code}: ${err.message}`)
    if (err.nextAction) deps.io.err(`next: ${err.nextAction}`)
    if (err.code === 'auth_required' || err.code === 'machine_revoked') return EXIT.auth
    return err.status >= 500 ? EXIT.network : EXIT.failed
  }
  if (err instanceof NetworkError) {
    deps.io.err(err.message)
    return EXIT.network
  }
  deps.io.err(String(err))
  return EXIT.failed
}

// ---------------------------------------------------------------------------
// login / logout / auth status
// ---------------------------------------------------------------------------

export async function loginCommand(
  deps: CommandDeps,
  flags: { name?: string; baseUrl?: string; open?: boolean },
): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env, flags: { base_url: flags.baseUrl } as FlagOverrides })
  const baseUrl = config.base_url.value
  const machineName = flags.name ?? os.hostname()
  const secret = randomBytes(32).toString('base64url')
  const pollVerifier = randomBytes(24).toString('base64url')
  const client = makeClient(deps, baseUrl, null)

  let begin
  try {
    begin = await client.beginPairing({
      machine_name: machineName,
      credential_hash: sha256Hex(secret),
      poll_verifier_hash: sha256Hex(pollVerifier),
    })
  } catch (err) {
    return reportError(deps, err)
  }

  const interactive = deps.io.interactive === true
  if (interactive) {
    await deps.io.intro?.('NotifAI sign in')
    await deps.io.note?.(`Code: ${begin.code}\n${begin.approve_url}`, 'Approve this machine')
  } else {
    deps.io.out(`Pairing code: ${begin.code}`)
    deps.io.out(`Approve this machine at: ${begin.approve_url}`)
    deps.io.out('Waiting for approval…')
  }
  if (flags.open !== false) deps.io.openUrl(begin.approve_url)

  const expiresAt = new Date(begin.expires_at).getTime()
  const intervalMs = Math.max(begin.poll_interval_seconds, 1) * 1000
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spinner = interactive ? await deps.io.spinner?.('Waiting for approval…') : null
  while (now() < expiresAt) {
    await sleep(intervalMs)
    let poll
    try {
      poll = await client.pollPairing(begin.pairing_id, pollVerifier)
    } catch (err) {
      if (err instanceof NetworkError) {
        spinner?.message('Connection lost — retrying…')
        continue
      }
      spinner?.error('Pairing failed')
      return reportError(deps, err)
    }
    if (poll.status === 'approved' && poll.machine_id) {
      deps.store.save({ machineId: poll.machine_id, secret, baseUrl, machineName })
      if (interactive) {
        spinner?.stop(`Machine "${machineName}" approved`)
        await deps.io.outro?.(`Credential stored in ${deps.store.describe()}`)
      } else {
        deps.io.out(`Machine "${machineName}" approved. Credential stored in ${deps.store.describe()}.`)
      }
      return EXIT.ok
    }
    if (poll.status === 'denied') {
      spinner?.error('Pairing denied')
      deps.io.err('Pairing was denied from the dashboard.')
      return EXIT.auth
    }
    if (poll.status === 'expired') break
    spinner?.message('Waiting for approval…')
  }
  spinner?.error('Pairing expired')
  deps.io.err('Pairing expired before it was approved. Run `notifai login` again.')
  return EXIT.auth
}

export function logoutCommand(deps: CommandDeps): number {
  deps.store.clear()
  deps.io.out('Machine credential removed. Revoke it in the dashboard too if the machine is untrusted.')
  return EXIT.ok
}

export function authStatusCommand(deps: CommandDeps, flags: { json?: boolean }): number {
  const credential = deps.store.load()
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        credential
          ? {
              signed_in: true,
              machine_id: credential.machineId,
              machine_name: credential.machineName,
              base_url: credential.baseUrl,
              store: deps.store.describe(),
            }
          : { signed_in: false },
        null,
        2,
      ),
    )
    return credential ? EXIT.ok : EXIT.auth
  }
  if (!credential) {
    deps.io.err('Not signed in. Run `notifai login`.')
    return EXIT.auth
  }
  deps.io.out(`Signed in as machine "${credential.machineName}" (${credential.machineId})`)
  deps.io.out(`Server: ${credential.baseUrl}`)
  deps.io.out(`Credential store: ${deps.store.describe()}`)
  return EXIT.ok
}

// ---------------------------------------------------------------------------
// devices / capabilities
// ---------------------------------------------------------------------------

export async function devicesCommand(deps: CommandDeps, flags: { json?: boolean }): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await authed.client.listDevices()
    if (flags.json) {
      deps.io.out(JSON.stringify(result, null, 2))
      return EXIT.ok
    }
    if (result.devices.length === 0) {
      deps.io.out('No devices. Install a NotifAI companion app on a device and sign in.')
      return EXIT.ok
    }
    for (const d of result.devices) {
      deps.io.out(
        `${d.device_id}  ${d.display_name}  ${d.platform}  ${d.registration_healthy ? 'ready' : 'not ready'} (permission: ${d.permission_status})`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

export async function capabilitiesCommand(
  deps: CommandDeps,
  flags: { json?: boolean; platform?: Platform },
): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const credential = deps.store.load()
  const baseUrl = resolvedBaseUrl(config, credential)
  const client = makeClient(deps, baseUrl, null)
  try {
    const doc = await client.capabilities(flags.platform ?? 'ios')
    if (flags.json) {
      deps.io.out(JSON.stringify(doc, null, 2))
      return EXIT.ok
    }
    deps.io.out(`${doc.platform} capability contract v${doc.schema_version} (payload limit ${doc.payload_limit_bytes} bytes)`)
    for (const field of doc.fields) {
      deps.io.out(`  ${field.path}: ${field.status}${field.reason ? ` — ${field.reason}` : ''}`)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

// ---------------------------------------------------------------------------
// send / status
// ---------------------------------------------------------------------------

export async function sendCommand(
  deps: CommandDeps,
  flags: SendFlags & {
    json?: boolean
    wait?: number
    noWait?: boolean
    replyTimeout?: number
    noBlock?: boolean
    idempotencyKey?: string
    baseUrl?: string
  },
): Promise<number> {
  if (!flags.reply && (flags.replyTimeout !== undefined || flags.replyWindow !== undefined || flags.noBlock)) {
    deps.io.err('Use --reply with --reply-timeout, --reply-window, or --no-block.')
    return EXIT.usage
  }
  const replyTimeout = flags.noBlock ? 0 : (flags.replyTimeout ?? 900)
  if (flags.reply && !isNonNegativeInteger(replyTimeout)) {
    deps.io.err('--reply-timeout must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  if (
    flags.reply &&
    flags.replyWindow !== undefined &&
    (!Number.isInteger(flags.replyWindow) ||
      flags.replyWindow < 60 ||
      flags.replyWindow > REPLY_MAX_WINDOW_SECONDS)
  ) {
    deps.io.err(`--reply-window must be an integer from 60 to ${REPLY_MAX_WINDOW_SECONDS} seconds.`)
    return EXIT.usage
  }
  const config = loadConfig({
    cwd: deps.cwd,
    env: deps.env,
    flags: { base_url: flags.baseUrl, wait_seconds: flags.wait } as FlagOverrides,
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  if (flags.image !== undefined && !flags.image.startsWith('med_')) {
    const uploaded = await uploadImage(deps, authed.client, flags.image)
    if (!uploaded.ok) {
      deps.io.err(uploaded.error)
      return uploaded.exit
    }
    flags = { ...flags, image: uploaded.mediaId }
  }
  const build = buildDraft(config, flags)
  if (!build.ok) {
    deps.io.err(build.error)
    return EXIT.usage
  }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (!capabilities) {
    deps.io.err(`No capability contract is available for ${build.platform}.`)
    return EXIT.usage
  }
  const validation = validateDraft(build.draft, capabilities)
  if (!validation.ok) {
    for (const issue of validation.errors) deps.io.err(`${issue.path}: ${issue.message}`)
    return EXIT.usage
  }
  const hasReplyChoice = Array.isArray(flags.replyChoice)
    ? flags.replyChoice.length > 0
    : flags.replyChoice !== undefined
  if (
    !flags.reply &&
    !hasReplyChoice &&
    (flags.title.trim().endsWith('?') || flags.body.trim().endsWith('?'))
  ) {
    deps.io.err(
      'Heads up: this notification ends with a question but has no reply action. Add --reply or --reply-choice so it can be answered from the notification.',
    )
  }
  const waitSeconds = flags.noWait ? 0 : config.wait_seconds.value
  const idempotencyKey = flags.idempotencyKey ?? `cli-${randomBytes(12).toString('base64url')}`
  try {
    const receipt = await authed.client.submit(
      { idempotency_key: idempotencyKey, draft: build.draft },
      waitSeconds,
    )
    const receiptExit = receiptExitCode(receipt)
    if (!flags.json) deps.io.out(formatReceipt(receipt))

    if (!flags.reply || receiptExit !== EXIT.ok || replyTimeout === 0) {
      if (flags.json) {
        deps.io.out(JSON.stringify(flags.reply ? { receipt, replies: [] } : receipt, null, 2))
      }
      return receiptExit
    }

    const result = await waitForReply(authed.client, receipt.request_id, {
      timeoutSeconds: replyTimeout,
      afterSeq: 0,
      now: deps.now,
      sleep: deps.sleep,
    })
    if (flags.json) {
      deps.io.out(
        JSON.stringify(
          { receipt, replies: result.response.replies, degraded: result.degraded },
          null,
          2,
        ),
      )
    } else if (result.response.replies.length > 0) printReplies(deps, result.response.replies)
    else printNoReply(deps, receipt.request_id, result.response.reply_expires_at)
    if (result.degraded) {
      deps.io.err(DEGRADED_WAIT_WARNING)
      return EXIT.network
    }
    return result.timedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

export async function repliesCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { wait?: number; after?: number; json?: boolean },
): Promise<number> {
  const waitSeconds = flags.wait ?? 0
  const afterSeq = flags.after ?? 0
  if (!isNonNegativeInteger(waitSeconds)) {
    deps.io.err('--wait must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  if (!isNonNegativeInteger(afterSeq)) {
    deps.io.err('--after must be a non-negative integer sequence number.')
    return EXIT.usage
  }

  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await waitForReply(authed.client, requestId, {
      timeoutSeconds: waitSeconds,
      afterSeq,
      now: deps.now,
      sleep: deps.sleep,
    })
    if (flags.json) {
      deps.io.out(JSON.stringify({ ...result.response, degraded: result.degraded }, null, 2))
    } else if (result.response.replies.length > 0) printReplies(deps, result.response.replies)
    else printNoReply(deps, requestId, result.response.reply_expires_at)
    if (result.degraded) {
      deps.io.err(DEGRADED_WAIT_WARNING)
      return EXIT.network
    }
    return result.timedOut ? EXIT.noReply : EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

interface ReplyWaitOptions {
  timeoutSeconds: number
  afterSeq: number
  now?: (() => number) | undefined
  sleep?: ((milliseconds: number) => Promise<void>) | undefined
}

interface ReplyWaitResult {
  response: ListRepliesResponse
  timedOut: boolean
  /**
   * The wait ended while polls were failing, so silence is unproven: the user
   * may well have answered and we could not see it (NotifAI-mw6).
   */
  degraded: boolean
}

/** Loop over server-capped long polls until a reply arrives or the caller's deadline passes. */
export async function waitForReply(
  client: ApiClient,
  requestId: string,
  options: ReplyWaitOptions,
): Promise<ReplyWaitResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + options.timeoutSeconds * 1000
  let lastResponse: ListRepliesResponse | null = null
  let lastNetworkError: NetworkError | null = null
  let consecutiveNetworkErrors = 0
  let firstPoll = true

  while (firstPoll || now() < deadline) {
    firstPoll = false
    const remainingMs = Math.max(0, deadline - now())
    const waitSeconds = Math.min(25, Math.floor(remainingMs / 1000))
    try {
      const response = await client.replies(requestId, {
        waitSeconds,
        afterSeq: options.afterSeq,
      })
      lastResponse = response
      lastNetworkError = null
      consecutiveNetworkErrors = 0
      if (response.replies.length > 0) return { response, timedOut: false, degraded: false }

      const pauseMs = Math.min(250, Math.max(0, deadline - now()))
      if (pauseMs > 0) await sleep(pauseMs)
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err
      lastNetworkError = err
      consecutiveNetworkErrors += 1
      const remainingAfterError = Math.max(0, deadline - now())
      if (remainingAfterError === 0) break
      const backoffMs = Math.min(250 * 2 ** (consecutiveNetworkErrors - 1), 2_000, remainingAfterError)
      await sleep(backoffMs)
    }
  }

  if (!lastResponse && lastNetworkError) throw lastNetworkError
  return {
    response:
      lastResponse ??
      ({ request_id: requestId, reply_expires_at: null, replies: [] } satisfies ListRepliesResponse),
    timedOut: true,
    // A poll succeeded at some point, so we do not throw — but the last thing
    // we know is that we could not reach the server. Reporting that as a plain
    // "no reply" would let an agent treat an unseen refusal as consent.
    degraded: lastNetworkError !== null,
  }
}

/**
 * Shared by every surface that waits: "the user did not answer" and "I could
 * not find out" must not look the same, because agents branch on the exit code
 * and one of those two branches is safe to proceed from (NotifAI-mw6).
 */
const DEGRADED_WAIT_WARNING =
  'notifai: the wait ended during a network outage, so this is "could not find out", ' +
  'not "no answer" — the reply may already be waiting. Retry with `notifai replies <id>`.'

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function printReplies(deps: CommandDeps, replies: ReplyView[]): void {
  for (const reply of replies) deps.io.out(`reply from ${reply.device_name}: ${reply.text}`)
  const contradiction = contradictingAnswer(replies)
  if (contradiction !== null) deps.io.err(contradiction)
}

/**
 * The other half of first-reply-wins (D-058).
 *
 * A blocking send returns the first non-empty batch and acts on it, so a later
 * answer that disagrees is silently ignored. That is the right default — an
 * agent wants one answer, not a quorum — but silently is the wrong way to do
 * it. The server now retires the question on the other devices the moment one
 * answers, which makes this rare; it is still reachable, because a device can
 * answer between the first reply landing and its retirement arriving.
 *
 * Ordered by seq, so `replies[0]` is the one that won.
 */
export function contradictingAnswer(replies: ReplyView[]): string | null {
  const winner = replies[0]
  if (winner === undefined || replies.length < 2) return null
  const disagreeing = replies
    .slice(1)
    .filter((reply) => (reply.choice_id ?? reply.text) !== (winner.choice_id ?? winner.text))
  if (disagreeing.length === 0) return null
  const names = [...new Set(disagreeing.map((reply) => reply.device_name))].join(', ')
  return (
    `note: "${winner.text}" from ${winner.device_name} is the answer that counts — it arrived first. ` +
    `${names} answered differently afterwards and that answer was not used.`
  )
}

function printNoReply(deps: CommandDeps, requestId: string, expiresAt?: string | null): void {
  // A harness hook may have retired this question, in which case promising an
  // open window would send the caller back to wait for an answer the server
  // will now refuse.
  const closed = expiresAt != null && Date.parse(expiresAt) <= Date.now()
  deps.io.out(
    closed
      ? `no reply for request ${requestId}; the reply window has closed`
      : `no reply yet for request ${requestId}; the reply window remains open`,
  )
}

export async function statusCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const snapshot = await authed.client.evidence(requestId)
    if (flags.json) {
      deps.io.out(JSON.stringify(snapshot, null, 2))
      return EXIT.ok
    }
    deps.io.out(`request ${snapshot.request_id} (${snapshot.event ?? 'no event'}) — ${snapshot.overall}`)
    for (const d of snapshot.deliveries) {
      deps.io.out(`  ${d.device_name}: ${d.state} after ${d.attempts} attempt(s)`)
      for (const e of d.events) {
        deps.io.out(`    ${e.occurred_at}  ${e.stage}${e.reason ? ` (${e.reason})` : ''}`)
      }
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

const MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

type UploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; error: string; exit: number }

/** `--image` accepts a media id, a local file path, or an http(s) URL. */
async function uploadImage(deps: CommandDeps, client: ApiClient, source: string): Promise<UploadResult> {
  let bytes: Uint8Array
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | undefined
  if (/^https?:\/\//.test(source)) {
    try {
      const response = await fetch(source)
      if (!response.ok) return { ok: false, error: `Could not fetch ${source} (${response.status}).`, exit: EXIT.usage }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      mediaType = (['image/jpeg', 'image/png', 'image/gif'] as const).find((t) => t === contentType)
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (err) {
      return { ok: false, error: `Could not fetch ${source}: ${String(err)}`, exit: EXIT.network }
    }
  } else {
    if (!existsSync(source)) {
      return { ok: false, error: `--image: "${source}" is not a media id, file, or URL.`, exit: EXIT.usage }
    }
    bytes = new Uint8Array(readFileSync(source))
    mediaType = MEDIA_TYPES[path.extname(source).toLowerCase()]
  }
  if (!mediaType) {
    return { ok: false, error: 'Images must be JPEG, PNG, or GIF.', exit: EXIT.usage }
  }
  try {
    const grant = await client.createMediaUpload({
      media_type: mediaType,
      size_bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
    await client.uploadMedia(grant, bytes)
    return { ok: true, mediaId: grant.media_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), exit: EXIT.network }
  }
}

// ---------------------------------------------------------------------------
// hook / ask / close — harness integration
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = ['user-prompt-submit', 'stop', 'session-end'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * Runs one harness hook. Contract with every harness: hook JSON arrives on
 * stdin, the decision (if any) goes to stdout, diagnostics go to stderr, and
 * exit 0 with no stdout means "no decision — carry on as normal".
 *
 * Every failure path in here must reach that no-decision state. A hook that
 * throws, or that blocks past the harness's timeout, degrades the agent for a
 * feature the user only asked to make it more convenient.
 */
export async function hookRunCommand(
  deps: CommandDeps,
  event: string,
  readStdin: () => Promise<string>,
  harness?: 'cursor',
): Promise<number> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    deps.io.err(`Unknown hook event "${event}". Valid: ${HOOK_EVENTS.join(', ')}`)
    return EXIT.usage
  }
  let envelope: HookEnvelope
  try {
    envelope = parseHookInput(await readStdin())
    if (harness === 'cursor') {
      const sessionId = envelope.session_id ?? envelope.conversation_id
      const cwd = envelope.cwd ?? envelope.workspace_roots?.[0]
      envelope = {
        ...envelope,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(cwd === undefined ? {} : { cwd }),
        stop_hook_active:
          envelope.stop_hook_active ??
          (typeof envelope.loop_count === 'number' && envelope.loop_count > 0),
      }
    }
  } catch {
    return EXIT.ok
  }

  // Everything below is inside one fail-open boundary. Config parsing,
  // credential loading and client construction can all throw, and a hook that
  // exits non-zero makes the harness report a failure — strictly worse for the
  // user than not having installed the hook at all.
  try {
    if (event === 'session-end') {
      const outcome = handleSessionEnd(deps.env, envelope, (deps.now ?? Date.now)())
      for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
      return EXIT.ok
    }

    // Resolve config against the session's project rather than our own working
    // directory. `cwd` is in the payload precisely because which project a
    // session belongs to is the harness's business, not ours.
    const cwd = envelope.cwd ?? deps.cwd
    const config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
    const credential = deps.store.load()
    if (!credential) return EXIT.ok
    // Pin authenticated traffic to the origin the credential was issued for. A
    // repository can commit `.notifai/config.toml`, and honouring a base_url
    // from it would hand this machine's bearer token to whatever host it names.
    const baseUrl = credential.baseUrl
    if (config.base_url.source !== 'default' && config.base_url.value !== baseUrl) {
      deps.io.err(
        `notifai: ignoring base_url from ${config.base_url.source}; hooks only talk to ${baseUrl}`,
      )
    }
    // UserPromptSubmit runs in front of the user's own prompt under a 15s
    // harness ceiling and can make two calls, so each gets a small slice of it;
    // Stop is allowed to block and keeps the ordinary budget (NotifAI-tcn).
    const client = makeClient(
      deps,
      baseUrl,
      `Bearer nfm_${credential.machineId}.${credential.secret}`,
      { timeoutMs: event === 'user-prompt-submit' ? 4_000 : 20_000 },
    )
    const now = deps.now ?? Date.now
    const ctx: HookContext = {
      client,
      config,
      env: deps.env,
      now,
      idleSeconds: deps.idleSeconds ?? (() => readIdleSeconds()),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForFirstReply: async (requestId, timeoutSeconds) => {
        const result = await waitForReply(client, requestId, {
          timeoutSeconds,
          afterSeq: 0,
          now: deps.now,
          sleep: deps.sleep,
        })
        return {
          replies: result.response.replies,
          timedOut: result.timedOut,
          degraded: result.degraded,
        }
      },
    }

    // Real clock, deliberately, not `deps.now`. This compares against file
    // mtimes, which are wall-clock facts — handing it a virtual or skewed clock
    // would have it delete live session state as "abandoned".
    // Rate-limited to once a day by its own stamp file, so the common cost is
    // one stat on a hook that sits on the critical path of every turn.
    pruneAbandonedSessions(deps.env)

    const outcome =
      event === 'user-prompt-submit'
        ? await handleUserPromptSubmit(ctx, envelope)
        : await handleStop(ctx, envelope)
    for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
    if (outcome.stdout !== undefined) {
      let stdout = outcome.stdout
      if (harness === 'cursor' && event === 'stop') {
        const decision = JSON.parse(outcome.stdout) as { decision?: unknown; reason?: unknown }
        if (decision.decision === 'block' && typeof decision.reason === 'string') {
          stdout = JSON.stringify({ followup_message: decision.reason })
        }
      }
      deps.io.out(stdout)
    }
    return EXIT.ok
  } catch (err) {
    for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
    return EXIT.ok
  }
}

/**
 * What went wrong, in terms of what to do about it (NotifAI-e74).
 *
 * On 2026-08-03 a contract change shipped without the server deploy that goes
 * with it. The CLI stamped `lifecycle` on every question draft, the deployed
 * server rejected the unknown field, and escalation stopped working entirely —
 * announced as "hook failed, deferring to the terminal", which reads like a
 * flaky network. The information needed to diagnose it in one second was
 * already in hand: a 422 whose details name the offending path. It was being
 * thrown away by `String(err)`.
 *
 * A hook still exits 0 whatever this says. Handing the terminal back is always
 * right; the only question is whether the user is told anything they can use.
 */
export function describeHookFailure(err: unknown): string[] {
  if (!(err instanceof ApiCallError)) {
    return [`hook failed, deferring to the terminal (${String(err)})`]
  }
  const lines = [`hook failed, deferring to the terminal (${err.code}: ${err.message})`]
  const paths = rejectedPaths(err.details)
  if (paths.length > 0) lines.push(`the server rejected: ${paths.join(', ')}`)
  // A 422 on a draft this CLI built is not a user error — this CLI's own
  // contract produced it. Either the server is behind, or the two disagree.
  if (err.status === 422) {
    lines.push(
      'this build sent a field the server did not accept, which usually means the server ' +
        'is older than this CLI — check with `notifai doctor`',
    )
  }
  return lines
}

function rejectedPaths(details: unknown): string[] {
  if (!Array.isArray(details)) return []
  return details
    .map((issue) =>
      typeof issue === 'object' && issue !== null && typeof (issue as { path?: unknown }).path === 'string'
        ? (issue as { path: string }).path
        : null,
    )
    .filter((path): path is string => path !== null && path !== '')
    .slice(0, 5)
}

export interface AskFlags {
  choice?: string | string[]
  session?: string
}

/**
 * Registers a question to be pushed if — and only if — the turn ends with the
 * user away. Returns immediately: the agent asks in prose as it always would,
 * and a user sitting at the terminal answers there with no notification sent.
 */
export function askCommand(deps: CommandDeps, question: string, flags: AskFlags): number {
  // An agent calling this gets no hook payload and no harness exports its
  // session id, so the UserPromptSubmit hook leaves a pointer keyed on the
  // project directory and we read it back here. The pointer outranks the
  // NOTIFAI_SESSION fallback deliberately: the exported id is often a chosen
  // label rather than the harness's own id, and the hooks key state by the
  // latter — the env var is only trusted when no hook has spoken (D-066).
  const now = (deps.now ?? Date.now)()
  const sessionId =
    flags.session ??
    readProjectSession(deps.cwd, deps.env, now) ??
    deps.env['NOTIFAI_SESSION'] ??
    undefined
  if (!sessionId) {
    for (const line of diagnoseMissingSession(deps)) deps.io.err(line)
    return EXIT.usage
  }
  if (question.trim() === '') {
    deps.io.err('The question cannot be empty.')
    return EXIT.usage
  }
  // Validate here, not at push time. The push happens inside a hook, where a
  // rejection becomes a stderr note the agent never reads — so a malformed
  // choice set would look like it registered fine and then silently never ask.
  const choices = parseChoices(flags.choice)
  if (choices === 'invalid') {
    deps.io.err(CHOICE_USAGE)
    return EXIT.usage
  }
  registerQuestion(
    sessionId,
    deps.env,
    {
      question: question.trim(),
      ...(choices !== null ? { choices: choices.map((choice) => choice.label) } : {}),
    },
    (deps.now ?? Date.now)(),
  )
  if (choices !== null) {
    deps.io.out(`Answers offered: ${choices.map((choice) => choice.label).join(' / ')}`)
  }
  // On stdout, not stderr: the agent reads the former and this is only useful
  // if it is read while there is still time to fix the question (NotifAI-65y).
  const ambiguous = ambiguousChoiceSplit(flags.choice)
  if (ambiguous !== null) deps.io.out(ambiguous)
  deps.io.out('Question registered. Ask it in the conversation as usual and end your turn.')
  return EXIT.ok
}

/**
 * Why `ask` cannot see a session, in terms of what to do about it.
 *
 * Only a UserPromptSubmit hook firing produces the pointer this reads, and the
 * old message answered every cause with "run `notifai hooks install` and send
 * one prompt" — which, said to someone who had just run exactly that, was a
 * dead end (NotifAI-91f). The two causes need different actions, and we can
 * tell them apart: hooks on disk but no pointer means they were installed after
 * this session started, and a harness only reads them at session start.
 */
function diagnoseMissingSession(deps: CommandDeps): string[] {
  const installations = findInstallations(deps.cwd, deps.env)
  if (installations.length === 0) {
    return [
      'Could not tell which harness session this is: no NotifAI hooks are installed for this project.',
      'Run `notifai hooks install`, then restart the harness so it loads them.',
    ]
  }
  const where = installations.map((i) => `${i.harness} in ${i.file}`).join(', ')
  return [
    `Could not tell which harness session this is. NotifAI hooks are installed (${where}),`,
    'but none has fired here yet. Harnesses read their hooks once at session start, so a',
    'session that was already running when they were installed never loaded them.',
    'Restart the harness and send one prompt, then this will work.',
    'To ask from this session anyway, pass --session <id>.',
  ]
}

/** Retire a question so a late answer is rejected rather than silently lost. */
export async function closeCommand(deps: CommandDeps, requestId: string): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    await authed.client.closeReplies(requestId)
    deps.io.out(`Closed the reply window for ${requestId}.`)
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

export interface HooksInstallFlags {
  harness?: string
  global?: boolean
  /** Test seam; production resolves the running CLI. */
  execPath?: string
  scriptPath?: string
}

export function hooksInstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const execPath = flags.execPath ?? process.execPath
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const file = settingsFile(harness, flags.global ?? false, deps.cwd, deps.env)

  // OpenCode's adapter is a generated plugin module rather than a handler
  // merged into a settings document, so it owns the whole file (NotifAI-du1).
  if (harness === 'opencode') {
    return installOpencodePlugin(deps, file, {
      execPath,
      scriptPath,
      timeoutSeconds: config.hook_reply_timeout_seconds.value + 60,
    })
  }

  if (harness === 'cursor') {
    let document
    try {
      document = loadCursorSettings(file)
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    const merged = mergeCursorHooks(
      document,
      buildCursorHookConfig({
        execPath,
        scriptPath,
        replyTimeoutSeconds: config.hook_reply_timeout_seconds.value,
        graceSeconds: config.ask_grace_seconds.value,
      }),
      scriptPath,
    )
    try {
      applyPlan(file, merged.document)
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    deps.io.out(`Installed ${harness} hooks in ${file}`)
    if (merged.replaced.length > 0) deps.io.out(`  replaced: ${merged.replaced.join(', ')}`)
    if (merged.added.length > 0) deps.io.out(`  added: ${merged.added.join(', ')}`)
    deps.io.out('Cursor reloads hooks.json automatically. A phone answer is submitted as one')
    deps.io.out('follow-up user message; loop_limit = 1 prevents repeated answer turns.')
    return EXIT.ok
  }

  let document
  try {
    document = loadSettings(file)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  const merged = mergeHooks(
    document,
    buildHookConfig({
      execPath,
      scriptPath,
      replyTimeoutSeconds: config.hook_reply_timeout_seconds.value,
      graceSeconds: config.ask_grace_seconds.value,
    }),
    scriptPath,
  )
  try {
    applyPlan(file, merged.document)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }

  deps.io.out(`Installed ${harness} hooks in ${file}`)
  if (merged.replaced.length > 0) deps.io.out(`  replaced: ${merged.replaced.join(', ')}`)
  if (merged.added.length > 0) deps.io.out(`  added: ${merged.added.join(', ')}`)
  if (merged.removed.length > 0) {
    deps.io.out(`  removed: ${merged.removed.join(', ')} (this build no longer serves them)`)
  }
  deps.io.out('')
  deps.io.out(
    config.require_idle.value
      ? `While you are at the keyboard nothing is pushed. Once the machine has been idle for ` +
          `${config.away_after_seconds.value}s, a question registered with \`notifai ask\` waits ` +
          `${config.ask_grace_seconds.value}s in the terminal and then goes to your devices. ` +
          `Set \`require_idle = false\` to be notified even while you are working.`
      : `A question registered with \`notifai ask\` waits ${config.ask_grace_seconds.value}s in ` +
          `the terminal and then goes to your devices whether or not you are at this machine ` +
          `(\`require_idle = false\`).`,
  )
  if (harness === 'codex') {
    // Verified 2026-08-02: Codex keys each handler by
    // <file>:<event>:<group>:<handler> with a trusted_hash, and silently skips
    // any it has no entry for. `codex exec` reported "UserPromptSubmit
    // Completed" while never running the freshly written handler. Nothing
    // downstream can detect this, so it has to be said here.
    deps.io.out('Codex will not run these until you approve them: it trusts hooks by content')
    deps.io.out('hash, and skips untrusted ones without reporting anything. Start Codex')
    deps.io.out('interactively once and accept the prompt.')
    const layer = flags.global ? null : codexLayerDir(deps.cwd)
    if (layer !== null) {
      // Codex reads project hooks from the main repository but only looks when
      // a `.codex` directory sits at or above cwd, so a worktree install has to
      // write one file and create one directory in two different places. Doing
      // it silently would leave the next person deriving this the hard way
      // (NotifAI-rqx).
      mkdirSync(layer, { recursive: true })
      deps.io.out('')
      deps.io.out('You are in a worktree. Codex reads project hooks from the main repository,')
      deps.io.out(`so they were written to ${file} — covering every worktree of`)
      deps.io.out(`this repo — and ${layer} was created, without which Codex`)
      deps.io.out('does not look for them at all.')
    }
    deps.io.out('Check with `notifai doctor`, which reads the trust table directly.')
  }
  deps.io.out('')
  deps.io.out('Restart the harness for the hooks to take effect: a harness reads its hooks')
  deps.io.out('once at session start, so this session will not run them however long it lasts.')
  return EXIT.ok
}

/**
 * Writes the OpenCode plugin, replacing any NotifAI plugin already there —
 * including one a different checkout wrote, matched on the managed marker for
 * the same reason command hooks are (NotifAI-0vk).
 */
function installOpencodePlugin(
  deps: CommandDeps,
  file: string,
  options: { execPath: string; scriptPath: string; timeoutSeconds: number },
): number {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8')
    if (!isOurOpencodePlugin(existing)) {
      deps.io.err(`${file} exists and was not written by NotifAI; move it aside first.`)
      return EXIT.failed
    }
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, opencodePluginSource(options), { mode: 0o644 })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  deps.io.out(`Installed the OpenCode plugin at ${file}`)
  deps.io.out('')
  deps.io.out('It maps chat.message to presence, session.idle to the question escalation,')
  deps.io.out('and permission.ask to a decision your phone can make. Every decision still')
  deps.io.out('comes from the same `notifai hook` commands the other harnesses run.')
  deps.io.out('')
  deps.io.out('Restart OpenCode: it loads plugins once at start.')
  return EXIT.ok
}

export function hooksUninstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const file = settingsFile(harness, flags.global ?? false, deps.cwd, deps.env)
  if (!existsSync(file)) {
    deps.io.out(`Nothing to remove: ${file} does not exist.`)
    return EXIT.ok
  }
  if (harness === 'opencode') {
    // We own the whole file, but only if we wrote it.
    if (!isOurOpencodePlugin(readFileSync(file, 'utf8'))) {
      deps.io.out(`Left ${file} alone: NotifAI did not write it.`)
      return EXIT.ok
    }
    rmSync(file, { force: true })
    deps.io.out(`Removed the NotifAI OpenCode plugin at ${file}`)
    return EXIT.ok
  }
  if (harness === 'cursor') {
    let document
    try {
      document = loadCursorSettings(file)
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    const stripped = removeCursorHooks(document, scriptPath)
    try {
      applyPlan(file, stripped.document)
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    deps.io.out(
      stripped.replaced.length > 0
        ? `Removed NotifAI hooks (${stripped.replaced.join(', ')}) from ${file}`
        : `No NotifAI hooks found in ${file}`,
    )
    return EXIT.ok
  }
  let document
  try {
    document = loadSettings(file)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  const stripped = removeHooks(document, scriptPath)
  try {
    applyPlan(file, stripped.document)
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  deps.io.out(
    stripped.replaced.length > 0
      ? `Removed NotifAI hooks (${stripped.replaced.join(', ')}) from ${file}`
      : `No NotifAI hooks found in ${file}`,
  )
  return EXIT.ok
}

function resolveHarness(deps: CommandDeps, requested: string | undefined): Harness | null {
  if (requested !== undefined) {
    if ((HARNESSES as readonly string[]).includes(requested)) return requested as Harness
    deps.io.err(
      `Unknown harness "${requested}". Supported: ${HARNESSES.join(', ')}.`,
    )
    return null
  }
  const detected = detectHarness(deps.cwd)
  if (!detected) {
    deps.io.err(`Could not tell which harness to install for — pass --harness <${HARNESSES.join('|')}>.`)
    return null
  }
  return detected
}

// ---------------------------------------------------------------------------
// config show / set
// ---------------------------------------------------------------------------

export function configShowCommand(
  deps: CommandDeps,
  flags: { json?: boolean; explain?: boolean },
): number {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  if (flags.json) {
    const output = Object.fromEntries(
      CONFIG_KEYS.map((key) => [key, { value: config[key].value, source: config[key].source }]),
    )
    deps.io.out(JSON.stringify(output, null, 2))
    return EXIT.ok
  }
  for (const key of CONFIG_KEYS) {
    const entry = config[key]
    const provenance = flags.explain ? `  [${entry.source}]` : ''
    deps.io.out(`${key} = ${JSON.stringify(entry.value)}${provenance}`)
  }
  return EXIT.ok
}

export async function configSetCommand(
  deps: CommandDeps,
  key: string,
  rawValue: string,
  flags: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
): Promise<number> {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    deps.io.err(`Unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`)
    return EXIT.usage
  }
  let value: unknown = rawValue
  if (NUMERIC_CONFIG_KEYS.includes(key as ConfigKey)) {
    value = Number(rawValue)
    if (!Number.isFinite(value)) {
      deps.io.err(`"${rawValue}" is not a number.`)
      return EXIT.usage
    }
  }
  if (BOOLEAN_CONFIG_KEYS.includes(key as ConfigKey)) {
    if (rawValue !== 'true' && rawValue !== 'false') {
      deps.io.err(`${key} is a toggle — pass "true" or "false", not "${rawValue}".`)
      return EXIT.usage
    }
    value = rawValue === 'true'
  }
  if (key === 'devices') value = rawValue.split(',').map((s) => s.trim()).filter(Boolean)

  let layer = flags.local ? 'local' : flags.project ? 'project' : 'global'
  if (
    flags.session === undefined &&
    flags.local !== true &&
    flags.project !== true &&
    flags.yes !== true &&
    deps.io.interactive === true &&
    deps.io.select
  ) {
    const selected = await deps.io.select('Where should this setting live?', [
      { value: 'global', label: 'This machine', hint: 'applies across projects' },
      { value: 'project', label: 'This project (shared)', hint: '.notifai/config.toml' },
      { value: 'local', label: 'This project (local)', hint: 'gitignored' },
    ])
    if (selected === null) {
      deps.io.err('No configuration layer selected.')
      return EXIT.usage
    }
    layer = selected
  }

  const targetPath = flags.session
    ? sessionConfigPath(flags.session, deps.env)
    : layer === 'local'
      ? (findProjectLocalConfigPath(deps.cwd) ?? path.join(deps.cwd, '.notifai', 'config.local.toml'))
      : layer === 'project'
        ? (findProjectConfigPath(deps.cwd) ?? path.join(deps.cwd, '.notifai', 'config.toml'))
        : globalConfigPath(deps.env)

  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Set ${key} = ${JSON.stringify(value)} in ${targetPath}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  const existing = existsSync(targetPath)
    ? (parseToml(readFileSync(targetPath, 'utf8')) as Record<string, unknown>)
    : {}
  existing[key] = value
  mkdirSync(path.dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, `${stringifyToml(existing)}\n`)
  deps.io.out(`Wrote ${key} to ${targetPath}`)
  return EXIT.ok
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Where `npx skills add` fetches the optional agent skill from. The skill's
 * canonical home is the public repository (RafaelVidaurre/notifai), which has
 * nothing pushed to it yet, so no source can resolve today; the guard below
 * keeps `--skills` from installing anything until a tagged release exists to
 * pin this to. Never point this at the private repository — the installer
 * command is printed to users, and only public sources belong in it.
 */
const SKILLS_SOURCE = ''

/** Derive a contract-valid project slug from a directory name. */
export function projectSlugFrom(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, '')
    .slice(0, 64)
  return slug.length > 0 && /^[a-z0-9]/.test(slug) ? slug : 'project'
}

export interface InitFlags {
  projectId?: string
  /**
   * Install the agent guidance skill. Tri-state on purpose (NotifAI-chu.2):
   * true installs, false skips silently, and undefined means "offer it when a
   * human is present, do nothing when one is not" — an unattended run must
   * never spawn npx against the network by default.
   */
  skills?: boolean
  /** Same tri-state, for the harness hooks. */
  hooks?: boolean
}

/**
 * The one command that takes a project from nothing to working (D-064).
 *
 * Idempotent by construction: every step first observes, then acts only on the
 * gap, so re-running is how you check the setup as much as how you create it.
 * With a human at a terminal it walks them through the missing pieces; run by
 * an agent it never prompts — each optional step is answered by a flag, and
 * whatever only the user can do (signing in, pairing a phone) is printed as
 * the exact command to hand back to them.
 */
export async function initCommand(deps: CommandDeps, flags: InitFlags): Promise<number> {
  const interactive = deps.io.interactive === true
  await deps.io.intro?.('NotifAI setup')
  /** Steps only the user can perform, phrased as the command to run. */
  const remaining: string[] = []
  let failed = false

  // -- Project identity ------------------------------------------------------
  const configPath = path.join(deps.cwd, '.notifai', 'config.toml')
  const existing = existsSync(configPath)
    ? (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {}
  const project = flags.projectId ?? (typeof existing['project'] === 'string' ? existing['project'] : null)
  const slug = projectSlugFrom(project ?? path.basename(deps.cwd))
  if (existing['project'] !== slug) {
    existing['project'] = slug
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${stringifyToml(existing)}\n`)
    deps.io.out(`Wrote project = "${slug}" to ${configPath}`)
  } else {
    deps.io.out(`Project already configured as "${slug}" in ${configPath}`)
  }

  // -- Credential ------------------------------------------------------------
  let credential = deps.store.load()
  if (credential) {
    deps.io.out(`Signed in as machine "${credential.machineName}" (${deps.store.describe()})`)
  } else if (interactive && (await deps.io.confirm('Sign in now? (opens your browser)', true))) {
    if ((await loginCommand(deps, {})) === EXIT.ok) credential = deps.store.load()
    else remaining.push('sign in: notifai login')
  } else {
    remaining.push('sign in: notifai login')
  }

  // -- Agent guidance skill --------------------------------------------------
  const wantSkill =
    SKILLS_SOURCE !== '' &&
    (flags.skills ??
      (interactive
        ? await deps.io.confirm('Install/update the agent guidance skill in this repo?', true)
        : false))
  if (SKILLS_SOURCE === '' && flags.skills === true) {
    failed = true
    deps.io.err('The optional agent skill is not published yet; this build has no skill source configured.')
  }
  if (wantSkill) {
    deps.io.out(`Installing the notifai agent skill (npx skills add ${SKILLS_SOURCE})...`)
    const code = await new Promise<number>((resolve) => {
      const child = spawn('npx', ['-y', 'skills', 'add', SKILLS_SOURCE, '--skill', 'notifai'], {
        cwd: deps.cwd,
        stdio: 'inherit',
      })
      child.on('error', () => resolve(1))
      child.on('exit', (exitCode) => resolve(exitCode ?? 1))
    })
    if (code === 0) {
      deps.io.out('Agent skill installed. Agents in this project can follow it.')
    } else {
      failed = true
      deps.io.err('Skill installation failed — run it manually with:')
      deps.io.err(`  npx skills add ${SKILLS_SOURCE} --skill notifai`)
    }
  } else if (flags.skills === undefined && !interactive) {
    deps.io.out('Agent skill not installed (optional) — add it with: notifai init --skills')
  }

  // -- Harness hooks ---------------------------------------------------------
  const installations = findInstallations(deps.cwd, deps.env)
  if (installations.length > 0) {
    deps.io.out(
      `Hooks installed: ${installations
        .map((i) => `${i.harness} ${i.global ? 'global' : 'project'}`)
        .join(', ')}`,
    )
  } else {
    const wantHooks =
      flags.hooks ??
      (interactive
        ? await deps.io.confirm(
            'Install harness hooks, so questions reach your devices when you are away?',
            true,
          )
        : false)
    if (wantHooks) {
      let harness = detectHarness(deps.cwd)
      if (harness === null && interactive && deps.io.select) {
        const picked = await deps.io.select(
          'Which agent harness do you use here?',
          HARNESSES.map((name) => ({ value: name, label: name })),
        )
        if (picked !== null) harness = picked as Harness
      }
      if (harness === null) {
        failed = true
        deps.io.err(
          `Could not tell which harness to wire. Run: notifai hooks install --harness <${HARNESSES.join('|')}>`,
        )
      } else if (hooksInstallCommand(deps, { harness }) !== EXIT.ok) {
        failed = true
      }
    } else if (flags.hooks === undefined && !interactive) {
      deps.io.out('Hooks not installed (optional) — add question routing with: notifai hooks install')
    }
  }

  // -- Devices, when we can ask the server -----------------------------------
  if (credential) {
    try {
      const config = loadConfig({ cwd: deps.cwd, env: deps.env })
      const authed = authedClient(deps, config)
      if (authed) {
        const { devices } = await authed.client.listDevices()
        const ready = devices.filter((d) => d.registration_healthy)
        if (ready.length > 0) {
          deps.io.out(`${ready.length} device(s) ready to receive notifications`)
        } else {
          remaining.push('pair a device: install a companion app, sign in, allow notifications')
        }
      }
    } catch {
      deps.io.out('Could not reach the server to check devices — `notifai doctor` when back online.')
    }
  }

  // -- Verdict ---------------------------------------------------------------
  if (remaining.length === 0 && !failed) {
    deps.io.out('All set. Agents in this project can notify you and ask questions.')
    await deps.io.outro?.('All set ✨')
  } else {
    for (const step of remaining) deps.io.out(`Still needed — ${step}`)
    await deps.io.outro?.('Some steps remain (listed above)')
  }
  return failed ? EXIT.failed : EXIT.ok
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Whether the deployed server understands the contract this build speaks
 * (NotifAI-e74).
 *
 * Every test in the suite runs the CLI and the server from the same commit, so
 * a client sending a field the deployed server has not learned yet is
 * structurally invisible to it. That gap shipped a silent production outage on
 * 2026-08-03: questions stopped reaching devices entirely and nothing said so.
 *
 * The capability document already carries a schema version and is served
 * unauthenticated, so a single GET answers the question. This does not claim to
 * catch every skew — an additive field inside the same schema version would
 * still pass — but it catches the one that has actually happened, and it names
 * the remedy rather than leaving someone to derive it.
 */
async function contractCheck(client: ApiClient): Promise<{ name: string; ok: boolean; detail: string }> {
  const local = CAPABILITIES_V1.describe('ios')?.schema_version
  try {
    const remote = (await client.capabilities('ios')).schema_version
    if (local === remote) {
      return { name: 'contract', ok: true, detail: `server and CLI both speak schema v${remote}` }
    }
    return {
      name: 'contract',
      ok: false,
      detail:
        local !== undefined && remote < local
          ? `server speaks schema v${remote}, this CLI speaks v${local} — the server needs deploying, ` +
            'until then sends carrying newer fields are rejected'
          : `server speaks schema v${remote}, this CLI speaks v${local} — update the CLI`,
    }
  } catch (err) {
    return {
      name: 'contract',
      ok: false,
      detail: `could not read the server capability document (${err instanceof ApiCallError ? err.code : String(err)})`,
    }
  }
}

export async function doctorCommand(deps: CommandDeps, flags: { json?: boolean }): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const checks: { name: string; ok: boolean; detail: string }[] = []

  const credential = deps.store.load()
  checks.push({
    name: 'credential',
    ok: credential !== null,
    detail: credential ? `stored in ${deps.store.describe()}` : 'missing — run `notifai login`',
  })

  const baseUrl = resolvedBaseUrl(config, credential)
  checks.push({ name: 'config', ok: true, detail: `server ${baseUrl} (${config.base_url.source})` })

  const anon = makeClient(deps, baseUrl, null)
  const reachable = await anon.health()
  checks.push({
    name: 'server',
    ok: reachable,
    detail: reachable ? 'reachable' : `cannot reach ${baseUrl}`,
  })

  if (reachable) checks.push(await contractCheck(anon))

  if (credential && reachable) {
    const client = makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
    try {
      const devices = await client.listDevices()
      const ready = devices.devices.filter((d) => d.registration_healthy)
      checks.push({ name: 'auth', ok: true, detail: `machine ${credential.machineId} accepted` })
      checks.push({
        name: 'devices',
        ok: ready.length > 0,
        detail:
          ready.length > 0
            ? `${ready.length} device(s) ready`
            : 'no device ready — install a companion app, sign in, allow notifications',
      })
    } catch (err) {
      checks.push({
        name: 'auth',
        ok: false,
        detail: err instanceof ApiCallError ? `${err.code}: ${err.message}` : String(err),
      })
    }
  }

  checks.push(...hookChecks(deps))

  const allOk = checks.every((c) => c.ok)
  if (flags.json) {
    deps.io.out(JSON.stringify({ ok: allOk, checks }, null, 2))
  } else if (deps.io.interactive === true && deps.io.check) {
    await deps.io.intro?.('NotifAI doctor')
    for (const c of checks) await deps.io.check(c.ok, `${c.name}: ${c.detail}`)
    await deps.io.outro?.(allOk ? 'Everything looks good' : 'Some checks need attention')
  } else {
    for (const c of checks) deps.io.out(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`)
  }
  return allOk ? EXIT.ok : EXIT.failed
}

/**
 * Whether the hooks will actually run — answerable without a live test.
 *
 * Every failure mode here was found the expensive way, by spawning a session
 * and watching nothing happen: hooks not installed, installed but never loaded
 * because the harness was not restarted (NotifAI-91f), installed but silently
 * skipped by Codex for want of trust (NotifAI-gup), or left behind by an older
 * build that named events this one does not serve (NotifAI-inb).
 */
function hookChecks(deps: CommandDeps): { name: string; ok: boolean; detail: string }[] {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const installations = findInstallations(deps.cwd, deps.env)

  // Not having hooks is a setup someone chose, not a fault: `send` works
  // without them. A setup that cannot work is what deserves to go red.
  if (installations.length === 0) {
    checks.push({
      name: 'hooks',
      ok: true,
      detail: 'not installed (optional) — `notifai hooks install` adds question routing',
    })
    return checks
  }
  checks.push({
    name: 'hooks',
    ok: true,
    detail: installations
      .map((i) => `${i.harness} ${i.global ? 'global' : 'project'} (${i.file})`)
      .join(', '),
  })

  // A handler naming an event this build dropped exits 2 every time the harness
  // fires it, which the harness reports as a hook failure.
  const stale = installations.flatMap((i) =>
    i.handlers
      .filter((h) => {
        const event = handlerEvent(h.command)
        return event !== null && !(HOOK_EVENTS as readonly string[]).includes(event)
      })
      .map((h) => `${h.event} -> ${handlerEvent(h.command)} in ${i.file}`),
  )
  checks.push({
    name: 'hooks (stale)',
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? 'every installed handler names an event this build serves'
        : `${stale.join('; ')} — rerun \`notifai hooks install\` to drop ${stale.length === 1 ? 'it' : 'them'}`,
  })

  // Two checkouts each installing hooks means both fire for the same event, and
  // the user gets every question twice (NotifAI-0vk).
  //
  // Compared *within* a harness, not across. Only one harness runs a given
  // session, so having Claude Code and OpenCode both set up is the ordinary
  // case and not a duplicate — comparing them turned a healthy machine red.
  const duplicated = [...new Set(installations.map((i) => i.harness))]
    .map((harness) => ({
      harness,
      scripts: new Set(
        installations
          .filter((i) => i.harness === harness)
          .flatMap((i) => i.handlers.map((h) => h.command.split(' hook ')[0] ?? '')),
      ),
    }))
    .filter((entry) => entry.scripts.size > 1)
  if (duplicated.length > 0) {
    checks.push({
      name: 'hooks (duplicates)',
      ok: false,
      detail: duplicated
        .map(
          (entry) =>
            `${entry.harness}: ${entry.scripts.size} different NotifAI builds are installed, so each event will fire all of them. Uninstall the ones you do not want: ${[...entry.scripts].join(', ')}`,
        )
        .join('; '),
    })
  }

  const fired = readProjectSession(deps.cwd, deps.env, (deps.now ?? Date.now)()) !== null
  const cursorOnly = installations.every((installation) => installation.harness === 'cursor')
  checks.push({
    name: 'hooks (fired)',
    ok: fired,
    detail: fired
      ? 'a session in this directory has run them'
      : cursorOnly
        ? 'installed but never run here — Cursor reloads hooks automatically; send one prompt'
        : 'installed but never run here — restart the harness and send one prompt ' +
          '(hooks are read once at session start)',
  })

  const stray = codexStrayWorktreeCheck(deps)
  if (stray !== null) checks.push(stray)

  const codex = installations.filter((i) => i.harness === 'codex')
  if (codex.length > 0) {
    checks.push(codexTrustCheck(deps, codex))
  }
  return checks
}

/**
 * A Codex hooks file sitting in a worktree, which Codex will never read.
 *
 * `settingsFile` now writes to the main repository, so this only fires for a
 * file an older build left behind — but that file is indistinguishable from a
 * working install if you go looking, and it is exactly what made this bug take
 * a day to find (NotifAI-rqx). Omitted entirely when there is nothing to say.
 */
function codexStrayWorktreeCheck(
  deps: CommandDeps,
): { name: string; ok: boolean; detail: string } | null {
  const layer = codexLayerDir(deps.cwd)
  if (layer === null) return null
  const root = codexProjectRoot(deps.cwd)
  const stray = path.join(path.dirname(layer), '.codex', 'hooks.json')
  if (!existsSync(path.join(root, '.codex', 'hooks.json'))) return null
  const problems: string[] = []
  if (!existsSync(layer)) {
    problems.push(`${layer} is missing, so Codex never looks for project hooks here`)
  }
  if (existsSync(stray)) {
    problems.push(`${stray} is never read — Codex reads ${root}/.codex/hooks.json instead`)
  }
  return {
    name: 'hooks (codex worktree)',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `worktree wired to the main repository at ${root}`
        : `${problems.join('; ')}. Re-run \`notifai hooks install\` to fix.`,
  }
}

/**
 * Codex trusts each handler by content hash and skips untrusted ones without
 * reporting anything, so "installed" and "will run" are different questions.
 * The trust table lives in `config.toml` under keys of the form
 * `<file>:<snake_case event>:<group>:<handler>` — verified against a real
 * config on 2026-08-02.
 */
function codexTrustCheck(
  deps: CommandDeps,
  installations: Installation[],
): { name: string; ok: boolean; detail: string } {
  const file = codexConfigPath(deps.env)
  let state: Record<string, unknown> = {}
  try {
    const parsed = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>
    const hooks = parsed['hooks'] as Record<string, unknown> | undefined
    state = (hooks?.['state'] as Record<string, unknown> | undefined) ?? {}
  } catch {
    return {
      name: 'hooks (codex trust)',
      ok: false,
      detail: `could not read ${file}; start Codex interactively once and accept the hook prompt`,
    }
  }
  const untrusted = installations.flatMap((i) =>
    i.handlers.filter((h) => state[codexTrustKey(i.file, h)] === undefined).map((h) => h.event),
  )
  return {
    name: 'hooks (codex trust)',
    ok: untrusted.length === 0,
    detail:
      untrusted.length === 0
        ? 'every handler has a trust entry (entry present; the hash itself is Codex’s to check)'
        : `no trust entry for ${untrusted.join(', ')} — Codex will skip ${untrusted.length === 1 ? 'it' : 'them'} ` +
          'silently. Start Codex interactively once and accept the prompt.',
  }
}

// ---------------------------------------------------------------------------
// production IO
// ---------------------------------------------------------------------------

/**
 * Whether a human is driving this terminal.
 *
 * A TTY alone is NOT that evidence: agent harnesses frequently allocate a PTY
 * for the commands they run, and a prompt shown to an agent does not fail — it
 * hangs, because every prompt library waits on stdin rather than erroring. So
 * this also honours `CI` and an explicit `NOTIFAI_NO_INPUT=1` escape hatch,
 * and every interactive affordance stays strictly optional: anything `init`
 * can ask, a flag can answer.
 */
function isHumanTerminal(env: NodeJS.ProcessEnv): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (env['CI'] ?? '') === '' &&
    (env['NOTIFAI_NO_INPUT'] ?? '') === ''
  )
}

/**
 * Lazy on purpose: the hook path runs in front of every prompt the user types,
 * and must not pay for a prompt library it will never show.
 */
async function clack() {
  return await import('@clack/prompts')
}

export function realIo(env: NodeJS.ProcessEnv = process.env): CommandIo {
  const interactive = () => isHumanTerminal(env)
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    get interactive() {
      return interactive()
    },
    confirm: async (question, fallback = false) => {
      if (!interactive()) return fallback
      const p = await clack()
      const answer = await p.confirm({ message: question, initialValue: fallback })
      // Ctrl-C mid-prompt arrives as a cancel symbol, not a SIGINT; treat it
      // as the safe answer rather than letting a Symbol escape into logic.
      return p.isCancel(answer) ? false : answer
    },
    select: async (message, options) => {
      if (!interactive()) return null
      const p = await clack()
      const answer = await p.select({ message, options })
      return p.isCancel(answer) ? null : (answer as string)
    },
    intro: async (title) => {
      if (!interactive()) return
      ;(await clack()).intro(title)
    },
    outro: async (message) => {
      if (!interactive()) return
      ;(await clack()).outro(message)
    },
    note: async (message, title) => {
      if (!interactive()) return
      ;(await clack()).note(message, title)
    },
    spinner: async (message) => {
      if (!interactive()) return null
      const progress = (await clack()).spinner()
      progress.start(message)
      return {
        message: (next) => progress.message(next),
        stop: (next) => progress.stop(next),
        error: (next) => progress.error(next),
      }
    },
    check: async (ok, message) => {
      if (!interactive()) return
      const { log } = await clack()
      if (ok) log.success(message)
      else log.error(message)
    },
    openUrl: (url) => {
      const command =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      try {
        spawn(command, [url], { stdio: 'ignore', detached: true }).unref()
      } catch {
        // Browser opening is best-effort; the URL is printed anyway.
      }
    },
  }
}
