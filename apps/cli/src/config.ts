import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { CLI_SOUNDS, INTERRUPTION_LEVELS } from '@raidiant/notifai-protocol'

/**
 * Layered configuration with provenance. Most specific wins:
 *
 *   flag > session > project-local > project > machine-global > default
 *
 * `session` holds what the user told the agent in conversation ("stop
 * notifying me for now"). It lives on disk keyed by harness session id rather
 * than in the agent's context, because context is lost to compaction and a
 * preference that evaporates mid-session is worse than none.
 *
 * `project-local` is `.notifai/config.local.toml`, intended to be gitignored.
 * `.notifai/config.toml` is intended for committed, shared configuration, so it
 * must not be where a personal "route my questions to my devices" preference
 * lands. The CLI does not edit a repository's ignore rules or create commits.
 *
 * `config show --explain` surfaces the winning layer per key.
 */

export type ConfigSource =
  | 'flag'
  | `session:${string}`
  | `project-local:${string}`
  | `project:${string}`
  | `global:${string}`
  | 'default'

export interface ResolvedValue<T> {
  value: T
  source: ConfigSource
}

type CliSound = (typeof CLI_SOUNDS)[number]
type CliInterruptionLevel = (typeof INTERRUPTION_LEVELS)[number]

export interface CliConfig {
  base_url: ResolvedValue<string>
  wait_seconds: ResolvedValue<number>
  ttl_seconds: ResolvedValue<number>
  collapse_key: ResolvedValue<string | null>
  devices: ResolvedValue<string[] | null>
  sound: ResolvedValue<CliSound | null>
  interruption_level: ResolvedValue<CliInterruptionLevel | null>
  /** Project identifier stamped on sends; typically set in .notifai/config.toml. */
  project: ResolvedValue<string | null>
  /** Free-text notification criteria agents consult before sending. */
  notify_criteria: ResolvedValue<string | null>
  /** Route a registered agent question to companion devices after the presence gate. */
  ask_notifications: ResolvedValue<boolean>
  /**
   * Whether being at this machine suppresses a question. Sitting at the
   * keyboard is not the same as not wanting to be reached — needing to stop
   * using the machine in order to be notified is its own kind of interruption.
   *
   * On, the default, is the original behaviour: a question stays in the
   * terminal while the keyboard is in use, because the person is right there
   * and a push would be redundant. Off says notify me anyway — the grace window
   * still runs, so the question is still offered to the terminal first, it just
   * no longer needs the user to walk away before it may leave.
   *
   * This is deliberately separate from `ask_notifications`, which switches
   * escalation off altogether. Wanting to be reached while working is the
   * opposite of not wanting to be reached.
   */
  require_idle: ResolvedValue<boolean>
  /**
   * Keyboard/mouse idle time after which this machine counts as unattended.
   * When the OS idle signal is unavailable, silence since the user's last prompt
   * is the conservative fallback. Below the threshold the hooks stay out of the
   * way entirely, because a blocking hook also blocks the terminal prompt the
   * present user would use.
   *
   * Only consulted while `require_idle` is on.
   */
  away_after_seconds: ResolvedValue<number>
  /**
   * How long a hook blocks waiting for a companion-device answer before falling through
   * to the harness's own prompt. Must stay under the harness hook timeout
   * (600s in both Claude Code and Codex) or the harness kills us mid-wait.
   */
  hook_reply_timeout_seconds: ResolvedValue<number>
  /**
   * Terminal-first grace window, measured from the moment the question was
   * sent: the agent asks in the terminal and starts a timer, and only once it
   * elapses does the question reach companion devices.
   *
   * A timer, and only a timer. It is configured independently of
   * `away_after_seconds` and honoured whether or not presence is consulted at
   * all — how long to wait and whether anyone is watching are separate
   * questions, and answering one should not answer the other.
   */
  ask_grace_seconds: ResolvedValue<number>
}

