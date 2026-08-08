import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { opencodePluginPath, opencodePluginTarget } from './opencode-plugin.js'

/**
 * The three joints the OpenCode plugin hooks into, as (harness event, the
 * `notifai hook` event it runs). The plugin is a module and has no settings
 * entries to read, so `findInstallations` reconstructs its handlers from this.
 */
const OPENCODE_EVENTS = [
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
] as const

/**
 * Harness hook installation.
 *
 * Claude Code's `settings.json` and Codex's `hooks.json` use the same shape —
 * `hooks` maps an event name to matcher groups, each holding command handlers
 * with an optional timeout — so one generator serves both. Only the file
 * location and the event set differ.
 *
 * Cursor's native format is flat and lower-camel-cased, while OpenCode's
 * extension point is a JavaScript plugin module. Each therefore has a bounded
 * adapter instead of being forced through this shared document shape.
 */

export const HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode'] as const
export type Harness = (typeof HARNESSES)[number]

export interface HookHandler {
  type: 'command'
  command: string
  timeout?: number
}

export interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
}

export type HookConfig = Record<string, HookGroup[]>

export interface InstallPlan {
  harness: Harness
  /** Absolute path of the settings file that will be written. */
  file: string
  /** True when the file is machine-wide rather than per-project. */
  global: boolean
  config: HookConfig
}

/**
 * The command each hook runs. Uses the absolute interpreter and script path
 * rather than the bare binary name: hooks inherit a login-ish environment, and
 * a `notifai` that is only on an interactive shell's PATH fails silently.
 */
export function hookCommand(
  execPath: string,
  scriptPath: string,
  event: string,
  harness?: Harness,
): string {
  return (
    `${quote(execPath)} ${quote(scriptPath)} hook ${event} ${OWNER_MARKER}` +
    (harness === undefined ? '' : ` --harness ${harness}`)
  )
}

/**
 * Says "Notifai installed this" without saying which checkout did.
 *
 * Ownership used to be matched on the absolute script path, so installing from
 * a second checkout did not recognise the first one's handlers as ours. Both
 * stayed, the harness ran both, and one question produced two notifications;
 * uninstalling the second silently left the first running. A marker that every
 * Notifai build writes and no build's path appears in fixes that by making
 * ownership a property of the handler rather than of the machine it was
 * installed from.
 *
 * It is a real (ignored) CLI flag rather than a comment because not every
 * harness runs the command through a shell.
 */
export const OWNER_MARKER = '--owner notifai'

/**
 * POSIX single-quoting. Double quotes were wrong: they still expand `$(...)`
 * and backticks, so a checkout path containing shell syntax became command
 * execution on every hook event. Single quotes suppress all expansion; the
 * only escape needed is for a literal single quote.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface BuildOptions {
  execPath: string
  scriptPath: string
  /** Seconds a blocking hook may wait for a companion-device answer. */
  replyTimeoutSeconds: number
  /** Seconds the question waits in the terminal before it is pushed at all. */
  graceSeconds: number
  /** The installed adapter stamps its exact harness into project pointers. */
  harness?: Harness
}

/** Command-hook harnesses kill at 600s; generated adapters use the same safe ceiling. */
const HOOK_CEILING_SECONDS = 590

/** Grace, reply wait, and teardown headroom for any blocking turn-end adapter. */
export function blockingHookTimeoutSeconds(graceSeconds: number, replyTimeoutSeconds: number): number {
  return Math.min(HOOK_CEILING_SECONDS, graceSeconds + replyTimeoutSeconds + 60)
}

