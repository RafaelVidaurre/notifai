import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { LifecycleEndState, ReplyView } from '@raidiant/notifai-protocol'
import type { ApiClient } from './client.js'
import {
  loadConfig,
  projectSessionPointerPath,
  sanitizeSessionId,
  sessionConfigPath,
  stateDir,
  type CliConfig,
} from './config.js'
import { buildDraft } from './send.js'
import { atomicWriteFileSync } from './atomic-file.js'

/**
 * Harness hook handlers.
 *
 * The supported harnesses expose the same useful lifecycle joints: a turn-end
 * event and an event that fires when the user submits a prompt. Claude Code,
 * Codex, and Cursor can continue directly from a turn-end answer. OpenCode
 * preserves the pending answer at turn end and injects it on the next prompt.
 * No question detection or context-window state is needed in either path.
 *
 * The load-bearing constraint is that these hooks are synchronous: while one
 * blocks, the harness cannot show its own prompt either. So a hook may only
 * take over when the user is demonstrably absent. Present user, or no evidence
 * either way, means exit immediately and let the terminal do its job.
 */

/** Fields we read from harness hook JSON. Everything else is passed through. */
export interface HookEnvelope {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  /** Set by the harness when this Stop follows a previous Stop continuation. */
  stop_hook_active?: boolean
  /** Cursor's stable per-conversation identifier. */
  conversation_id?: string
  /** Cursor's project roots; the first is the hook's configuration root. */
  workspace_roots?: string[]
  /** Cursor increments this after each stop-hook automatic follow-up. */
  loop_count?: number
}

export interface SessionState {
  /** Epoch ms of the user's last prompt in this session — our presence signal. */
  last_prompt_at?: number
  /** Question registered by `notifai ask`, awaiting the turn to end. */
  pending?: PendingQuestion
  /**
   * Questions that have been delivered to the user's devices and are now dead,
   * but whose retirement has not been confirmed yet.
   *
   * A retirement needs a network call and the moment we learn a question is
   * dead is not always a moment we can make one — `notifai ask` supersedes the
   * previous question from a bare shell command, and the machine may be
   * offline. Dropping the ids there is how a delivered question becomes
   * permanently unretirable, so they are parked here instead and every later
   * hook with a client drains them. Retirement is idempotent, so a duplicate
   * attempt costs nothing and a missed one costs a stale notification for ever.
   */
  retiring?: RetiringQuestion[]
  /** Tracks bounded Stop continuations so a follow-up ask is delivered once. */
  continuation?: {
    answered_at: number
    count: number
  }
}

/** A delivered question awaiting its retirement push. */
export interface RetiringQuestion {
  request_id: string
  collapse_key: string
  /** The Device Installations that actually received the question. */
  device_ids: string[]
  /** Shown if the companion has no history entry to correlate against. */
  question: string
  state: LifecycleEndState
}

/**
 * A retirement that outlived its session.
 *
 * Per-session parking assumes some later hook in the SAME session will hold a
 * client, and `SessionEnd` is exactly where that assumption breaks: it may not
 * touch the network, and no hook for that session ever fires again. Deleting
 * the state there lost the only copy of the delivered question's ids, so the
 * phone kept an answerable question nobody was listening to. These entries are
 * moved to a machine-global queue instead, drained by whichever session's hook
 * next holds a client.
 */
export interface OrphanRetirement extends RetiringQuestion {
  /** Label of the session that asked, so the retirement sync matches its badge. */
  session?: string
  /** Epoch ms when the entry was orphaned; entries beyond the TTL are dropped. */
  enqueued_at: number
}

/**
 * Past this, the question's reply window (3600s) has long expired server-side
 * and the companion shows it as dead on next open anyway; pushing a retirement
 * sync for it is noise. Also the backstop that keeps an unreachable server
 * from growing the queue for ever.
 */
const ORPHAN_TTL_MS = 24 * 3600 * 1000

/** More orphans than this means something is looping; keep the newest. */
const ORPHAN_QUEUE_CAP = 50

export interface PendingQuestion {
  question: string
  /**
   * Epoch ms when `notifai ask` registered this. The grace window runs from
   * here, not from the turn's end: a question the agent asked five minutes ago
   * while it kept working has already served its wait in the terminal.
   */
  asked_at?: number
  /**
   * Canonical answer labels, already split and validated by `notifai ask`.
   * Stored as a list rather than a comma-joined string so a label containing a
   * comma survives the round trip.
   */
  choices?: string[]
  /** Set once the question has actually been pushed, so it can be retired. */
  request_id?: string
  collapse_key?: string
  /** Exact fanout of the live question; routing config may change afterwards. */
  device_ids?: string[]
}

/** How often the grace window rechecks whether the user has come back. */
const GRACE_POLL_MS = 5_000

/**
 * Total seconds a Stop hook may spend blocking. Both harnesses kill a command
 * hook at 600s, and a killed hook loses an answer the user has already given,
 * so the grace window yields to the reply wait rather than the other way round.
 */
const STOP_BUDGET_SECONDS = 480

export type GraceOutcome =
  /** The window elapsed with the user still gone; escalate. */
  | 'absent'
  /** The user touched the machine; the terminal is theirs. */
  | 'user-returned'
  /** No idle source, so waiting would hold a terminal we cannot monitor. */
  | 'no-signal'

/**
 * The terminal-first wait: the question sits in the terminal for
 * `ask_grace_seconds` from when it was sent, and only then reaches companion
 * devices.
 *
 * Holding a blocking Stop hook open is normally hostile — while it blocks, the
 * harness cannot show its prompt either, so a user wanting to answer locally is
 * locked out. What makes it safe is that the wait is abandoned the moment the
 * user touches the keyboard or mouse. The block therefore only ever persists
 * while they are demonstrably not using the machine, which costs them nothing.
 *
 * That safety depends entirely on the idle signal, so with no idle source this
 * refuses to wait at all rather than holding a terminal it cannot monitor.
 *
 * With `require_idle` off the whole calculus changes: the user has said they
 * want the question to reach them whether or not they are at the keyboard, so
 * there is nothing to watch for and this becomes what its name always claimed —
 * a plain timer. It then works on machines with no idle source too.
 */