export const CONFIG_KEYS = [
  'base_url',
  'wait_seconds',
  'ttl_seconds',
  'collapse_key',
  'devices',
  'sound',
  'interruption_level',
  'project',
  'notify_criteria',
  'ask_notifications',
  'require_idle',
  'away_after_seconds',
  'hook_reply_timeout_seconds',
  'ask_grace_seconds',
] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** Keys whose TOML value must parse as a boolean; used by `config set`. */
export const BOOLEAN_CONFIG_KEYS: readonly ConfigKey[] = [
  'ask_notifications',
  'require_idle',
]

/** Keys whose TOML value must parse as an integer within its configured bounds. */
export const NUMERIC_CONFIG_KEYS: readonly ConfigKey[] = [
  'wait_seconds',
  'ttl_seconds',
  'away_after_seconds',
  'hook_reply_timeout_seconds',
  'ask_grace_seconds',
]

const DEFAULTS = {
  base_url: 'https://notifai.fly.dev',
  wait_seconds: 10,
  ttl_seconds: 86400,
  collapse_key: null,
  devices: null,
  sound: null,
  interruption_level: null,
  project: null,
  notify_criteria: null,
  // Installing the hooks is the opt-in; these exist to switch the behaviour
  // back off for a project or a session without uninstalling anything.
  ask_notifications: true,
  // On by default because it is the less surprising of the two: a question
  // appearing on your phone while you are typing the answer into the terminal
  // is worse as a default than one that waits for you to leave.
  require_idle: true,
  away_after_seconds: 120,
  // 300 + 180 + the installer's 60s headroom = 540, inside the 600s
  // command-hook ceiling both harnesses enforce.
  hook_reply_timeout_seconds: 180,
  ask_grace_seconds: 300,
} satisfies Record<ConfigKey, unknown>

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']
  const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'notifai')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalConfigDir(env), 'config.toml')
}

/**
 * Machine-local mutable state: presence markers, pending questions, and
 * session config overrides. Separate from the config dir because none of it is
 * user-authored and none of it should ever be synced or committed.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_STATE_HOME']
  const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'notifai')
}

/** Per-harness-session override file; see the ConfigSource doc comment. */
export function sessionConfigPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.config.toml`)
}

/**
 * Session ids come from harness JSON, so they reach the filesystem from
 * outside. Hash rather than merely sanitising: replacing unsafe characters
 * collapsed distinct ids onto one file — `a/b` and `a?b` both became `a_b`, and
 * two sessions would then share presence, pending questions and overrides.
 * A readable prefix is kept only so the directory is debuggable.
 */
export function sanitizeSessionId(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return readable === '' ? digest : `${readable}-${digest}`
}

/**
 * Pointer from a project directory to the harness session currently working in
 * it, written by the UserPromptSubmit hook. Without it `notifai ask` has no way
 * to learn its own session id: an ordinary agent shell command receives no hook
 * payload, and no harness exports one into the environment.
 */
export function projectSessionPointerPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(canonicalDir(cwd)).digest('hex').slice(0, 32)
  return path.join(stateDir(env), 'projects', `${digest}.json`)
}

/**
 * Resolve symlinks before hashing. The harness reports `cwd` as it knows it
 * while a shell reports `process.cwd()` already resolved — on macOS `/tmp` and
 * `/private/tmp` are the same directory, so hashing the unresolved paths gave
 * two different keys and `notifai ask` could never find the pointer the hook
 * had just written.
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(path.resolve(dir))
  } catch {
    return path.resolve(dir)
  }
}

/** Walk up from cwd looking for .notifai/<name> (Project Override). */
function findProjectFile(startDir: string, name: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, '.notifai', name)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function findProjectConfigPath(startDir: string): string | null {
  return findProjectFile(startDir, 'config.toml')
}

/** Personal sibling of the shared project config; callers should keep it gitignored. */
export function findProjectLocalConfigPath(startDir: string): string | null {
  return findProjectFile(startDir, 'config.local.toml')
}

/**
 * Ranges every layer is clamped to. Config is readable from a repository, so an
 * out-of-range value is attacker input, not a typo: `away_after_seconds = -1`
 * would make a user who just typed count as absent, and an oversized reply
 * timeout would push the generated hook past the harness's 600s ceiling so the
 * hook is killed after the user has already answered.
 */
const NUMERIC_BOUNDS: Partial<Record<ConfigKey, { min: number; max: number }>> = {
  wait_seconds: { min: 0, max: 300 },
  ttl_seconds: { min: 0, max: 7 * 24 * 3600 },
  away_after_seconds: { min: 5, max: 24 * 3600 },
  // 540 + the installer's 60s headroom stays inside the 600s command-hook
  // budget shared by Claude Code and Codex.
  hook_reply_timeout_seconds: { min: 10, max: 540 },
  ask_grace_seconds: { min: 0, max: 540 },
}

/** Drops values a layer must not be trusted to supply, rather than throwing. */
function coerce(key: ConfigKey, value: unknown): unknown | undefined {
  const bounds = NUMERIC_BOUNDS[key]
  if (bounds !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
  }
  if (BOOLEAN_CONFIG_KEYS.includes(key)) return typeof value === 'boolean' ? value : undefined
  return value
}

export function configBounds(key: ConfigKey): { min: number; max: number } | undefined {
  return NUMERIC_BOUNDS[key]
}

function readTomlFile(filePath: string): Record<string, unknown> {
  try {
    return parseToml(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Could not parse ${filePath}: ${String(err)}`)
  }
}