export function buildHookConfig(options: BuildOptions): HookConfig {
  const { execPath, scriptPath } = options
  // Stop can spend the grace window AND then the reply wait, so the declared
  // timeout must cover both. Headroom on top so the harness never kills the
  // hook first; a killed hook loses the answer the user already gave.
  const blockingTimeout = blockingHookTimeoutSeconds(
    options.graceSeconds,
    options.replyTimeoutSeconds,
  )
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(execPath, scriptPath, 'user-prompt-submit', options.harness),
            // Claude Code caps UserPromptSubmit at 30s; stay well inside it so
            // a slow network can never delay the user's own prompt.
            timeout: 15,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(execPath, scriptPath, 'stop', options.harness),
            timeout: blockingTimeout,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(execPath, scriptPath, 'session-end', options.harness),
            // Both harnesses give SessionEnd a ~1-3s budget, so this handler
            // only touches local state.
            timeout: 3,
          },
        ],
      },
    ],
  }
}

export interface CursorHookHandler {
  command: string
  timeout?: number
  loop_limit?: number | null
}

export type CursorHookConfig = Record<string, CursorHookHandler[]>

interface CursorSettingsDocument {
  version?: number
  hooks?: CursorHookConfig
  [key: string]: unknown
}

/** Cursor's native schema is flat and uses lower-camel lifecycle event names. */
export function buildCursorHookConfig(options: BuildOptions): CursorHookConfig {
  const blockingTimeout = blockingHookTimeoutSeconds(
    options.graceSeconds,
    options.replyTimeoutSeconds,
  )
  return {
    beforeSubmitPrompt: [
      {
        command: hookCommand(options.execPath, options.scriptPath, 'user-prompt-submit', 'cursor'),
        timeout: 15,
      },
    ],
    stop: [
      {
        command: hookCommand(options.execPath, options.scriptPath, 'stop', 'cursor'),
        timeout: blockingTimeout,
        // A continuation may register a real follow-up question. Match the
        // session-state cap so those chains are useful but never unbounded.
        loop_limit: 3,
      },
    ],
    sessionEnd: [
      {
        command: hookCommand(options.execPath, options.scriptPath, 'session-end', 'cursor'),
        timeout: 3,
      },
    ],
  }
}

/**
 * Where each harness reads hooks from. Project installs deliberately target the
 * gitignored file where one exists: which devices a person wants their
 * questions pushed to is not a property of the repository.
 */
export function settingsFile(
  harness: Harness,
  global: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // OpenCode has no settings document to merge into — its adapter is a
  // generated plugin module, so it owns a whole file rather than a handler
  // inside one. `opencodePluginPath` is its equivalent.
  if (harness === 'opencode') return opencodePluginPath(global, cwd, env)
  if (harness === 'cursor') {
    const home = env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : os.homedir()
    return global
      ? path.join(home, '.cursor', 'hooks.json')
      : path.join(cwd, '.cursor', 'hooks.json')
  }
  if (harness === 'claude-code') {
    return global
      ? path.join(configHome(env, 'CLAUDE_CONFIG_DIR', '.claude'), 'settings.json')
      : path.join(cwd, '.claude', 'settings.local.json')
  }
  return global
    ? path.join(configHome(env, 'CODEX_HOME', '.codex'), 'hooks.json')
    : path.join(codexProjectRoot(cwd), '.codex', 'hooks.json')
}

/**
 * Where Codex looks for a project's hooks — the **main** repository, not the
 * working directory.
 *
 * Run from a linked git worktree, Codex reads `<main repo>/.codex/hooks.json`
 * and never looks at the worktree's own. Proven 2026-08-03 in an isolated
 * `CODEX_HOME`: with cwd set to a worktree, a handler at the main repo root
 * fired and an identical one at the worktree root did not; removing the main
 * one left nothing firing at all. Writing to cwd therefore produces a silent
 * no-op for anyone whose agent runs in a worktree, which is the normal case
 * under tooling like Orca.
 *
 * Claude Code does not share this behaviour — it reads the worktree's own
 * `.claude/settings.local.json` — so this deliberately applies to Codex only.
 */
export function codexProjectRoot(cwd: string): string {
  const entry = findGitEntry(cwd)
  if (entry === null) return cwd
  try {
    if (statSync(entry).isDirectory()) return path.dirname(entry)
    const linked = worktreeGitDir(entry)
    return linked === null ? cwd : path.dirname(commonGitDir(linked))
  } catch {
    // An unreadable or exotic checkout is not worth failing an install over;
    // cwd is what we used to do and is right for every non-worktree case.
    return cwd
  }
}

