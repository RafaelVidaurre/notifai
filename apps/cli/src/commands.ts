import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  CAPABILITIES_V1,
  REPLY_MAX_WINDOW_SECONDS,
  validateDraft,
  type EvidenceSnapshot,
  type AccountAccessResponse,
  type ListRepliesResponse,
  type Platform,
  type ReplyView,
  type RoutableDevice,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
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
  configBounds,
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
import { firstBlocker, openItems, type Readiness, type ReadinessState } from './readiness.js'
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
  blockingHookTimeoutSeconds,
  buildCursorHookConfig,
  buildHookConfig,
  codexLayerDir,
  codexProjectRoot,
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
import type { NativeSkill, NativeSkills, SkillScope } from './native-skills.js'

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
  /** Test seam and production adapter for the external native skills installer. */
  nativeSkills?: NativeSkills
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

/** Show the server's account access decision without attempting a product mutation. */
export async function accessStatusCommand(
  deps: CommandDeps,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const access: AccountAccessResponse = await authed.client.accessStatus()
    if (flags.json) {
      deps.io.out(JSON.stringify(access, null, 2))
      return access.status === 'active' ? EXIT.ok : EXIT.failed
    }
    if (access.status === 'no_active_plan') {
      deps.io.out('No active plan or temporary Alpha access for this account.')
      deps.io.out('next: Ask a platform administrator to grant temporary Alpha access, then retry.')
      return EXIT.failed
    }
    const expiry = access.expires_at ? ` until ${access.expires_at}` : ''
    deps.io.out(`Access active (${access.reason})${expiry}`)
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
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
  const hasReplyChoice = Array.isArray(flags.replyChoice)
    ? flags.replyChoice.length > 0
    : flags.replyChoice !== undefined
  if (
    !flags.reply &&
    (flags.replyTimeout !== undefined || flags.replyWindow !== undefined || flags.noBlock || hasReplyChoice)
  ) {
    deps.io.err('Use --reply with --reply-timeout, --reply-window, --reply-choice, or --no-block.')
    return EXIT.usage
  }
  const replyTimeout = flags.replyTimeout ?? 900
  if (flags.reply && !isNonNegativeInteger(replyTimeout)) {
    deps.io.err('--reply-timeout must be a non-negative integer number of seconds.')
    return EXIT.usage
  }
  // Asking while declaring that nothing will wait for the answer. The reply is
  // captured server-side and then unreachable: only a blocking send waits for
  // it, and the hook path drains questions registered by `ask`, never a send's
  // request id. So the user gets a real button, taps it, and nothing happens —
  // worse than a banner that never asked, because it spends their attention
  // and their trust in the channel.
  //
  // Both spellings of "do not wait" are rejected, because the defect is the
  // zero wait and not the flag that produced it.
  if (flags.reply && (flags.noBlock || replyTimeout === 0)) {
    deps.io.err(
      'A question needs someone to hear the answer, so --reply cannot be combined ' +
        'with --no-block or --reply-timeout 0.\n' +
        'To ask and end the turn, use `notifai ask` — the turn-end hook returns the answer.\n' +
        'To announce finished work, drop --reply and its choices.',
    )
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
  if (
    !flags.reply &&
    (flags.title.trim().endsWith('?') || flags.body.trim().endsWith('?'))
  ) {
    deps.io.err(
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --reply-choice) so it can be answered from the notification.',
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

    // A zero wait can no longer reach here: --reply guarantees a positive one.
    if (!flags.reply || receiptExit !== EXIT.ok) {
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
   * may well have answered and we could not see it.
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
 * and one of those two branches is safe to proceed from.
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
 * The other half of first-reply-wins.
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
      deps.io.out(`  ${d.device_name}:`)
      deps.io.out(`    Delivery: ${d.state} after ${d.attempts} attempt(s)`)
      deps.io.out(
        `    Provider Acceptance: ${d.state === 'provider_accepted' ? 'accepted' : 'not recorded'}`,
      )
      if (d.companion_receipt.state === 'observed') {
        const latency = d.companion_receipt.latency_ms
        deps.io.out(
          `    Companion Receipt: observed at ${d.companion_receipt.observed_at}` +
            (latency === null ? '' : ` (${formatElapsed(latency)} after Provider Acceptance)`),
        )
      } else {
        deps.io.out(
          '    Companion Receipt: unknown — not observed; this is not a failure or proof of non-receipt',
        )
      }
      for (const e of d.events) {
        deps.io.out(`      ${e.occurred_at}  ${e.stage}${e.reason ? ` (${e.reason})` : ''}`)
      }
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
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
    // Stop is allowed to block and keeps the ordinary budget.
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
 * What went wrong, in terms of what to do about it.
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
 * Registers a question for turn-end routing under the user's presence config.
 * Returns immediately so the agent can ask in prose and end its turn. With the
 * default presence gate, recent keyboard or mouse activity keeps it local;
 * `require_idle = false` intentionally permits a push while the user is active.
 */
export function askCommand(deps: CommandDeps, question: string, flags: AskFlags): number {
  // An agent calling this gets no hook payload and no harness exports its
  // session id, so the UserPromptSubmit hook leaves a pointer keyed on the
  // project directory and we read it back here. The pointer outranks the
  // NOTIFAI_SESSION fallback deliberately: the exported id is often a chosen
  // label rather than the harness's own id, and the hooks key state by the
  // latter — the env var is only trusted when no hook has spoken.
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
  try {
    registerQuestion(
      sessionId,
      deps.env,
      {
        question: question.trim(),
        ...(choices !== null ? { choices: choices.map((choice) => choice.label) } : {}),
      },
      (deps.now ?? Date.now)(),
    )
  } catch (err) {
    deps.io.err(`Could not register the question: ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.failed
  }
  if (choices !== null) {
    deps.io.out(`Answers offered: ${choices.map((choice) => choice.label).join(' / ')}`)
  }
  // On stdout, not stderr: the agent reads the former and this is only useful
  // if it is read while there is still time to fix the question.
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
 * one prompt". The useful next action depends on the harness: some reload
 * project hook files, OpenCode loads its plugin at startup, and Codex should be
 * checked after a prompt before assuming that a new session is required.
 */
function diagnoseMissingSession(deps: CommandDeps): string[] {
  const installations = findInstallations(deps.cwd, deps.env)
  if (installations.length === 0) {
    return [
      'Could not tell which harness session this is: no NotifAI hooks are installed for this project.',
      'Run `notifai hooks install`, then follow the activation instruction it prints.',
    ]
  }
  const where = installations.map((i) => `${i.harness} in ${i.file}`).join(', ')
  return [
    `Could not tell which harness session this is. NotifAI hooks are installed (${where}),`,
    'but no usable session pointer from the last 24 hours exists here.',
    hookActivationAdvice(installations),
    'To ask from this session anyway, pass --session <id>.',
  ]
}

/** The least disruptive verified way to make each installed adapter run once. */
function hookActivationAdvice(installations: Installation[]): string {
  const harnesses = new Set(installations.map((installation) => installation.harness))
  const advice: string[] = []
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && !installation.global,
    )
  ) {
    advice.push('Claude Code: send one new prompt; project hook files reload without a restart')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && installation.global,
    )
  ) {
    advice.push('Claude Code global hooks: send one prompt; start a new session only if it does not fire')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && !installation.global,
    )
  ) {
    advice.push(
      'Cursor: send one prompt, then run `notifai doctor`; start a new session only if it still has not fired',
    )
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && installation.global,
    )
  ) {
    advice.push('Cursor global hooks: send one prompt; start a new session only if it does not fire')
  }
  if (harnesses.has('codex')) {
    advice.push(
      'Codex: send one prompt, then run `notifai doctor`; start a new session only if it still has not fired',
    )
  }
  if (harnesses.has('opencode')) {
    advice.push('OpenCode: restart it, then send one prompt; plugins load at startup')
  }
  return `${advice.join('. ')}.`
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
  // merged into a settings document, so it owns the whole file.
  if (harness === 'opencode') {
    return installOpencodePlugin(deps, file, {
      execPath,
      scriptPath,
      timeoutSeconds: blockingHookTimeoutSeconds(
        config.ask_grace_seconds.value,
        config.hook_reply_timeout_seconds.value,
      ),
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
    if (flags.global) {
      deps.io.out('Send one Cursor prompt, then check `notifai doctor`. If the hook has not fired,')
      deps.io.out('start a new Cursor session and try one prompt again.')
    } else {
      deps.io.out('Send one Cursor prompt, then check `notifai doctor`. If the hook has not fired,')
      deps.io.out('start a new Cursor session and try one prompt again.')
    }
    deps.io.out('A companion-device answer is submitted as one')
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
      ? `While keyboard or mouse idle time stays below ${config.away_after_seconds.value}s, ` +
          `nothing is pushed. A question registered with \`notifai ask\` stays in the terminal ` +
          `until its ${config.ask_grace_seconds.value}s grace window, counted from registration, ` +
          `has elapsed; it goes to your devices only while the machine also meets the idle threshold. ` +
          `Set \`require_idle = false\` to be notified even while you are working.`
      : `A question registered with \`notifai ask\` stays in the terminal for ` +
          `${config.ask_grace_seconds.value}s from registration and then goes to your devices ` +
          `whether or not you are at this machine ` +
          `(\`require_idle = false\`).`,
  )
  if (config.require_idle.value) {
    deps.io.out(
      'If this OS exposes no keyboard/mouse idle signal, the hook falls back to prompt silence and skips the blocking grace once it decides you are away.',
    )
  }
  if (harness === 'codex') {
    const layer = flags.global ? null : codexLayerDir(deps.cwd)
    if (layer !== null) {
      // Codex reads project hooks from the main repository but only looks when
      // a `.codex` directory sits at or above cwd, so a worktree install has to
      // write one file and create one directory in two different places. Doing
      // it silently would leave the next person deriving this the hard way
      //.
      mkdirSync(layer, { recursive: true })
      deps.io.out('')
      deps.io.out('You are in a worktree. Codex reads project hooks from the main repository,')
      deps.io.out(`so they were written to ${file}. ${layer} was created so this`)
      deps.io.out('worktree discovers that file. Each other worktree needs its own `.codex`')
      deps.io.out('directory; rerun this installer from that worktree to create it.')
    }
  }
  deps.io.out('')
  if (harness === 'claude-code' && flags.global !== true) {
    deps.io.out('Claude Code reloads project hook files without a restart. Send one new prompt,')
    deps.io.out('then check `notifai doctor` to confirm that the hook fired.')
  } else if (harness === 'claude-code') {
    deps.io.out('Send one new Claude Code prompt, then check `notifai doctor`. If the hook has')
    deps.io.out('not fired, start a new Claude Code session and try one prompt again.')
  } else {
    deps.io.out('Send one Codex prompt, then check `notifai doctor`. If the hook has not fired,')
    deps.io.out('start a new Codex session and try one prompt again.')
  }
  return EXIT.ok
}

/**
 * Writes the OpenCode plugin, replacing any NotifAI plugin already there —
 * including one a different checkout wrote, matched on the managed marker for
 * the same reason command hooks are.
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
  deps.io.out('It maps chat.message to presence, session.idle to question escalation, and')
  deps.io.out('session.deleted to local cleanup through the same `notifai hook` commands')
  deps.io.out('the other harnesses run. Permission prompts stay in OpenCode.')
  deps.io.out('OpenCode cannot reliably resume an idle agent turn with a device answer; use')
  deps.io.out('`notifai send --reply` when the answer must return to the agent.')
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
    const numeric = Number(rawValue)
    if (!Number.isInteger(numeric)) {
      deps.io.err(`"${rawValue}" is not an integer.`)
      return EXIT.usage
    }
    const bounds = configBounds(key as ConfigKey)
    if (bounds !== undefined && (numeric < bounds.min || numeric > bounds.max)) {
      deps.io.err(`${key} must be between ${bounds.min} and ${bounds.max}.`)
      return EXIT.usage
    }
    value = numeric
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
      { value: 'local', label: 'This project (personal)', hint: 'keep config.local.toml gitignored' },
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
 * Where `npx skills add` fetches the optional agent skill from. In skills CLI
 * 1.5.x, `owner/repo@name` selects a skill; a Git ref belongs after `#`.
 * Keep this immutable and public because the command is printed to users.
 */
export const SKILLS_SOURCE = 'RafaelVidaurre/notifai#v0.1.7'

function skillSourceParts(): { source: string; ref: string } | null {
  const match = /^([^#]+)#(.+)$/.exec(SKILLS_SOURCE)
  return match === null ? null : { source: match[1]!, ref: match[2]! }
}

function expectedSkill(skill: NativeSkill): boolean {
  const expected = skillSourceParts()
  return (
    expected !== null &&
    skill.name === 'notifai' &&
    skill.source === expected.source &&
    skill.sourceType === 'github' &&
    skill.ref === expected.ref
  )
}

async function skillReadiness(
  deps: CommandDeps,
  selectedScope?: SkillScope,
): Promise<ReadinessState> {
  const scopes: SkillScope[] = selectedScope === undefined ? ['project', 'global'] : [selectedScope]
  const results = await Promise.all(
    scopes.map(async (scope) => {
      if (deps.nativeSkills === undefined) return { scope, skills: [] as NativeSkill[] }
      try {
        return { scope, ...(await deps.nativeSkills.list(scope, deps.cwd, deps.env)) }
      } catch (err) {
        return { scope, skills: [] as NativeSkill[], error: String(err) }
      }
    }),
  )
  const installed = results.flatMap(({ skills }) => skills).find(expectedSkill)
  if (installed !== undefined) {
    return {
      id: 'skill',
      title: 'Agent guidance skill',
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE} in the ${installed.scope} scope`,
    }
  }

  const errors = results
    .filter((result) => result.error !== undefined)
    .map((result) => `${result.scope}: ${result.error}`)
  const scopeText = selectedScope === undefined ? 'project or machine-global scope' : `${selectedScope} scope`
  return {
    id: 'skill',
    title: 'Agent guidance skill',
    status: 'optional-gap',
    detail:
      errors.length > 0
        ? `could not verify installer-managed state in ${scopeText} (${errors.join('; ')})`
        : `not installed from ${SKILLS_SOURCE} in ${scopeText}`,
    remedy: {
      by: 'cli',
      summary: 'install the skill agents follow when deciding to notify',
      command:
        selectedScope === undefined
          ? 'notifai init --skills'
          : `notifai init --skills --skills-scope ${selectedScope}`,
    },
  }
}

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
   * Install the agent guidance skill. Tri-state on purpose:
   * true installs, false skips silently, and undefined means "offer it when a
   * human is present, do nothing when one is not" — an unattended run must
   * never spawn npx against the network by default.
   */
  skills?: boolean
  /** Scope selected by an unattended caller; humans choose inside npx skills. */
  skillsScope?: SkillScope
  /** Same tri-state, for the harness hooks. */
  hooks?: boolean
}

interface SetupProofRecord {
  request_id: string
  device_id: string
  project: string | null
  started_at: string
}

const DEVICE_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000
const DEVICE_BRIDGE_POLL_MS = 2_000
const PROOF_TIMEOUT_MS = 30_000
const PROOF_POLL_MS = 1_000

function setupProofPath(deps: CommandDeps): string {
  let projectDir = path.resolve(deps.cwd)
  try {
    projectDir = realpathSync(projectDir)
  } catch {
    // A deleted or not-yet-created cwd cannot collide with a real directory:
    // the resolved absolute path is still a stable local identity for it.
  }
  const digest = createHash('sha256').update(projectDir).digest('hex').slice(0, 32)
  const xdg = deps.env['XDG_STATE_HOME']
  const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'notifai', 'setup-proofs', `${digest}.json`)
}

function readSetupProof(deps: CommandDeps): SetupProofRecord | null {
  const file = setupProofPath(deps)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupProofRecord>
    return typeof parsed.request_id === 'string' &&
      typeof parsed.device_id === 'string' &&
      (typeof parsed.project === 'string' || parsed.project === null) &&
      typeof parsed.started_at === 'string'
      ? (parsed as SetupProofRecord)
      : null
  } catch {
    // Corrupt local evidence is not readiness. A fresh proof replaces it.
    return null
  }
}

function writeSetupProof(deps: CommandDeps, proof: SetupProofRecord): boolean {
  const file = setupProofPath(deps)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch (err) {
    deps.io.err(
      `Could not save setup proof ${proof.request_id} at ${file}: ${String(err)}`,
    )
    return false
  }
}

function observedCompanionReceipt(
  snapshot: EvidenceSnapshot,
  deviceId: string,
): { delivery: EvidenceSnapshot['deliveries'][number]; observedAt: string } | null {
  const delivery = snapshot.deliveries.find((candidate) => candidate.device_id === deviceId)
  const receipt = delivery?.events.find((event) => event.stage === 'companion_received')
  return delivery && receipt ? { delivery, observedAt: receipt.occurred_at } : null
}

/**
 * The setup coordinator that observes each prerequisite and advances the ones
 * this build can perform.
 *
 * Idempotent by construction: every step first observes, then acts only on the
 * gap, so re-running is how you check the setup as much as how you create it.
 * With a human at a terminal it walks them through the missing pieces; run by
 * an agent it never prompts — each optional step is answered by a flag, and
 * whatever only the user can do (signing in, pairing a companion device) is printed as
 * the exact command to hand back to them.
 */
/**
 * Close a gap the CLI is allowed to close on its own, without asking.
 *
 * Only reached for `by: 'cli'` remedies, which by definition need no human, so
 * this stays silent about what it did — the re-assessment that follows reports
 * the new state, and narrating both is how a setup log becomes unreadable.
 *
 * `pending` means the action is real but its evidence has not arrived yet;
 * `failed` means the action itself could not be performed.
 */
type GapCloseResult = 'closed' | 'pending' | 'failed'

async function closeGap(
  deps: CommandDeps,
  state: ReadinessState,
  flags: InitFlags,
): Promise<GapCloseResult> {
  if (state.id === 'project') {
    const configPath = path.join(deps.cwd, '.notifai', 'config.toml')
    const existing = existsSync(configPath)
      ? (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
      : {}
    existing['project'] = projectSlugFrom(flags.projectId ?? path.basename(deps.cwd))
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${stringifyToml(existing)}\n`)
    return 'closed'
  }

  if (state.id === 'hooks') {
    let harness = detectHarness(deps.cwd)
    if (harness === null && deps.io.interactive === true && deps.io.select) {
      const picked = await deps.io.select(
        'Which agent harness do you use here?',
        HARNESSES.map((name) => ({ value: name, label: name })),
      )
      if (picked !== null) harness = picked as Harness
    }
    if (harness === null) {
      deps.io.err(
        `Could not tell which harness to wire. Run: notifai hooks install --harness <${HARNESSES.join('|')}>`,
      )
      return 'failed'
    }
    return hooksInstallCommand(deps, { harness }) === EXIT.ok ? 'closed' : 'failed'
  }

  if (state.id === 'skill') {
    if (deps.nativeSkills === undefined) {
      deps.io.err('Skill installation failed — the native `npx skills` flow is unavailable.')
      return 'failed'
    }
    const scopeText = flags.skillsScope === undefined ? 'the scope you choose' : `${flags.skillsScope} scope`
    deps.io.out(`Starting the native npx skills setup for the notifai agent skill (${scopeText})...`)
    const addOptions = {
      source: SKILLS_SOURCE,
      skill: 'notifai',
      cwd: deps.cwd,
      env: deps.env,
      ...(flags.skillsScope === undefined ? {} : { scope: flags.skillsScope }),
    }
    const code = await deps.nativeSkills.add(addOptions)
    if (code !== 0) {
      deps.io.err('Skill installation failed — run it manually with:')
      deps.io.err(
        `  npx skills add ${SKILLS_SOURCE} --skill notifai${
          flags.skillsScope === 'global' ? ' --global' : ''
        }${flags.skillsScope === undefined ? '' : ' --yes'}`,
      )
    }
    return code === 0 ? 'closed' : 'failed'
  }

  if (state.id === 'proof') return await runSetupProof(deps)

  return 'failed'
}

function deviceCanReceive(device: RoutableDevice): boolean {
  return (
    device.registration_healthy &&
    (device.permission_status === 'authorized' || device.permission_status === 'provisional')
  )
}

function readyIosDevices(devices: readonly RoutableDevice[]): RoutableDevice[] {
  return devices.filter((device) => device.platform === 'ios' && deviceCanReceive(device))
}

function deviceBridgeMessage(devices: readonly RoutableDevice[]): string {
  if (devices.length === 0) {
    return 'Waiting for the companion app to sign in and register…'
  }
  const denied = devices.find((device) => device.permission_status === 'denied')
  if (denied) return `Waiting for notifications to be allowed on ${denied.display_name}…`
  const undecided = devices.find((device) => device.permission_status === 'not_determined')
  if (undecided) return `Waiting for ${undecided.display_name} to allow the notification prompt…`
  return 'Waiting for a companion device to become ready…'
}

/**
 * Observe the supported Device Installation path while the user finishes the
 * app-side work. There is deliberately no invented QR or download URL here:
 * this release exposes neither an App Store/TestFlight URL nor a device-pairing
 * endpoint, and a placeholder bridge is worse than an explicit boundary.
 */
async function waitForReadyDevice(deps: CommandDeps, state: ReadinessState): Promise<GapCloseResult> {
  const remedy = state.remedy
  if (deps.io.interactive !== true || remedy?.by !== 'user-elsewhere') return 'pending'

  await deps.io.note?.(
    `${state.detail}\n${remedy.summary}`,
    'Finish setup on your companion device',
  )
  if (!(await deps.io.confirm('Wait here while you finish that on your device?', true))) {
    return 'pending'
  }

  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return 'failed'
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + DEVICE_BRIDGE_TIMEOUT_MS
  const spinner = await deps.io.spinner?.('Waiting for a companion device…')
  let lastDevices: RoutableDevice[] = []

  while (now() < deadline) {
    try {
      const response = await authed.client.listDevices()
      lastDevices = response.devices
      const ready = response.devices.find(deviceCanReceive)
      if (ready) {
        spinner?.stop(`${ready.display_name} is ready to receive`)
        return 'closed'
      }
      spinner?.message(deviceBridgeMessage(response.devices))
    } catch (err) {
      if (!(err instanceof NetworkError)) {
        spinner?.error('Could not check companion readiness')
        reportError(deps, err)
        return 'failed'
      }
      spinner?.message('Connection lost — still watching…')
    }
    await sleep(Math.min(DEVICE_BRIDGE_POLL_MS, Math.max(0, deadline - now())))
  }

  spinner?.error('No companion device became ready')
  deps.io.err(deviceBridgeMessage(lastDevices).replace(/…$/, '.'))
  return 'pending'
}

function setupProofDraft(
  config: CliConfig,
  device: RoutableDevice,
): ReturnType<typeof buildDraft> {
  const project = config.project.value
  return buildDraft(config, {
    title: 'NotifAI is ready',
    body:
      project === null
        ? 'This real notification completed setup verification.'
        : `This real notification completed setup verification for ${project}.`,
    event: 'setup_verified',
    kind: 'update',
    platform: 'ios',
    device: [device.device_id],
    sound: 'none',
    level: 'passive',
    collapseKey: 'notifai-setup-verification',
  })
}

async function submitSetupProof(
  deps: CommandDeps,
  client: ApiClient,
  config: CliConfig,
  device: RoutableDevice,
): Promise<SubmissionReceipt | null> {
  const build = setupProofDraft(config, device)
  if (!build.ok) {
    deps.io.err(`Could not build the setup verification notification: ${build.error}`)
    return null
  }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (!capabilities) {
    deps.io.err(`No capability contract is available for ${build.platform}.`)
    return null
  }
  const validation = validateDraft(build.draft, capabilities)
  if (!validation.ok) {
    for (const issue of validation.errors) {
      deps.io.err(`Setup verification ${issue.path}: ${issue.message}`)
    }
    return null
  }
  try {
    return await client.submit(
      {
        idempotency_key: `init-${randomBytes(12).toString('base64url')}`,
        draft: build.draft,
      },
      config.wait_seconds.value,
    )
  } catch (err) {
    reportError(deps, err)
    return null
  }
}

/**
 * Send or resume one real setup probe, then wait for a Companion Receipt.
 * Provider Acceptance is intentionally insufficient: it proves APNs accepted
 * the push, not that a companion process received it.
 */
async function runSetupProof(deps: CommandDeps): Promise<GapCloseResult> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return 'failed'

  let devices: RoutableDevice[]
  try {
    devices = (await authed.client.listDevices()).devices
  } catch (err) {
    reportError(deps, err)
    return 'failed'
  }
  const candidates = readyIosDevices(devices)
  const existing = readSetupProof(deps)
  const target =
    candidates.find(
      (device) =>
        device.device_id === existing?.device_id && existing.project === config.project.value,
    ) ?? candidates[0]
  if (!target) {
    deps.io.err(
      'Setup proof needs a receipt-capable iPhone. The current macOS notification path does not emit Companion Receipts.',
    )
    return 'pending'
  }

  let proof =
    existing?.device_id === target.device_id && existing.project === config.project.value
      ? existing
      : null
  if (proof === null) {
    const receipt = await submitSetupProof(deps, authed.client, config, target)
    if (receipt === null) return 'failed'
    if (receipt.overall === 'provider_rejected_all') {
      deps.io.err(formatReceipt(receipt))
      return 'failed'
    }
    proof = {
      request_id: receipt.request_id,
      device_id: target.device_id,
      project: config.project.value,
      started_at: new Date((deps.now ?? Date.now)()).toISOString(),
    }
    if (!writeSetupProof(deps, proof)) return 'failed'
    deps.io.out(`Verification notification sent to ${target.display_name} (${proof.request_id}).`)
  } else {
    deps.io.out(`Checking verification notification ${proof.request_id} again.`)
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + PROOF_TIMEOUT_MS
  const spinner = deps.io.interactive === true
    ? await deps.io.spinner?.('Waiting for a Companion Receipt…')
    : null
  let lastError: unknown = null
  let replacedMissingProof = false

  for (;;) {
    try {
      const snapshot = await authed.client.evidence(proof.request_id)
      const observed = observedCompanionReceipt(snapshot, proof.device_id)
      if (observed) {
        spinner?.stop(`Receipt observed from ${observed.delivery.device_name}`)
        return 'closed'
      }
      lastError = null
    } catch (err) {
      lastError = err
      if (
        err instanceof ApiCallError &&
        err.code === 'not_found' &&
        !replacedMissingProof
      ) {
        const receipt = await submitSetupProof(deps, authed.client, config, target)
        if (receipt === null) return 'failed'
        if (receipt.overall === 'provider_rejected_all') {
          deps.io.err(formatReceipt(receipt))
          return 'failed'
        }
        proof = {
          request_id: receipt.request_id,
          device_id: target.device_id,
          project: config.project.value,
          started_at: new Date(now()).toISOString(),
        }
        if (!writeSetupProof(deps, proof)) return 'failed'
        replacedMissingProof = true
        lastError = null
        deps.io.out(`The saved proof had expired; sent replacement ${proof.request_id}.`)
        continue
      }
      if (!(err instanceof NetworkError)) {
        spinner?.error('Could not read Companion Receipt evidence')
        reportError(deps, err)
        return 'failed'
      }
      spinner?.message('Connection lost — still checking the same request…')
    }

    if (now() >= deadline) break
    await sleep(Math.min(PROOF_POLL_MS, Math.max(0, deadline - now())))
  }

  spinner?.error('Companion Receipt not observed yet')
  if (lastError instanceof NetworkError) deps.io.err(lastError.message)
  deps.io.err(
    `No Companion Receipt was observed for ${proof.request_id} within ${PROOF_TIMEOUT_MS / 1000}s. ` +
      'That is not proof of non-receipt; re-run `notifai init` to check this same notification again.',
  )
  return 'pending'
}

/** Whether an optional gap should be closed, given flags and who is watching. */
function wantsOptional(deps: CommandDeps, state: ReadinessState, flags: InitFlags): Promise<boolean> {
  // Naming the project is init's whole reason to touch the filesystem, costs
  // nothing, and is undone by editing one line — so it is done rather than
  // asked about, for a human and an agent alike.
  if (state.id === 'project') return Promise.resolve(true)
  const explicit = state.id === 'hooks' ? flags.hooks : state.id === 'skill' ? flags.skills : undefined
  if (explicit !== undefined) return Promise.resolve(explicit)
  // An agent is never asked, and never assumed into a change it did not
  // request: silence means no, and the summary says what was skipped.
  if (deps.io.interactive !== true) return Promise.resolve(false)
  const question =
    state.id === 'hooks'
      ? 'Install harness hooks, so questions reach your devices when you are away?'
      : 'Install/update the agent guidance skill through the native npx skills flow?'
  return deps.io.confirm(question, true)
}

/**
 * Setup as one step at a time.
 *
 * The old version ran five steps in a fixed order and ended with a list of
 * everything still outstanding. That is a report, and a report is the wrong
 * output here: someone handed five things to do does none of them, and the
 * order was the script's rather than the dependency graph's — it offered to
 * install hooks after a sign-in that had just failed.
 *
 * So this closes what it can, then surfaces exactly one thing, the first that
 * stands in the way. Re-running advances by one. Idempotence stops being a
 * property to preserve and becomes the mechanism: every decision is derived
 * from observed state, so a partial run, a second project, a fresh worktree
 * and a revoked credential are the same code path arriving at different
 * states rather than four branches to enumerate.
 */
export async function initCommand(deps: CommandDeps, flags: InitFlags): Promise<number> {
  if (
    flags.skillsScope !== undefined &&
    flags.skillsScope !== 'project' &&
    flags.skillsScope !== 'global'
  ) {
    deps.io.err('Invalid skill scope. Choose `project` or `global`.')
    return EXIT.usage
  }
  if (flags.skillsScope !== undefined && flags.skills !== true) {
    deps.io.err('`--skills-scope` requires `--skills`. Choose project or global in the native installer.')
    return EXIT.usage
  }
  if (
    flags.skills === true &&
    deps.io.interactive !== true &&
    flags.skillsScope === undefined
  ) {
    deps.io.err(
      'Unattended skill setup requires an explicit scope: `notifai init --skills --skills-scope project` or `... global`.',
    )
    return EXIT.usage
  }
  await deps.io.intro?.('NotifAI setup')

  const reassess = () =>
    assessReadiness(
      deps,
      flags.skillsScope === undefined ? {} : { skillScope: flags.skillsScope },
    )
  let readiness = await reassess()
  let failed = false
  const attempted = new Set<string>()

  // Re-assess after every successful action. This is how a browser approval or
  // companion registration can unlock the next state while the user is still
  // here, without copying the dependency graph into a second setup script.
  for (;;) {
    let advanced = false
    let stop = false

    for (const state of readiness.states) {
      if (state.status === 'ready') continue
      if (state.status === 'unknown') {
        stop = true
        break
      }

      const remedy = state.remedy
      if (remedy === undefined || attempted.has(state.id)) {
        if (state.status === 'gap') stop = true
        if (stop) break
        continue
      }

      if (state.status === 'optional-gap') {
        if (remedy.by !== 'cli' || !(await wantsOptional(deps, state, flags))) continue
        attempted.add(state.id)
        const result = await closeGap(deps, state, flags)
        if (result === 'failed') failed = true
        if (result === 'failed' && state.status === 'optional-gap') {
          readiness = await reassess()
          advanced = true
          break
        }
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      if (remedy.by === 'cli') {
        attempted.add(state.id)
        const result = await closeGap(deps, state, flags)
        if (result === 'failed') failed = true
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      // Its to launch, theirs to complete. Offering to start the sign-in is
      // useful only when someone is demonstrably watching; an agent never
      // reaches this prompt or opens a browser.
      if (
        remedy.by === 'user-here' &&
        remedy.interactive === true &&
        deps.io.interactive === true
      ) {
        attempted.add(state.id)
        if (!(await deps.io.confirm('Sign in now? (opens your browser)', true))) {
          stop = true
          break
        }
        if ((await loginCommand(deps, {})) !== EXIT.ok) {
          failed = true
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      if (
        state.id === 'devices' &&
        remedy.by === 'user-elsewhere' &&
        deps.io.interactive === true
      ) {
        attempted.add(state.id)
        const result = await waitForReadyDevice(deps, state)
        if (result === 'failed') failed = true
        if (result !== 'closed') {
          stop = true
          break
        }
        readiness = await reassess()
        advanced = true
        break
      }

      // A human-only remedy is the first blocker for an unattended agent.
      stop = true
      break
    }

    if (stop || !advanced) break
  }

  readiness = await reassess()
  for (const state of readiness.states.filter((s) => s.status === 'ready')) {
    deps.io.out(`${state.title}: ${state.detail}`)
  }

  const blocker = firstBlocker(readiness)
  if (blocker === null) {
    const skipped = openItems(readiness).filter(
      (state) => !(state.id === 'skill' && flags.skills === false),
    )
    for (const state of skipped) deps.io.out(`Optional, not set up — ${remedyLine(state)}`)
    deps.io.out('All set. Agents in this project can notify you and ask questions.')
    await deps.io.outro?.('All set ✨')
    return failed ? EXIT.failed : EXIT.ok
  }

  // Exactly one. Everything else waits until this is done, because the next
  // gap is frequently a consequence of this one and naming it now would send
  // the reader off to fix something that is not actually wrong.
  deps.io.out('')
  deps.io.out(`Next: ${blocker.title} — ${blocker.detail}`)
  deps.io.out(`  ${remedyLine(blocker)}`)
  if (blocker.remedy?.by === 'user-elsewhere') {
    deps.io.out('  Then re-run `notifai init` and it will pick up from here.')
  }
  await deps.io.outro?.('One step remains (above)')
  // An agent must be able to branch on setup being blocked without parsing
  // prose. A present human may deliberately leave and resume later.
  return failed || deps.io.interactive !== true ? EXIT.failed : EXIT.ok
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Whether the deployed server understands the contract this build speaks
 *.
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

/**
 * Read the whole setup once, in dependency order.
 *
 * Descent stops where a prerequisite is missing: without a credential there is
 * nothing to ask the server with, and without a reachable server a contract
 * mismatch is unknowable rather than absent. Those downstream states report
 * `unknown`, which is the honest answer and keeps a network outage from
 * looking like a broken install.
 */
export async function assessReadiness(
  deps: CommandDeps,
  options: { skillScope?: SkillScope } = {},
): Promise<Readiness> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const states: ReadinessState[] = []
  let accountClient: ApiClient | null = null
  let accountDevices: RoutableDevice[] | null = null

  const configPath = path.join(deps.cwd, '.notifai', 'config.toml')
  const projectSlug = config.project.value
  states.push(
    projectSlug !== null
      ? {
          id: 'project',
          title: 'Project identity',
          status: 'ready',
          detail: `"${projectSlug}" (${config.project.source})`,
        }
      : {
          id: 'project',
          title: 'Project identity',
          // Not a blocker: a send without a project simply carries no project
          // identity. init always sets one because it is free and reversible,
          // but an unlabelled setup works, so this must not go red.
          status: 'optional-gap',
          detail: `not set in ${configPath} — sends from here carry no project identity`,
          remedy: {
            by: 'cli',
            summary: 'name this project after its directory',
            command: 'notifai init',
          },
        },
  )

  const credential = deps.store.load()
  states.push(
    credential
      ? {
          id: 'credential',
          title: 'This machine',
          status: 'ready',
          detail: `paired as "${credential.machineName}" (${deps.store.describe()})`,
        }
      : {
          id: 'credential',
          title: 'This machine',
          status: 'gap',
          detail: 'not paired with your account',
          remedy: {
            by: 'user-here',
            summary: 'sign in — this opens your browser to approve the machine',
            command: 'notifai login',
            interactive: true,
          },
        },
  )

  const baseUrl = resolvedBaseUrl(config, credential)
  const anon = makeClient(deps, baseUrl, null)
  // A probe that throws is unreachable, not a crash: this runs against a
  // half-configured machine by definition, which is where a client that
  // cannot even be constructed properly shows up.
  let reachable = false
  try {
    reachable = await anon.health()
  } catch {
    reachable = false
  }
  states.push(
    reachable
      ? { id: 'server', title: 'Service', status: 'ready', detail: `${baseUrl} reachable` }
      : {
          id: 'server',
          title: 'Service',
          status: 'gap',
          detail: `cannot reach ${baseUrl} (${config.base_url.source})`,
          remedy: {
            by: 'user-here',
            summary: 'check your network, or the base_url shown above',
            command: 'notifai doctor',
          },
        },
  )

  if (!reachable) {
    states.push({
      id: 'contract',
      title: 'Protocol version',
      status: 'unknown',
      detail: 'not checked — the server is unreachable',
    })
  } else {
    const contract = await contractCheck(anon)
    states.push(
      contract.ok
        ? { id: 'contract', title: 'Protocol version', status: 'ready', detail: contract.detail }
        : {
            id: 'contract',
            title: 'Protocol version',
            status: 'gap',
            detail: contract.detail,
            remedy: {
              by: 'user-here',
              summary: 'the CLI and server disagree; the detail above says which to move',
              command: 'notifai doctor',
            },
          },
    )
  }

  if (!credential || !reachable) {
    const why = !credential ? 'this machine is not paired' : 'the server is unreachable'
    states.push({ id: 'auth', title: 'Account', status: 'unknown', detail: `not checked — ${why}` })
    states.push({ id: 'devices', title: 'Your devices', status: 'unknown', detail: `not checked — ${why}` })
  } else {
    const client = makeClient(deps, baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
    accountClient = client
    try {
      const { devices } = await client.listDevices()
      accountDevices = devices
      const ready = devices.filter(deviceCanReceive)
      states.push({
        id: 'auth',
        title: 'Account',
        status: 'ready',
        detail: `machine ${credential.machineId} accepted`,
      })
      states.push(
        ready.length > 0
          ? {
              id: 'devices',
              title: 'Your devices',
              status: 'ready',
              detail: `${ready.map((d) => d.display_name).join(', ')} ready to receive`,
            }
          : {
              id: 'devices',
              title: 'Your devices',
              status: 'gap',
              // The one gap that cannot be closed from this terminal, and the
              // likeliest place a first setup is abandoned. Naming which of
              // the three sub-states it is matters: "install the app" is
              // useless advice to someone who installed it and denied the
              // permission prompt.
              detail:
                devices.length === 0
                  ? 'nothing registered yet; invited Alpha testers install NotifAI from their private TestFlight invitation on iPhone or Mac'
                  : `${devices.map((d) => `${d.display_name} (${d.permission_status})`).join(', ')} — registered but not able to receive`,
              remedy: {
                by: 'user-elsewhere',
                summary:
                  devices.length === 0
                    ? 'open your NotifAI TestFlight invitation on that device, install the app, sign in with the same account, and allow notifications'
                    : devices.some((d) => d.permission_status === 'denied')
                      ? 'allow notifications for NotifAI in that device’s system settings'
                      : 'open NotifAI on that device and allow its notification prompt',
              },
            },
      )
    } catch (err) {
      // A credential the server rejects is revocation, not absence, and the
      // remedy is the same sign-in either way.
      states.push({
        id: 'auth',
        title: 'Account',
        status: 'gap',
        detail: err instanceof ApiCallError ? `${err.code}: ${err.message}` : String(err),
        remedy: {
          by: 'user-here',
          summary: 'this machine is no longer recognised; pair it again',
          command: 'notifai login',
        },
      })
      states.push({ id: 'devices', title: 'Your devices', status: 'unknown', detail: 'not checked — sign-in failed' })
    }
  }

  states.push(...hookStates(deps))

  states.push(await skillReadiness(deps, options.skillScope))

  states.push(await setupProofState(deps, config, accountClient, accountDevices))

  return { states }
}

async function setupProofState(
  deps: CommandDeps,
  config: CliConfig,
  client: ApiClient | null,
  devices: RoutableDevice[] | null,
): Promise<ReadinessState> {
  if (client === null || devices === null) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — account and device readiness must be established first',
    }
  }

  const ready = devices.filter(deviceCanReceive)
  if (ready.length === 0) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'unknown',
      detail: 'not checked — no companion device is ready',
    }
  }

  const ios = readyIosDevices(devices)
  if (ios.length === 0) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail:
        'blocked — the current macOS notification path does not emit Companion Receipts, so this CLI cannot prove receipt on a macOS-only setup',
      remedy: {
        by: 'user-elsewhere',
        summary:
          'pair a receipt-capable iPhone build; no supported macOS receipt bridge is available in this release',
      },
    }
  }

  const proof = readSetupProof(deps)
  const target = proof === null ? null : ios.find((device) => device.device_id === proof.device_id)
  if (proof === null || proof.project !== config.project.value || target === undefined) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail: 'no Companion Receipt has proven this project on this machine yet',
      remedy: {
        by: 'cli',
        summary: 'send one real verification notification and wait for its Companion Receipt',
        command: 'notifai init',
      },
    }
  }

  try {
    const snapshot = await client.evidence(proof.request_id)
    const observed = observedCompanionReceipt(snapshot, proof.device_id)
    if (observed) {
      return {
        id: 'proof',
        title: 'Delivery proof',
        status: 'ready',
        detail: `Companion Receipt observed from ${observed.delivery.device_name} at ${observed.observedAt} (${proof.request_id})`,
      }
    }
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail: `${proof.request_id} was sent, but its Companion Receipt is still unknown`,
      remedy: {
        by: 'cli',
        summary: 'check the same verification notification again',
        command: 'notifai init',
      },
    }
  } catch (err) {
    return {
      id: 'proof',
      title: 'Delivery proof',
      status: 'gap',
      detail: `could not read ${proof.request_id} evidence (${err instanceof ApiCallError ? err.code : String(err)})`,
      remedy: {
        by: 'cli',
        summary: 'retry the existing verification evidence check',
        command: 'notifai init',
      },
    }
  }
}

export async function doctorCommand(deps: CommandDeps, flags: { json?: boolean }): Promise<number> {
  const readiness = await assessReadiness(deps)
  const blocker = firstBlocker(readiness)
  const ok = blocker === null

  if (flags.json) {
    deps.io.out(JSON.stringify({ ok, states: readiness.states }, null, 2))
    return ok ? EXIT.ok : EXIT.failed
  }

  const line = (s: ReadinessState) => `${s.title}: ${s.detail}`
  // Doctor reports everything — that is the difference from init, which acts
  // on one thing. It still names where to start, because a list of five
  // problems in dependency order has an obvious first move and saying so
  // costs nothing.
  if (deps.io.interactive === true && deps.io.check) {
    await deps.io.intro?.('NotifAI doctor')
    for (const s of readiness.states) await deps.io.check(s.status !== 'gap', line(s))
    await deps.io.outro?.(ok ? 'Everything looks good' : `Start with: ${remedyLine(blocker)}`)
  } else {
    for (const s of readiness.states) {
      const mark = s.status === 'gap' ? 'FAIL' : s.status === 'unknown' ? '  ? ' : 'ok  '
      deps.io.out(`${mark}  ${line(s)}`)
    }
    if (!ok) deps.io.out(`\nStart with: ${remedyLine(blocker)}`)
  }
  return ok ? EXIT.ok : EXIT.failed
}

/** One line telling the reader what to actually do about a state. */
function remedyLine(state: ReadinessState): string {
  const remedy = state.remedy
  if (!remedy) return state.detail
  if (remedy.by === 'user-elsewhere') return remedy.summary
  return remedy.command === undefined
    ? remedy.summary
    : `${remedy.summary} — run \`${remedy.command}\``
}

/**
 * Whether the hook installation is internally ready, plus evidence that a
 * project session has fired it before. This cannot prove future execution or
 * end-to-end notification delivery without a live harness and device test.
 *
 * Every failure mode here was found the expensive way, by spawning a session
 * and watching nothing happen: hooks not installed, installed but never fired,
 * or left behind by an older build that named events this one does not serve.
 */
/**
 * Hook diagnostics as readiness states.
 *
 * A thin adapter over `hookChecks`, whose every branch was found the expensive
 * way and is not worth re-deriving. The judgment added here is which failures
 * actually stand in the way.
 *
 * Two do not. A hook that has never fired is the normal condition of an
 * install thirty seconds old, and OpenCode's inability to resume an idle turn
 * is a property of that harness rather than a fault in this setup. Treating
 * either as blocking would mean `init` could never finish for an OpenCode
 * user, or could only finish after a session had already run — so both report
 * as things worth knowing rather than things to fix.
 */
function hookStates(deps: CommandDeps): ReadinessState[] {
  const installations = findInstallations(deps.cwd, deps.env)
  if (installations.length === 0) {
    return [
      {
        id: 'hooks',
        title: 'Question routing',
        status: 'optional-gap',
        detail: 'hooks not installed, so questions stay in the terminal',
        remedy: {
          by: 'cli',
          summary: 'install harness hooks so questions reach your devices when you are away',
          command: 'notifai hooks install',
        },
      },
    ]
  }

  /** Real but not in the way; see the note above. */
  const informational = new Set(['hooks (fired)', 'hooks (opencode continuation)'])
  return hookChecks(deps).map((check) => ({
    id: check.name.replace(/[ ()]+/g, '-').replace(/-$/, ''),
    title: check.name === 'hooks' ? 'Question routing' : check.name,
    status: check.ok ? 'ready' : informational.has(check.name) ? 'optional-gap' : 'gap',
    detail: check.detail,
    ...(check.ok
      ? {}
      : {
          remedy: {
            by: 'user-here' as const,
            summary: 'the detail above names what to change',
            command: 'notifai hooks install',
          },
        }),
  }))
}

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

  const adapterProblems = installations.flatMap((installation) =>
    (installation.problems ?? []).map((problem) => `${installation.file}: ${problem}`),
  )
  if (adapterProblems.length > 0) {
    checks.push({
      name: 'hooks (adapter)',
      ok: false,
      detail: adapterProblems.join('; '),
    })
  }

  // Two checkouts each installing hooks means both fire for the same event, and
  // the user gets every question twice.
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
  checks.push({
    name: 'hooks (fired)',
    ok: fired,
    detail: fired
      ? 'a session in this directory has run them'
      : `no session pointer from the last 24 hours — ${hookActivationAdvice(installations)}`,
  })

  if (installations.some((installation) => installation.harness === 'opencode')) {
    checks.push({
      name: 'hooks (opencode continuation)',
      ok: false,
      detail:
        'question routing is installed, but OpenCode cannot reliably resume an idle agent turn with the answer; use `notifai send --reply` for decisions',
    })
  }

  const stray = codexStrayWorktreeCheck(deps)
  if (stray !== null) checks.push(stray)

  return checks
}

/**
 * A Codex hooks file sitting in a worktree, which Codex will never read.
 *
 * `settingsFile` now writes to the main repository, so this only fires for a
 * file an older build left behind — but that file is indistinguishable from a
 * working install if you go looking, and it is exactly what made this bug take
 * a day to find. Omitted entirely when there is nothing to say.
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