export async function awaitGrace(ctx: HookContext, askedAt: number): Promise<GraceOutcome> {
  const threshold = ctx.config.away_after_seconds.value
  // Never let the grace window eat the reply wait's share of the hook budget.
  const graceSeconds = Math.min(
    ctx.config.ask_grace_seconds.value,
    Math.max(0, STOP_BUDGET_SECONDS - ctx.config.hook_reply_timeout_seconds.value),
  )
  // `asked_at` is wall-clock too, and the same jumps apply: a stamp from the
  // future would wait far past the hook's budget, one from the distant past
  // would skip the terminal-first window the user asked for entirely. Anything
  // outside a plausible range restarts the window from now.
  const elapsed = ctx.now() - askedAt
  const start = elapsed >= 0 && elapsed <= MAX_PLAUSIBLE_SILENCE_MS ? askedAt : ctx.now()
  const deadline = start + graceSeconds * 1000

  for (;;) {
    if (ctx.config.require_idle.value) {
      const idle = ctx.idleSeconds()
      if (idle === null) return 'no-signal'
      if (idle < threshold) return 'user-returned'
    }
    if (ctx.now() >= deadline) return 'absent'
    await ctx.sleep(Math.min(GRACE_POLL_MS, Math.max(0, deadline - ctx.now())))
  }
}

export interface HookOutcome {
  /** Written to stdout verbatim — the harness parses this as the decision. */
  stdout?: string
  /** Diagnostics; harnesses surface hook stderr in the transcript. */
  notes: string[]
}

function sessionStatePath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.json`)
}

export function readSessionState(sessionId: string, env: NodeJS.ProcessEnv): SessionState {
  const file = sessionStatePath(sessionId, env)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as SessionState) : {}
  } catch {
    // A corrupt marker must not wedge the harness; treat it as "no evidence",
    // which fails closed onto ordinary terminal behaviour.
    return {}
  }
}

export function writeSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  state: SessionState,
): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => writeSessionStateUnlocked(file, state))
}

export function clearSessionState(sessionId: string, env: NodeJS.ProcessEnv): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => {
    rmSync(file, { force: true })
    // The session override lives in a sibling file; leaving it behind meant a
    // later session reusing the id silently inherited `ask_notifications = false`.
    rmSync(sessionConfigPath(sessionId, env), { force: true })
  })
}

function writeSessionStateUnlocked(file: string, state: SessionState): void {
  atomicWriteFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

function updateSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  update: (current: SessionState) => SessionState,
): SessionState {
  const file = sessionStatePath(sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    const next = update(readSessionState(sessionId, env))
    writeSessionStateUnlocked(file, next)
    return next
  })
}

/**
 * Serialize a short read-modify-write without ever exposing partial JSON.
 * A crashed holder is recoverable after 30 seconds; releases compare their
 * random token under the same cooperating lock discipline before unlinking.
 */
const FILE_LOCK_STALE_MS = 30_000
const FILE_LOCK_WAIT_MS = 1_000
const FILE_LOCK_POLL_MS = 5
const lockSleep = new Int32Array(new SharedArrayBuffer(4))

function withFileLock<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true })
  const token = randomBytes(12).toString('base64url')
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      try {
        writeFileSync(handle, `${JSON.stringify({ token, at: Date.now() })}\n`)
      } finally {
        closeSync(handle)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }
        stale = typeof held.at !== 'number' || Date.now() - held.at >= FILE_LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (stale) rmSync(file, { force: true })
      else if (Date.now() >= deadline) throw new Error(`timed out waiting for state lock ${file}`)
      else Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  }
  try {
    return action()
  } finally {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (held.token === token) rmSync(file, { force: true })
    } catch {
      // A replaced or externally removed lock is no longer ours to release.
    }
  }
}

/**
 * Session state a crashed harness left behind.
 *
 * `SessionEnd` removes both the marker and the session override, but a harness
 * that crashes or is killed never reaches it. At roughly a hundred sessions a
 * day that is tens of thousands of files a year, none of which anything reads.
 *
 * Opportunistic rather than scheduled: hooks are the only thing that runs, so
 * a hook is where this has to live. It is rate-limited by its own stamp file
 * so the common case costs one `stat`, not a directory walk — a Stop hook is
 * on the critical path of every turn.
 */
const SESSION_PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000
const SESSION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000

export function pruneAbandonedSessions(
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  maxAgeMs: number = SESSION_PRUNE_AFTER_MS,
): number {
  const directory = path.join(stateDir(env), 'sessions')
  const stamp = path.join(stateDir(env), 'last-prune')
  try {
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < SESSION_PRUNE_INTERVAL_MS) return 0
    mkdirSync(path.dirname(stamp), { recursive: true })
    writeFileSync(stamp, '', { mode: 0o600 })
    if (!existsSync(directory)) return 0

    let removed = 0
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name)
      try {
        const age = now - statSync(file).mtimeMs
        // A negative age means the clock moved, not that the file is old.
        // Deleting live session state on an NTP correction would lose a
        // question already on the user's phone.
        if (age <= maxAgeMs) continue
        rmSync(file, { force: true })
        removed += 1
      } catch {
        // A file that vanished under us, or one we may not read. Neither is
        // worth failing a hook for, and the next pass will see it again.
      }
    }
    return removed
  } catch {
    // Housekeeping must never be the reason a turn fails.
    return 0
  }
}

/**
 * One question, one push, even with two Stop hooks racing.
 *
 * Path-independent hook ownership stops the *usual* cause of two handlers
 * firing, but it cannot stop every one — two harnesses in one directory, or an
 * install this build does not recognise. Both processes would read the same
 * pending question, see no `request_id`, and both escalate: one question, two
 * notifications.
 *
 * Exclusive create is atomic on POSIX, so exactly one process gets the claim
 * and the other steps aside. A short guard serializes stale replacement with
 * contenders and releases; random ownership tokens keep an old holder from
 * unlinking its replacement. A claim older than the hook budget is a crashed
 * process rather than a live one and is broken, avoiding permanent suppression.
 */
const CLAIM_TTL_MS = STOP_BUDGET_SECONDS * 1000
const heldClaims = new Map<string, string>()

export function claimQuestionPush(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  beforeStaleReplace?: () => void,
): boolean {
  const file = claimPath(sessionId, env)
  const guard = `${file}.guard`
  const token = randomBytes(12).toString('base64url')
  mkdirSync(path.dirname(file), { recursive: true })
  if (!acquireClaimGuard(guard)) return false
  try {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: now, token })}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      heldClaims.set(file, token)
      return true
    } catch {
      // Held. Break it only if whoever holds it cannot still be running.
      try {
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }
        const age = typeof held.at === 'number' ? now - held.at : Number.POSITIVE_INFINITY
        if (age >= 0 && age < CLAIM_TTL_MS) return false
      } catch {
        // Unreadable or corrupt: treat as abandoned.
      }
      beforeStaleReplace?.()
      rmSync(file, { force: true })
      try {
        writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: now, token })}\n`, {
          mode: 0o600,
          flag: 'wx',
        })
        heldClaims.set(file, token)
        return true
      } catch {
        return false
      }
    }
  } finally {
    rmSync(guard, { force: true })
  }
}