/**
 * The `.codex` directory that has to exist for Codex to load project hooks at
 * all, or null when nothing extra is needed.
 *
 * Codex splits the two halves of "which project am I in": it discovers the
 * project layer by walking up from cwd for a `.codex` directory, but resolves
 * `hooks.json` inside that layer against the main repository. In an ordinary
 * checkout both land on the same directory and the split is invisible. In a
 * worktree they diverge, and writing only the main repository's file leaves it
 * unread — Codex never looks, because nothing at or above cwd told it there was
 * a project layer to load. Proven 2026-08-03: with cwd in a worktree, an *empty*
 * `.codex` directory there was the difference between the main repository's
 * handler running and nothing running.
 */
export function codexLayerDir(cwd: string): string | null {
  const entry = findGitEntry(cwd)
  if (entry === null) return null
  const worktreeRoot = path.dirname(entry)
  if (path.resolve(worktreeRoot) === path.resolve(codexProjectRoot(cwd))) return null
  return path.join(worktreeRoot, '.codex')
}

/** The nearest `.git` at or above `from`, or null outside a repository. */
function findGitEntry(from: string): string | null {
  let dir = path.resolve(from)
  for (;;) {
    const entry = path.join(dir, '.git')
    if (existsSync(entry)) return entry
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** `.git` in a linked worktree is a file naming that worktree's git directory. */
function worktreeGitDir(file: string): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))
  if (match === null) return null
  return path.resolve(path.dirname(file), match[1]!.trim())
}

/**
 * A worktree's git directory records the shared one in `commondir`; that shared
 * directory is the main repository's `.git`, whose parent is its root.
 */
function commonGitDir(gitDir: string): string {
  const marker = path.join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  return path.resolve(gitDir, readFileSync(marker, 'utf8').trim())
}

/**
 * Both harnesses let an environment variable relocate their whole config
 * directory, and tooling that manages sessions does exactly that — Orca points
 * `CODEX_HOME` at a per-account home, so writing to `~/.codex` installs hooks
 * into a file Codex never reads and the failure is silent. Observed 2026-08-02.
 */
export function configHome(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const override = env[variable]
  return override !== undefined && override !== '' ? override : path.join(os.homedir(), fallback)
}

/** Best-effort detection so `hooks install` usually needs no flags. */
/**
 * Harnesses this *project* shows evidence of, in the working directory only.
 *
 * `CLAUDE.md` counts because it is Claude Code's own project file and is
 * frequently the only marker: a repository can be worked in daily through
 * Claude Code and never accumulate a `.claude/` directory.
 *
 * `AGENTS.md` deliberately counts for nothing. It began as a Codex
 * convention and is now read by most agent tooling — including Claude Code,
 * and including this repository, where the two filenames are the same
 * document. Treating it as evidence of any one harness would be a guess
 * dressed up as detection.
 */
function localHarnessEvidence(cwd: string): Harness[] {
  const found: Harness[] = []
  if (existsSync(path.join(cwd, '.claude')) || existsSync(path.join(cwd, 'CLAUDE.md'))) {
    found.push('claude-code')
  }
  if (existsSync(path.join(cwd, '.codex'))) found.push('codex')
  if (existsSync(path.join(cwd, '.cursor'))) found.push('cursor')
  if (existsSync(path.join(cwd, '.opencode'))) found.push('opencode')
  return found
}

/** Harnesses installed anywhere on this machine — a much weaker signal. */
function globalHarnessEvidence(): Harness[] {
  const home = os.homedir()
  const found: Harness[] = []
  if (existsSync(path.join(home, '.claude'))) found.push('claude-code')
  if (existsSync(path.join(home, '.codex'))) found.push('codex')
  if (existsSync(path.join(home, '.cursor'))) found.push('cursor')
  if (existsSync(path.join(home, '.config', 'opencode'))) found.push('opencode')
  return found
}