export interface FlagOverrides {
  base_url?: string
  wait_seconds?: number
  ttl_seconds?: number
  collapse_key?: string | null
  devices?: string[]
  sound?: CliSound
  interruption_level?: CliInterruptionLevel
}

export function loadConfig(options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  flags?: FlagOverrides
  /** Harness session id; enables the session override layer when present. */
  sessionId?: string | undefined
}): CliConfig {
  const env = options.env ?? process.env
  const flags = options.flags ?? {}
  const globalPath = globalConfigPath(env)
  const globalRaw = existsSync(globalPath) ? readTomlFile(globalPath) : {}
  const cwd = options.cwd ?? process.cwd()
  const projectPath = findProjectConfigPath(cwd)
  const projectRaw = projectPath ? readTomlFile(projectPath) : {}
  const projectLocalPath = findProjectLocalConfigPath(cwd)
  const projectLocalRaw = projectLocalPath ? readTomlFile(projectLocalPath) : {}
  const sessionId = options.sessionId ?? env['NOTIFAI_SESSION']
  const sessionPath = sessionId ? sessionConfigPath(sessionId, env) : null
  const sessionRaw = sessionPath && existsSync(sessionPath) ? readTomlFile(sessionPath) : {}

  function resolve<K extends ConfigKey>(key: K): ResolvedValue<never> {
    const layers: [unknown, ConfigSource][] = [
      [(flags as Record<string, unknown>)[key], 'flag'],
      [sessionPath ? sessionRaw[key] : undefined, `session:${sessionPath ?? ''}`],
      [projectLocalPath ? projectLocalRaw[key] : undefined, `project-local:${projectLocalPath ?? ''}`],
      [projectPath ? projectRaw[key] : undefined, `project:${projectPath ?? ''}`],
      [globalRaw[key], `global:${globalPath}`],
    ]
    for (const [raw, source] of layers) {
      if (raw === undefined) continue
      const coerced = coerce(key, raw)
      if (coerced === undefined) continue
      return { value: coerced as never, source }
    }
    return { value: DEFAULTS[key] as never, source: 'default' }
  }

  return {
    base_url: resolve('base_url'),
    wait_seconds: resolve('wait_seconds'),
    ttl_seconds: resolve('ttl_seconds'),
    collapse_key: resolve('collapse_key'),
    devices: resolve('devices'),
    sound: resolve('sound'),
    interruption_level: resolve('interruption_level'),
    project: resolve('project'),
    notify_criteria: resolve('notify_criteria'),
    ask_notifications: resolve('ask_notifications'),
    require_idle: resolve('require_idle'),
    away_after_seconds: resolve('away_after_seconds'),
    hook_reply_timeout_seconds: resolve('hook_reply_timeout_seconds'),
    ask_grace_seconds: resolve('ask_grace_seconds'),
  }
}