export function releaseQuestionPush(sessionId: string, env: NodeJS.ProcessEnv): void {
  const file = claimPath(sessionId, env)
  const token = heldClaims.get(file)
  if (token === undefined) return
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard)) {
    heldClaims.delete(file)
    return
  }
  try {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (held.token === token) rmSync(file, { force: true })
    } catch {
      // Missing or replaced claims are not ours to release.
    }
  } finally {
    heldClaims.delete(file)
    rmSync(guard, { force: true })
  }
}

/** The guard serializes stale replacement and release; recover a crashed guard. */
function acquireClaimGuard(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      closeSync(handle)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(file).mtimeMs < CLAIM_TTL_MS) return false
      } catch {
        // A vanished/corrupt guard is safe to retry once.
      }
      rmSync(file, { force: true })
    }
  }
  return false
}

function claimPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.claim`)
}

/**
 * A question is stored so a later hook can push it, and it reaches us from a
 * shell command, so its size is whatever the agent typed. The push itself is
 * bounded by the 4096-byte APNs envelope; this bounds what sits on disk in the
 * meantime, and keeps one runaway agent from writing megabytes per session.
 */
const MAX_STORED_QUESTION_CHARS = 2000

/** Records which session is working in a directory, for `notifai ask`. */
export function writeProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  now: number,
  harness: HookHarness,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    atomicWriteFileSync(
      file,
      `${JSON.stringify({ session_id: sessionId, updated_at: now, harness })}\n`,
    )
  })
}

export interface ProjectSessionPointer {
  sessionId: string
  harness: HookHarness
}

/**
 * Resolves the session working in `cwd`. Stale pointers are ignored rather than
 * trusted: an id left by a session that ended days ago would send the question
 * into state nothing is watching.
 */
export function readProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): string | null {
  return readProjectSessionPointer(cwd, env, now, maxAgeMs)?.sessionId ?? null
}

export function readProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const file = projectSessionPointerPath(cwd, env)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      session_id?: unknown
      updated_at?: unknown
      harness?: unknown
    }
    if (typeof parsed.session_id !== 'string' || parsed.session_id === '') return null
    if (typeof parsed.updated_at !== 'number' || now - parsed.updated_at > maxAgeMs) return null
    if (!(HOOK_HARNESSES as readonly unknown[]).includes(parsed.harness)) return null
    // A pointer is routing evidence only while its session state still exists
    // and parses. SessionEnd and explicit cleanup therefore invalidate it even
    // when a crash prevented the pointer file itself from being removed.
    const sessionFile = sessionStatePath(parsed.session_id, env)
    if (!existsSync(sessionFile)) return null
    const state: unknown = JSON.parse(readFileSync(sessionFile, 'utf8'))
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return null
    return { sessionId: parsed.session_id, harness: parsed.harness as HookHarness }
  } catch {
    return null
  }
}

const HOOK_HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode'] as const

function clearMatchingProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { session_id?: unknown }
      if (parsed.session_id === sessionId) rmSync(file, { force: true })
    } catch {
      // Missing/corrupt is already not a live pointer.
    }
  })
}

/**
 * Absent means the user is not at this machine's keyboard.
 *
 * OS idle time answers that directly, so where it exists it decides alone.
 * Silence since the user's last prompt is only ever a proxy for it, and a poor
 * one — it is wrong in both directions:
 *
 *   - Too long: it counts the agent's own turn, so a user watching a build was
 *     read as absent and had the question pushed at them.
 *   - Too short: a session that has just been spawned always has a fresh
 *     prompt, so its FIRST question could never escalate however long its
 *     owner had been gone. That is the "kick off some agents and
 *     walk away" case this feature mainly exists for, and requiring both
 *     signals to agree is what broke it.
 *
 * The proxy therefore survives only as the fallback for machines with no idle
 * source. There, never having seen a prompt is not evidence of absence — it is
 * a missing `UserPromptSubmit` hook — so it resolves to "present".
 *
 * Answering from a companion device does not make the user present; only touching this
 * machine does. Answering on a device is evidence of being away from it.
 *
 * All of which only matters if presence is being consulted at all. With
 * `require_idle` off the user has said their whereabouts are not a
 * precondition, so this stops guessing and answers yes.
 */
export function isUserAway(
  state: SessionState,
  config: CliConfig,
  now: number,
  idleSeconds: number | null,
): boolean {
  if (!config.require_idle.value) return true
  const threshold = config.away_after_seconds.value
  if (idleSeconds !== null) return idleSeconds >= threshold
  if (state.last_prompt_at === undefined) return false
  const silence = now - state.last_prompt_at
  // Both signs of a clock jump produce a wrong answer here, and the fallback
  // path has no monotonic reference to check against: a forward jump (NTP
  // correction, VM resume) hijacks a terminal whose user is sitting right
  // there, and a backward one suppresses escalation for someone genuinely
  // gone. Neither delta is evidence of anything, so it resolves the way every
  // other absence of evidence does — present.
  if (silence < 0 || silence > MAX_PLAUSIBLE_SILENCE_MS) return false
  return silence >= threshold * 1000
}

/**
 * Beyond this, silence says more about the clock or an abandoned session file
 * than about the user. Matches the project pointer's staleness horizon.
 */
const MAX_PLAUSIBLE_SILENCE_MS = 24 * 3600 * 1000

export interface HookContext {
  client: ApiClient
  config: CliConfig
  env: NodeJS.ProcessEnv
  now: () => number
  /** Seconds since the last keyboard/mouse event, or null if unknowable. */
  idleSeconds: () => number | null
  /** Injected so tests advance a virtual clock instead of sleeping. */
  sleep: (milliseconds: number) => Promise<void>
  /** Bounded wait for the first reply; injected so tests do not sleep. */
  waitForFirstReply: (
    requestId: string,
    timeoutSeconds: number,
  ) => Promise<{ replies: ReplyView[]; timedOut: boolean; degraded?: boolean }>
  /** OpenCode cannot consume Stop stdout, so its adapter must never wait there. */
  harness?: HookHarness
}

export type HookHarness = 'claude-code' | 'codex' | 'cursor' | 'opencode'

interface AskResult {
  requestId: string
  collapseKey: string
  reply: ReplyView | null
  /** The devices the question went to; retirement must not reach any other. */
  devices: string[]
  /** The wait ended amid network failures, so "no answer" is unproven. */
  degraded: boolean
  /** False when the harness cannot consume a Stop answer and polling was skipped. */
  waited: boolean
  /** The user returned to this machine after the question was pushed. */
  userReturned: boolean
}

/** Re-check local presence at this cadence while a pushed question is waiting. */
const REPLY_PRESENCE_POLL_SECONDS = 5

/**
 * Push a question and block for the answer.
 *
 * An answered question is closed immediately: the first answer wins, and the
 * other devices must stop offering to change it. An unanswered one stays open,
 * because nobody has acted on the silence yet and the next turn can still
 * collect the answer with `notifai replies`.
 */
async function askAndWait(
  ctx: HookContext,
  options: {
    title: string
    body: string
    choices?: string[]
    event: string
    /** Which agent is asking; two of them must not look alike. */
    session?: string | undefined
    /** How long the server keeps accepting an answer. */
    windowSeconds: number
    /** Called once the question is live, before the block begins. */
    onSubmitted?: (live: { requestId: string; collapseKey: string; devices: string[] }) => void
  },
): Promise<AskResult | { error: string }> {
  const collapseKey = `notifai-hook-${randomBytes(8).toString('base64url')}`
  const timeoutSeconds = ctx.config.hook_reply_timeout_seconds.value
  // A draft carrying `reply` is rejected outright if it targets a device that
  // cannot answer, so resolve the healthy companion platforms explicitly.
  const answerable = await answerableDevices(ctx)
  if (answerable.length === 0) {
    return { error: 'no device can answer a question yet; leaving this to the terminal' }
  }
  const build = buildDraft(ctx.config, {
    title: options.title,
    body: options.body,
    event: options.event,
    lifecycle: { tier: 'needs_you' },
    ...(options.session !== undefined ? { session: options.session } : {}),
    device: answerable,
    reply: true,
    replyWindow: Math.max(60, options.windowSeconds),
    ...(options.choices !== undefined ? { replyChoice: options.choices } : {}),
    collapseKey,
    level: 'time_sensitive',
  })
  if (!build.ok) return { error: build.error }

  const receipt = await ctx.client.submit(
    { idempotency_key: `hook-${randomBytes(12).toString('base64url')}`, draft: build.draft },
    0,
  )
  // Record what is now live on the user's devices BEFORE blocking. If we only
  // learned these ids after the wait, a question that timed out would leave no
  // trace, and the user returning to the terminal could never retire it — the
  // notification would stay answerable for an hour with nobody listening.
  options.onSubmitted?.({
    requestId: receipt.request_id,
    collapseKey,
    devices: answerable,
  })
  if (ctx.harness === 'opencode') {
    return {
      requestId: receipt.request_id,
      collapseKey,
      reply: null,
      devices: answerable,
      degraded: false,
      waited: false,
      userReturned: false,
    }
  }

  const result = await waitForReplyWhileAway(ctx, receipt.request_id, timeoutSeconds)
  if (result.replies.length > 0) await closeQuietly(ctx, receipt.request_id)
  return {
    requestId: receipt.request_id,
    collapseKey,
    reply: result.replies[0] ?? null,
    devices: answerable,
    degraded: result.degraded,
    waited: true,
    userReturned: result.userReturned,
  }
}

async function waitForReplyWhileAway(
  ctx: HookContext,
  requestId: string,
  timeoutSeconds: number,
): Promise<{ replies: ReplyView[]; degraded: boolean; userReturned: boolean }> {
  const deadline = ctx.now() + timeoutSeconds * 1000
  let degraded = false
  let firstPoll = true

  for (;;) {
    if (ctx.config.require_idle.value) {
      const idle = ctx.idleSeconds()
      if (idle !== null && idle < ctx.config.away_after_seconds.value) {
        return { replies: [], degraded, userReturned: true }
      }
    }

    const remainingMs = Math.max(0, deadline - ctx.now())
    if (!firstPoll && remainingMs === 0) {
      return { replies: [], degraded, userReturned: false }
    }
    firstPoll = false
    const pollSeconds = Math.min(
      REPLY_PRESENCE_POLL_SECONDS,
      Math.max(0, Math.ceil(remainingMs / 1000)),
    )
    const result = await ctx.waitForFirstReply(requestId, pollSeconds)
    degraded ||= result.degraded === true
    if (result.replies.length > 0) {
      return { replies: result.replies, degraded, userReturned: false }
    }
  }
}

/**
 * Healthy companion devices that implement replies. Both the iOS app and the
 * macOS app register reply categories and submit answers directly.
 */
async function answerableDevices(ctx: HookContext): Promise<string[]> {
  const configured = ctx.config.devices.value
  const { devices } = await ctx.client.listDevices()
  return devices
    .filter(
      (device) =>
        (device.platform === 'ios' || device.platform === 'macos') &&
        device.registration_healthy,
    )
    .filter((device) => configured === null || configured.includes(device.device_id))
    .map((device) => device.device_id)
}

/**
 * The session id this push is attributed to — the same one `send` carries.
 *
 * The hook has always known `session_id` and never passed it on, so two agents
 * in separate worktrees produced identical notifications and the user could
 * answer the wrong one's question. An exported `NOTIFAI_SESSION`
 * still wins, for coherence rather than vanity: it is THE session id wherever
 * it is set, so a session that exported one before launching must carry
 * the same on its own sends and on the questions its hooks push. A name the
 * user chose also outlives harness restarts, which a per-launch UUID cannot.
 */
function sessionLabel(ctx: HookContext, envelope: HookEnvelope): string | undefined {
  const explicit = ctx.env['NOTIFAI_SESSION']
  if (explicit !== undefined && explicit !== '') return explicit
  return envelope.session_id
}

/**
 * Everything retirement needs. Narrower than a HookContext on purpose:
 * `notifai ask` supersedes the previous question and it is a plain command with
 * no hook payload, no idle probe and nothing to sleep for.
 */
export type RetireDeps = Pick<HookContext, 'client' | 'config'>

/** Best effort: a question that outlives its hook is a nuisance, not a failure. */
async function closeQuietly(ctx: RetireDeps, requestId: string): Promise<void> {
  try {
    await ctx.client.closeReplies(requestId)
  } catch {
    // The window expires on its own; nothing here is worth failing a hook for.
  }
}

/**
 * Retire the question on every device it reached. A state change is not news
 * (D-B): the retirement rides as a background state sync — no alert, no
 * sound — carrying the shared collapse key so the companion removes the
 * delivered question and marks it done. If the app cannot run, the stale
 * question simply waits until next open, which beats a tombstone banner
 * announcing what the user just did.
 */
async function retire(
  ctx: RetireDeps,
  collapseKey: string,
  title: string,
  body: string,
  endState: LifecycleEndState,
  retiresRequestId: string,
  devices?: string[],
  session?: string | undefined,
): Promise<boolean> {
  const build = buildDraft(ctx.config, {
    title,
    body,
    event: 'question_retired',
    lifecycle: { tier: 'done', state: endState, retires_request_id: retiresRequestId },
    ...(session !== undefined ? { session } : {}),
    ...(devices !== undefined && devices.length > 0 ? { device: devices } : {}),
    collapseKey,
    level: 'passive',
  })
  if (!build.ok) return false
  try {
    await ctx.client.submit(
      { idempotency_key: `retire-${randomBytes(12).toString('base64url')}`, draft: build.draft },
      0,
    )
    return true
  } catch {
    // Same reasoning as closeQuietly: the window is already closed server-side.
    return false
  }
}

/**
 * The title a retirement carries. It is never rendered as a banner — the push
 * is `content-available` only — but it is what a companion with no matching
 * history entry has to fall back on, and it is what shows in server-side logs.
 */
const RETIREMENT_TITLES: Record<LifecycleEndState, string> = {
  answered: 'Answered',
  answered_elsewhere: 'Answered in the terminal',
  expired: 'Question expired',
  superseded: 'Replaced by a newer question',
}

/**
 * Park a delivered question for retirement. Called at the moment we learn it is
 * dead, which is frequently not a moment we can reach the network.
 *
 * Nothing is parked for a question that never reached a device: with no
 * request_id there is nothing on any device to retire.
 */
export function parkForRetirement(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  pending: PendingQuestion,
  state: LifecycleEndState,
): void {
  const retirement = retiringQuestion(pending, state)
  if (retirement === null) return
  updateSessionState(sessionId, env, (current) => {
    const already = current.retiring ?? []
    const existing = already.findIndex((entry) => entry.request_id === retirement.request_id)
    if (existing < 0) return { ...current, retiring: [...already, retirement] }
    const retiring = [...already]
    // An observed answer is final truth and upgrades an earlier supersession
    // parked while the submission callback was racing a newer question.
    if (retirement.state === 'answered' && retiring[existing]!.state !== 'answered') {
      retiring[existing] = retirement
    }
    return { ...current, retiring }
  })
}

/**
 * Convert live question state into a complete retirement instruction.
 *
 * A request/collapse pair without the original Delivery targets is not safe to
 * send: re-resolving today's routing can miss a device that still shows the
 * question or retire a device that never received it. Fail explicitly and keep
 * the pending record instead of silently broadening or narrowing the fanout.
 */
function retiringQuestion(
  pending: PendingQuestion,
  state: LifecycleEndState,
): RetiringQuestion | null {
  const hasRequest = pending.request_id !== undefined
  const hasCollapse = pending.collapse_key !== undefined
  const hasDevices = pending.device_ids !== undefined && pending.device_ids.length > 0
  if (!hasRequest && !hasCollapse && !hasDevices) return null
  if (!hasRequest || !hasCollapse || !hasDevices) {
    throw new Error(
      'live question state is incomplete; refusing to retire it without request, collapse, and device identifiers',
    )
  }
  return {
    request_id: pending.request_id!,
    collapse_key: pending.collapse_key!,
    device_ids: [...pending.device_ids!],
    question: pending.question,
    state,
  }
}

function retirementDeviceIds(entry: RetiringQuestion): string[] {
  if (!Array.isArray(entry.device_ids) || entry.device_ids.length === 0) {
    throw new Error(
      `retirement for ${entry.request_id} is missing its device identifiers; refusing to re-resolve routing`,
    )
  }
  return entry.device_ids
}

/**
 * Send every parked retirement, and forget the ones that landed. A failure
 * leaves the entry in place for the next hook rather than losing it, which is
 * the whole reason the queue exists.
 */
export async function drainRetirements(
  ctx: RetireDeps,
  sessionId: string,
  env: NodeJS.ProcessEnv,
  session?: string | undefined,
): Promise<string[]> {
  const queue = readSessionState(sessionId, env).retiring ?? []
  if (queue.length === 0) return []

  const retired: string[] = []
  for (const entry of queue) {
    await closeQuietly(ctx, entry.request_id)
    const sent = await retire(
      ctx,
      entry.collapse_key,
      RETIREMENT_TITLES[entry.state],
      entry.question,
      entry.state,
      entry.request_id,
      retirementDeviceIds(entry),
      session,
    )
    if (sent) {
      retired.push(entry.request_id)
      // Persist each success before touching the next entry. A later corrupt
      // record or interrupted process must not resurrect work already done.
      updateSessionState(sessionId, env, (current) => ({
        ...current,
        retiring: (current.retiring ?? []).filter(
          (candidate) => candidate.request_id !== entry.request_id,
        ),
      }))
    }
  }
  return retired
}

function orphanQueuePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'retire-queue.json')
}

function readOrphanQueue(env: NodeJS.ProcessEnv): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as OrphanRetirement[]) : []
  } catch {
    // Same stance as session state: corruption fails closed to "nothing queued".
    return []
  }
}

function writeOrphanQueueUnlocked(file: string, queue: OrphanRetirement[]): void {
  atomicWriteFileSync(file, `${JSON.stringify(queue, null, 2)}\n`)
}

function updateOrphanQueue(
  env: NodeJS.ProcessEnv,
  update: (current: OrphanRetirement[]) => OrphanRetirement[],
): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  return withFileLock(`${file}.lock`, () => {
    const next = update(readOrphanQueue(env))
    writeOrphanQueueUnlocked(file, next)
    return next
  })
}

/** Move retirements into the global queue; deduped so a retry costs nothing. */
export function orphanRetirements(
  env: NodeJS.ProcessEnv,
  entries: RetiringQuestion[],
  session: string | undefined,
  now: number,
): void {
  if (entries.length === 0) return
  updateOrphanQueue(env, (queue) => {
    const known = new Set(queue.map((entry) => entry.request_id))
    const added = entries
      .filter((entry) => !known.has(entry.request_id))
      .map((entry) => ({
        ...entry,
        ...(session !== undefined ? { session } : {}),
        enqueued_at: now,
      }))
    return [...queue, ...added].slice(-ORPHAN_QUEUE_CAP)
  })
}

/**
 * Retire everything a dead session left behind. Failures stay queued for the
 * next holder of a client; entries past the TTL are dropped as already dead.
 */
export async function drainOrphanRetirements(
  ctx: RetireDeps,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<string[]> {
  const queue = readOrphanQueue(env)
  if (queue.length === 0) return []

  const done: string[] = []
  for (const entry of queue) {
    const age = now - entry.enqueued_at
    // A negative age is a clock jump, not a fresh entry; retiring is idempotent
    // and cheap, so treat it as due rather than letting it linger for ever.
    if (age > ORPHAN_TTL_MS) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
      continue
    }
    await closeQuietly(ctx, entry.request_id)
    const sent = await retire(
      ctx,
      entry.collapse_key,
      RETIREMENT_TITLES[entry.state],
      entry.question,
      entry.state,
      entry.request_id,
      retirementDeviceIds(entry),
      entry.session,
    )
    if (sent) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
    }
  }
  return done
}

const LATE_STOP_POLL_SECONDS = 4
const LATE_PROMPT_POLL_SECONDS = 3
const MAX_CONTINUATION_COUNT = 3

interface PendingPoll {
  reply: ReplyView | null
  degraded: boolean
  failed: boolean
}

/** One bounded recovery poll for a question that outlived its original wait. */
async function pollPendingReply(
  ctx: HookContext,
  pending: PendingQuestion,
  timeoutSeconds: number,
): Promise<PendingPoll> {
  if (pending.request_id === undefined) return { reply: null, degraded: false, failed: false }
  try {
    const result = await ctx.waitForFirstReply(pending.request_id, timeoutSeconds)
    return {
      reply: result.replies[0] ?? null,
      degraded: result.degraded === true,
      failed: false,
    }
  } catch {
    return { reply: null, degraded: true, failed: true }
  }
}

function answerContext(reply: ReplyView): string {
  return `Notifai — the user answered from ${reply.device_name}: "${reply.text}". Continue with that answer.`
}

function userPromptAnswerOutput(reply: ReplyView): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: answerContext(reply),
    },
  })
}

function stopAnswerOutput(reply: ReplyView): string {
  return JSON.stringify({ decision: 'block', reason: answerContext(reply) })
}

/**
 * Close, truthfully retire, and forget one answered pending question without
 * dropping any other retirement debt. Stop answers also open one bounded
 * continuation generation; UserPromptSubmit answers ride the user's new turn.
 */
async function finishPendingAnswer(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  pending: PendingQuestion,
  reply: ReplyView,
  continuation: boolean,
): Promise<void> {
  const retirement = retiringQuestion(pending, 'answered')
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    if (retirement !== null) {
      const existing = retiring.findIndex((entry) => entry.request_id === retirement.request_id)
      if (existing < 0) retiring.push(retirement)
      else retiring[existing] = retirement
    }
    const samePending =
      current.pending?.question === pending.question &&
      current.pending?.asked_at === pending.asked_at &&
      current.pending?.request_id === pending.request_id
    const next = { ...current, retiring }
    if (samePending) delete next.pending
    if (continuation) {
      next.continuation = {
        answered_at: ctx.now(),
        count:
          (envelope.stop_hook_active === true ? current.continuation?.count ?? 0 : 0) + 1,
      }
    } else {
      next.last_prompt_at = ctx.now()
    }
    return next
  })
  await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — the user is at the keyboard
// ---------------------------------------------------------------------------

/**
 * Records presence and retires anything still asking on companion devices. This is the
 * "answered in the terminal" case from the original design: we cannot tell
 * whether the new prompt answers the question, but we do not need to — the
 * user being here is what makes the notification noise.
 */
export async function handleUserPromptSubmit(
  ctx: HookContext,
  envelope: HookEnvelope,
): Promise<HookOutcome> {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes }

  const state = readSessionState(sessionId, ctx.env)
  const pending = state.pending
  if (pending?.request_id !== undefined) {
    const late = await pollPendingReply(ctx, pending, LATE_PROMPT_POLL_SECONDS)
    if (late.reply !== null) {
      await finishPendingAnswer(ctx, envelope, sessionId, pending, late.reply, false)
      if (envelope.cwd !== undefined && ctx.harness !== undefined) {
        writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
      }
      await drainOrphanRetirements(ctx, ctx.env, ctx.now())
      notes.push(`late answer from ${late.reply.device_name}: ${late.reply.text}`)
      return { stdout: userPromptAnswerOutput(late.reply), notes }
    }
    if (late.failed || late.degraded) {
      notes.push('could not check the pending question for a late answer before the prompt')
    }
  }
  // Park before dropping `pending`. If the process dies between these writes,
  // the next hook sees both copies and dedupes them; the old order could die in
  // the gap after erasing the only request/collapse/device identifiers.
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    if (current.pending !== undefined) {
      const retirement = retiringQuestion(current.pending, 'answered_elsewhere')
      if (
        retirement !== null &&
        !retiring.some((entry) => entry.request_id === retirement.request_id)
      ) {
        retiring.push(retirement)
      }
    }
    return { last_prompt_at: ctx.now(), ...(retiring.length > 0 ? { retiring } : {}) }
  })
  // The bridge that lets a plain `notifai ask` find the hook's canonical
  // session: an agent shell command gets no hook payload, and not every
  // harness exports an id in the same shape.
  if (envelope.cwd !== undefined && ctx.harness !== undefined) {
    writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
  }

  const retired = await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))
  const orphaned = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  const swept = [...retired, ...orphaned]
  if (swept.length > 0) {
    notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }
  return { notes }
}

// ---------------------------------------------------------------------------
// Stop — the turn ended; escalate a registered question
// ---------------------------------------------------------------------------

/**
 * How long an escalated question keeps accepting an answer after the turn
 * ended. Long enough to survive a walk away from the desk, short enough that a
 * forgotten question does not resurface days later as a live prompt.
 */
const QUESTION_WINDOW_SECONDS = 3600

/**
 * Only engages for a question the agent explicitly registered with
 * `notifai ask`. Guessing from the last assistant message was the alternative
 * and it is not worth it: a false positive here hijacks the terminal.
 */
export async function handleStop(ctx: HookContext, envelope: HookEnvelope): Promise<HookOutcome> {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes }

  // Anything retired since the last hook is still live on the devices. This
  // runs before every early return below, including the nagging guard: a queued
  // retirement has nothing to do with whether *this* turn has a question to
  // escalate, and the turn that supersedes a question is very often the one
  // continuing from the previous answer.
  const swept = [
    ...(await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))),
    ...(await drainOrphanRetirements(ctx, ctx.env, ctx.now())),
  ]
  if (swept.length > 0) {
    notes.push(`retired superseded question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }

  const state = readSessionState(sessionId, ctx.env)
  const pending = state.pending
  if (!pending) return { notes }
  if (pending.request_id !== undefined) {
    const late = await pollPendingReply(ctx, pending, LATE_STOP_POLL_SECONDS)
    if (late.reply !== null) {
      await finishPendingAnswer(ctx, envelope, sessionId, pending, late.reply, true)
      notes.push(`late answer from ${late.reply.device_name}: ${late.reply.text}`)
      return { stdout: stopAnswerOutput(late.reply), notes }
    }
    // Already live on the user's devices from an earlier Stop; asking twice for
    // one question is the nagging failure this feature exists to avoid.
    notes.push(
      late.failed || late.degraded
        ? `already asked (${pending.request_id}); could not check whether its answer arrived`
        : `already asked (${pending.request_id}); waiting for that answer`,
    )
    return { notes }
  }

  // A Stop answer may immediately produce a legitimate follow-up question.
  // Allow that new generation, but never re-run an old pending question and
  // never let answer continuations become an unbounded agent loop.
  if (envelope.stop_hook_active === true) {
    const continuation = state.continuation
    const isNew =
      continuation !== undefined &&
      pending.asked_at !== undefined &&
      pending.asked_at > continuation.answered_at
    if (!isNew) {
      notes.push('already continuing from an answer; not asking again this turn')
      return { notes }
    }
    if (continuation.count >= MAX_CONTINUATION_COUNT) {
      notes.push(
        `answer continuation limit (${MAX_CONTINUATION_COUNT}) reached; leaving the question in the terminal`,
      )
      return { notes }
    }
  }
  if (!ctx.config.ask_notifications.value) return { notes }
  if (!isUserAway(state, ctx.config, ctx.now(), ctx.idleSeconds())) {
    notes.push('you are at the keyboard; leaving the question in the terminal')
    return { notes }
  }

  // Claim before the grace window, not after: two racing hooks would otherwise
  // both wait, both find the user still absent, and both push.
  // Real clock, deliberately, not `ctx.now` — the claim answers "is another
  // process alive right now", which the injectable clock cannot speak to. It
  // is also the only clock the *other* process shares.
  if (!claimQuestionPush(sessionId, ctx.env)) {
    notes.push('another hook is already handling this question')
    return { notes }
  }
  try {
    return await escalate(ctx, envelope, sessionId, pending, notes)
  } finally {
    releaseQuestionPush(sessionId, ctx.env)
  }
}