/**
 * Which harness to wire in this directory, or null when it is genuinely
 * unclear.
 *
 * Project evidence decides, and machine evidence is consulted only when the
 * project offers none. The two were previously OR-ed together per harness,
 * which meant a developer with several agent tools installed could never get
 * a detection at all: every `~/.<tool>` directory contributed a candidate, the
 * "exactly one" test never passed, and the answer was null in every repository
 * on the machine. Verified on a machine carrying all four — `notifai init
 * --hooks` failed in five separate projects, each of which plainly used Claude
 * Code.
 *
 * Having a tool installed says nothing about which one *this* project is
 * worked in. Ambiguity within the project is still ambiguity, and returns
 * null so the caller can ask rather than guess.
 */
export function detectHarness(cwd: string): Harness | null {
  const local = localHarnessEvidence(cwd)
  if (local.length > 0) return local.length === 1 ? local[0]! : null
  const global = globalHarnessEvidence()
  return global.length === 1 ? global[0]! : null
}

interface SettingsDocument {
  hooks?: HookConfig
  [key: string]: unknown
}

function readCursorSettings(file: string): CursorSettingsDocument {
  if (!existsSync(file)) return { version: 1 }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as CursorSettingsDocument)
      : { version: 1 }
  } catch {
    throw new Error(`Could not parse ${file}; fix or move it before installing hooks.`)
  }
}

function isOurCommand(command: string, scriptPath: string): boolean {
  if (command.includes(OWNER_MARKER)) return true
  return (
    command.includes(`${scriptPath}' hook `) ||
    command.includes(`${scriptPath}" hook `) ||
    command.includes(`${scriptPath} hook `)
  )
}

export function mergeCursorHooks(
  existing: CursorSettingsDocument,
  incoming: CursorHookConfig,
  scriptPath: string,
): { document: CursorSettingsDocument; added: string[]; replaced: string[]; removed: string[] } {
  const hooks: CursorHookConfig = {}
  const added: string[] = []
  const replaced: string[] = []
  const removed: string[] = []

  for (const [event, handlers] of Object.entries(existing.hooks ?? {})) {
    const foreign = handlers.filter((handler) => !isOurCommand(handler.command, scriptPath))
    if (foreign.length !== handlers.length) {
      if (event in incoming) replaced.push(event)
      else removed.push(event)
    }
    if (foreign.length > 0) hooks[event] = foreign
  }
  for (const [event, handlers] of Object.entries(incoming)) {
    if (!replaced.includes(event)) added.push(event)
    hooks[event] = [...(hooks[event] ?? []), ...handlers]
  }
  return { document: { ...existing, version: 1, hooks }, added, replaced, removed }
}

export function removeCursorHooks(
  existing: CursorSettingsDocument,
  scriptPath: string,
): { document: CursorSettingsDocument; added: string[]; replaced: string[]; removed: string[] } {
  const hooks: CursorHookConfig = {}
  const replaced: string[] = []
  for (const [event, handlers] of Object.entries(existing.hooks ?? {})) {
    const foreign = handlers.filter((handler) => !isOurCommand(handler.command, scriptPath))
    if (foreign.length !== handlers.length) replaced.push(event)
    if (foreign.length > 0) hooks[event] = foreign
  }
  return { document: { ...existing, version: 1, hooks }, added: [], replaced, removed: [] }
}

function readSettings(file: string): SettingsDocument {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as SettingsDocument) : {}
  } catch {
    throw new Error(`Could not parse ${file}; fix or move it before installing hooks.`)
  }
}

/**
 * True when a single handler is ours. Deliberately per-handler, not per-group:
 * removing a whole group destroyed a user's own handler if they had added one
 * beside ours inside the same matcher group.
 */
function isOurHandler(handler: HookHandler, scriptPath: string): boolean {
  return isOurCommand(handler.command, scriptPath)
}