/** The escalation itself, split out so the claim is released on every path. */
async function escalate(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  pending: PendingQuestion,
  notes: string[],
): Promise<HookOutcome> {
  // Away right now, but the question still owes the user its terminal-first
  // window before anything reaches their devices.
  const grace = await awaitGrace(ctx, pending.asked_at ?? ctx.now())
  if (grace === 'user-returned') {
    notes.push('you came back before the wait elapsed; leaving the question in the terminal')
    return { notes }
  }
  if (grace === 'no-signal') {
    notes.push('no idle signal on this machine; asking now rather than holding the terminal')
  }

  const asked = await askAndWait(ctx, {
    title: 'A question from your agent',
    body: pending.question,
    ...(pending.choices !== undefined ? { choices: pending.choices } : {}),
    event: 'agent_question',
    session: sessionLabel(ctx, envelope),
    // Outlives the block, and stays open on purpose: the answer is still
    // useful to the next turn, which collects it with `notifai replies`.
    windowSeconds: QUESTION_WINDOW_SECONDS,
    onSubmitted: (live) => {
      const livePending: PendingQuestion = {
        ...pending,
        request_id: live.requestId,
        collapse_key: live.collapseKey,
        device_ids: live.devices,
      }
      updateSessionState(sessionId, ctx.env, (current) => {
        const stillCurrent =
          current.pending?.question === pending.question &&
          current.pending?.asked_at === pending.asked_at &&
          current.pending?.request_id === undefined
        if (stillCurrent) return { ...current, pending: livePending }

        // A newer `notifai ask` won while this submit was in flight. Keep it,
        // but now that request identifiers exist, preserve the old delivered
        // question as collectable/retirable instead of overwriting either one.
        const retirement = retiringQuestion(livePending, 'superseded')!
        const retiring = [...(current.retiring ?? [])]
        if (!retiring.some((entry) => entry.request_id === retirement.request_id)) {
          retiring.push(retirement)
        }
        return { ...current, retiring }
      })
    },
  })
  if ('error' in asked) {
    notes.push(asked.error)
    return { notes }
  }

  if (!asked.reply) {
    // Keep the pending record so a returning user's UserPromptSubmit can retire
    // the notification that is still live on their devices. `request_id` being
    // set is also what stops the next Stop pushing the same question again.
    if (!asked.waited) {
      notes.push(
        `question sent without blocking OpenCode; retrieve the answer on the next prompt or with: notifai replies --pending`,
      )
    } else if (asked.userReturned) {
      notes.push(
        `you came back after the question was sent; returning the terminal while it stays answerable (${asked.requestId}). ` +
          'Retrieve it with: notifai replies --pending',
      )
    } else {
      notes.push(
        asked.degraded
          ? `could not reach the server to find out whether you answered; check with: notifai replies --pending`
          : `no answer in time; retrieve it later with: notifai replies --pending`,
      )
    }
    return { notes }
  }

  await finishPendingAnswer(ctx, envelope, sessionId, {
    ...pending,
    request_id: asked.requestId,
    collapse_key: asked.collapseKey,
    device_ids: asked.devices,
  }, asked.reply, true)
  notes.push(`answer from ${asked.reply.device_name}: ${asked.reply.text}`)
  return {
    stdout: stopAnswerOutput(asked.reply),
    notes,
  }
}

// ---------------------------------------------------------------------------
// SessionEnd — local cleanup only
// ---------------------------------------------------------------------------

/**
 * Claude Code gives SessionEnd hooks a 1.5-second shared budget and Codex 1
 * second, so this cannot make a network call. It drops the local marker — but
 * first moves anything still live on the user's devices into the global
 * retirement queue, because this file was the only record of those ids and no
 * hook for this session will ever run again. A question whose
 * agent just exited can receive no answer, so it is orphaned as `expired`.
 */
export function handleSessionEnd(
  env: NodeJS.ProcessEnv,
  envelope: HookEnvelope,
  now: number = Date.now(),
): HookOutcome {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes }
  if (envelope.cwd !== undefined) clearMatchingProjectSession(envelope.cwd, env, sessionId)

  const state = readSessionState(sessionId, env)
  const orphans: RetiringQuestion[] = [...(state.retiring ?? [])]
  const pending = state.pending
  if (pending !== undefined) {
    try {
      const orphan = retiringQuestion(pending, 'expired')
      if (orphan !== null) orphans.push(orphan)
    } catch (err) {
      notes.push(err instanceof Error ? err.message : String(err))
      // Preserve the only identifiers instead of turning an explicit corrupt
      // state into an unretirable question during SessionEnd cleanup.
      return { notes }
    }
  }
  if (orphans.length > 0) {
    const label = env['NOTIFAI_SESSION']
    orphanRetirements(env, orphans, label !== undefined && label !== '' ? label : sessionId, now)
    notes.push(
      `queued ${orphans.length} question${orphans.length > 1 ? 's' : ''} for retirement on the next hook`,
    )
  }
  clearSessionState(sessionId, env)
  return { notes }
}