/** Drops only our handlers, keeping the group and anyone else's handlers. */
function withoutOurs(groups: HookGroup[], scriptPath: string): { groups: HookGroup[]; removed: boolean } {
  let removed = false
  const kept: HookGroup[] = []
  for (const group of groups) {
    const hooks = group.hooks.filter((handler) => {
      const ours = isOurHandler(handler, scriptPath)
      if (ours) removed = true
      return !ours
    })
    if (hooks.length > 0) kept.push({ ...group, hooks })
  }
  return { groups: kept, removed }
}

export interface MergeResult {
  document: SettingsDocument
  added: string[]
  replaced: string[]
  /** Events an older build installed that this one no longer serves. */
  removed: string[]
}

/**
 * Adds our handlers without disturbing anyone else's. Re-running replaces only
 * the groups we previously wrote, so an upgrade that changes a timeout does not
 * accumulate duplicate hooks.
 *
 * Handlers are stripped from EVERY event, not just the ones being installed.
 * Only rewriting incoming events left a dropped event's handler in place for
 * ever, and since the binary no longer implements it, it exited 2 with
 * "Unknown hook event" every time the harness fired it — a permanent hook
 * failure that reinstalling could not clear.
 */
export function mergeHooks(
  existing: SettingsDocument,
  incoming: HookConfig,
  scriptPath: string,
): MergeResult {
  const hooks: HookConfig = {}
  const added: string[] = []
  const replaced: string[] = []
  const removed: string[] = []

  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const { groups: foreign, removed: hadOurs } = withoutOurs(groups, scriptPath)
    if (hadOurs) {
      if (event in incoming) replaced.push(event)
      else removed.push(event)
    }
    if (foreign.length > 0) hooks[event] = foreign
  }

  for (const [event, groups] of Object.entries(incoming)) {
    if (!replaced.includes(event)) added.push(event)
    hooks[event] = [...(hooks[event] ?? []), ...groups]
  }

  return { document: { ...existing, hooks }, added, replaced, removed }
}

export function removeHooks(existing: SettingsDocument, scriptPath: string): MergeResult {
  const hooks: HookConfig = {}
  const replaced: string[] = []
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const { groups: foreign, removed } = withoutOurs(groups, scriptPath)
    if (removed) replaced.push(event)
    if (foreign.length > 0) hooks[event] = foreign
  }
  return { document: { ...existing, hooks }, added: [], replaced, removed: [] }
}

/**
 * Writes the settings file the way a tool that does not own it should.
 *
 * Truncating in place lost the user's whole harness configuration if the write
 * failed halfway, and clobbered a concurrent editor's changes; following a
 * symlink wrote through to a target they never named. So: refuse
 * anything that is not a regular file, write a sibling temp file, fsync it, and
 * rename over the original — atomic within a directory on every platform we
 * support.
 */
export function applyPlan(file: string, document: SettingsDocument | CursorSettingsDocument): void {
  atomicWriteFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
}

export function loadSettings(file: string): SettingsDocument {
  return readSettings(file)
}

export function loadCursorSettings(file: string): CursorSettingsDocument {
  return readCursorSettings(file)
}

// ---------------------------------------------------------------------------
// Discovery — answering "will my hooks actually run?" without a live test
// ---------------------------------------------------------------------------

/** One of our handlers as it sits in a settings file, with its position. */
export interface InstalledHandler {
  event: string
  /** Index of the matcher group within the event, as the harness sees it. */
  groupIndex: number
  /** Index of the handler within its group. */
  handlerIndex: number
  command: string
  /** Declared process lifetime, used to detect config/install drift. */
  timeout?: number
}

export interface Installation {
  harness: Harness
  file: string
  global: boolean
  handlers: InstalledHandler[]
  /** Structural defects that require reinstalling this generated adapter. */
  problems?: string[]
}

/**
 * Any Notifai handler, whatever checkout wrote it.
 *
 * Deliberately looser than `isOurHandler`: this answers "has Notifai been set
 * up here at all", and a handler installed from a second checkout is still
 * evidence that it has (and is itself worth reporting).
 */
function isNotifaiCommand(command: string): boolean {
  return / hook (user-prompt-submit|stop|session-end)\b/.test(command)
}