// ---------------------------------------------------------------------------
// ask — register a question for the turn's end
// ---------------------------------------------------------------------------

/**
 * One session holds one live question, so registering a second one ends the
 * first.
 *
 * This used to replace `pending` wholesale, which silently discarded the
 * `request_id` and `collapse_key` of a question already delivered to the user's
 * devices. Nothing else knows those ids, so the notification became
 * unretirable — it sat on the lock screen for ever asking a question no answer
 * could reach. That is where the stale pile-up came from.
 *
 * Supersession is keyed on the session, not the project: several agents may be
 * running in one project at once, and one agent's new question killing another
 * agent's live one would be worse than the staleness this fixes.
 */
export function registerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  question: PendingQuestion,
  now: number = Date.now(),
): void {
  updateSessionState(sessionId, env, (state) => {
    const retiring = [...(state.retiring ?? [])]
    if (state.pending !== undefined) {
      const retirement = retiringQuestion(state.pending, 'superseded')
      if (
        retirement !== null &&
        !retiring.some((entry) => entry.request_id === retirement.request_id)
      ) {
        retiring.push(retirement)
      }
    }
    return {
      ...state,
      ...(retiring.length > 0 ? { retiring } : {}),
      pending: {
        asked_at: now,
        ...question,
        question: question.question.slice(0, MAX_STORED_QUESTION_CHARS),
      },
    }
  })
}

/** Parses hook JSON from stdin, tolerating an empty or malformed body. */
export function parseHookInput(raw: string): HookEnvelope {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookEnvelope) : {}
  } catch {
    return {}
  }
}

export function resolveHookConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string | undefined,
): CliConfig {
  return loadConfig({ cwd, env, sessionId })
}