function isNotifaiHandler(handler: HookHandler): boolean {
  return isNotifaiCommand(handler.command)
}

/** Every place either harness would read a Notifai handler from. */
export function findInstallations(cwd: string, env: NodeJS.ProcessEnv = process.env): Installation[] {
  const found: Installation[] = []
  for (const harness of HARNESSES) {
    for (const global of [false, true]) {
      const file = settingsFile(harness, global, cwd, env)
      if (!existsSync(file)) continue
      // OpenCode's adapter is a plugin module, not a settings document, so it
      // is reported as one installation covering all three events rather than
      // parsed for handlers.
      if (harness === 'opencode') {
        const target = opencodePluginTarget(readFileSync(file, 'utf8'))
        if (target === null) continue
        found.push({
          harness,
          file,
          global,
          ...(!target.current
            ? { problems: ['obsolete OpenCode event wiring; rerun `notifai hooks install --harness opencode`'] }
            : {}),
          // Reported as the command line the plugin will actually run, not as
          // the plugin's own path: every check downstream asks which build a
          // handler invokes, and for a module that answer lives inside it.
          handlers: OPENCODE_EVENTS.map(([event, hookEvent]) => ({
            event,
            groupIndex: 0,
            handlerIndex: 0,
            command: hookCommand(target.exec, target.script, hookEvent),
            ...(target.timeoutSeconds === undefined ? {} : { timeout: target.timeoutSeconds }),
          })),
        })
        continue
      }
      if (harness === 'cursor') {
        let document: CursorSettingsDocument
        try {
          document = readCursorSettings(file)
        } catch {
          continue
        }
        const handlers = locateCursorHandlers(document)
        if (handlers.length > 0) {
          const problems = harnessMarkerProblems(harness, handlers)
          found.push({ harness, file, global, handlers, ...(problems.length > 0 ? { problems } : {}) })
        }
        continue
      }
      let document: SettingsDocument
      try {
        document = readSettings(file)
      } catch {
        continue
      }
      const handlers = locateHandlers(document)
      if (handlers.length > 0) {
        const problems = harnessMarkerProblems(harness, handlers)
        found.push({ harness, file, global, handlers, ...(problems.length > 0 ? { problems } : {}) })
      }
    }
  }
  return found
}

function harnessMarkerProblems(harness: Harness, handlers: InstalledHandler[]): string[] {
  return handlers.every((handler) => handler.command.includes(`--harness ${harness}`))
    ? []
    : [
        `installed commands do not stamp the ${harness} routing identity; rerun \`notifai hooks install --harness ${harness}\``,
      ]
}

function locateCursorHandlers(document: CursorSettingsDocument): InstalledHandler[] {
  const handlers: InstalledHandler[] = []
  for (const [event, eventHandlers] of Object.entries(document.hooks ?? {})) {
    eventHandlers.forEach((handler, handlerIndex) => {
      if (isNotifaiCommand(handler.command)) {
        handlers.push({
          event,
          groupIndex: 0,
          handlerIndex,
          command: handler.command,
          ...(handler.timeout === undefined ? {} : { timeout: handler.timeout }),
        })
      }
    })
  }
  return handlers
}

function locateHandlers(document: SettingsDocument): InstalledHandler[] {
  const handlers: InstalledHandler[] = []
  for (const [event, groups] of Object.entries(document.hooks ?? {})) {
    groups.forEach((group, groupIndex) => {
      group.hooks?.forEach((handler, handlerIndex) => {
        if (isNotifaiHandler(handler)) {
          handlers.push({
            event,
            groupIndex,
            handlerIndex,
            command: handler.command,
            ...(handler.timeout === undefined ? {} : { timeout: handler.timeout }),
          })
        }
      })
    })
  }
  return handlers
}

/** The hook event a handler's command actually invokes, e.g. `stop`. */
export function handlerEvent(command: string): string | null {
  return / hook ([a-z-]+)/.exec(command)?.[1] ?? null
}
