import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChoices } from './send.js'
import {
  OPENCODE_PLUGIN_MARKER,
  isOurOpencodePlugin,
  opencodePluginPath,
  opencodePluginSource,
  opencodePluginTarget,
} from './opencode-plugin.js'
import {
  HARNESSES,
  applyPlan,
  detectHarness,
  buildHookConfig,
  codexLayerDir,
  codexProjectRoot,
  findInstallations,
  handlerEvent,
  hookCommand,
  mergeHooks,
  removeHooks,
  settingsFile,
  type HookConfig,
  type SettingsDocument,
} from './install-hooks.js'

const SCRIPT = '/opt/notifai/dist/main.js'
const EXEC = '/usr/local/bin/node'

function ours(): HookConfig {
  return buildHookConfig({ execPath: EXEC, scriptPath: SCRIPT, replyTimeoutSeconds: 240, graceSeconds: 0 })
}

describe('choice labels', () => {
  it('splits a single value on commas for the one-liner case', () => {
    expect(parseChoices('Staging,Production')).toEqual([
      { id: 'staging', label: 'Staging' },
      { id: 'production', label: 'Production' },
    ])
  })

  it('keeps commas inside a label when the flag is repeated', () => {
    // Observed live 2026-08-02: "Yes, it worked,No, something broke" passed as
    // one value silently became four choices, and 2-6 validation let it
    // through because four is in range. Repeating the flag is the escape.
    expect(parseChoices(['Yes, it worked', 'No, something broke'])).toEqual([
      { id: 'yes-it-worked', label: 'Yes, it worked' },
      { id: 'no-something-broke', label: 'No, something broke' },
    ])
    expect(parseChoices('Yes, it worked,No, something broke')).toHaveLength(4)
  })

  it('rejects a set that cannot become a valid closed question', () => {
    // A pipe-separated string is one label, not two — the shape that reached
    // the hook and failed there instead of at registration.
    expect(parseChoices('Yes|No')).toBe('invalid')
    expect(parseChoices(['Only one'])).toBe('invalid')
    expect(parseChoices(['A', 'a'])).toBe('invalid')
    expect(parseChoices(['1', '2', '3', '4', '5', '6', '7'])).toBe('invalid')
  })

  it('treats an unused repeatable flag as no choices at all', () => {
    expect(parseChoices([])).toBeNull()
    expect(parseChoices(undefined)).toBeNull()
  })
})

describe('hook config', () => {
  it('invokes the CLI by absolute path so a hook shell without our PATH still works', () => {
    expect(hookCommand(EXEC, SCRIPT, 'stop')).toBe(`'${EXEC}' '${SCRIPT}' hook stop --owner notifai`)
  })

  it('single-quotes so a path cannot become a command', () => {
    // Double quotes still expand $() and backticks, so a checkout path with
    // shell syntax was execution on every hook event.
    const cmd = hookCommand('/usr/bin/node', '/tmp/$(touch /tmp/pwned)/main.js', 'stop')
    expect(cmd).toBe("'/usr/bin/node' '/tmp/$(touch /tmp/pwned)/main.js' hook stop --owner notifai")
    expect(hookCommand('/usr/bin/node', "/it's/here.js", 'stop')).toContain(`'/it'\\''s/here.js'`)
  })

  it('gives blocking hooks headroom over our own wait, and SessionEnd almost none', () => {
    const config = buildHookConfig({ execPath: EXEC, scriptPath: SCRIPT, replyTimeoutSeconds: 240, graceSeconds: 0 })
    expect(config['Stop']?.[0]?.hooks[0]?.timeout).toBe(300)
    // Claude Code caps UserPromptSubmit at 30s; Codex gives SessionEnd 1-3s.
    expect(config['UserPromptSubmit']?.[0]?.hooks[0]?.timeout).toBe(15)
    expect(config['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(3)
  })
})

describe('merging into existing settings', () => {
  it('leaves unrelated settings and other people’s hooks untouched', () => {
    const existing = {
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command' as const, command: 'make lint' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'guard.sh' }] }],
      },
    }
    const merged = mergeHooks(existing, ours(), SCRIPT)

    expect(merged.document['permissions']).toEqual({ allow: ['Bash(git *)'] })
    expect(merged.document.hooks?.['PreToolUse']).toEqual(existing.hooks.PreToolUse)
    const stop = merged.document.hooks?.['Stop'] ?? []
    expect(stop[0]?.hooks[0]?.command).toBe('make lint')
    expect(stop[1]?.hooks[0]?.command).toContain('hook stop')
  })

  it('replaces our own groups on reinstall instead of duplicating them', () => {
    const once = mergeHooks({}, ours(), SCRIPT)
    const twice = mergeHooks(
      once.document,
      buildHookConfig({ execPath: EXEC, scriptPath: SCRIPT, replyTimeoutSeconds: 60, graceSeconds: 0 }),
      SCRIPT,
    )
    expect(twice.document.hooks?.['Stop']).toHaveLength(1)
    expect(twice.document.hooks?.['Stop']?.[0]?.hooks[0]?.timeout).toBe(120)
    expect(twice.replaced).toContain('Stop')
  })

  it('keeps a user handler that shares a matcher group with ours', () => {
    const installed = mergeHooks({}, ours(), SCRIPT)
    const mixed = installed.document.hooks!['Stop']!
    mixed[0]!.hooks.push({ type: 'command', command: 'make lint' })

    const stripped = removeHooks(installed.document, SCRIPT)
    expect(stripped.document.hooks?.['Stop']).toEqual([
      { hooks: [{ type: 'command', command: 'make lint' }] },
    ])
  })

  it('uninstall removes only our handlers', () => {
    const installed = mergeHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'make lint' }] }] } },
      ours(),
      SCRIPT,
    )
    const stripped = removeHooks(installed.document, SCRIPT)
    expect(stripped.document.hooks?.['Stop']).toEqual([
      { hooks: [{ type: 'command', command: 'make lint' }] },
    ])
    expect(stripped.document.hooks?.['UserPromptSubmit']).toBeUndefined()
  })
})

describe('settings locations', () => {
  it('writes a project install to the gitignored file, not the shared one', () => {
    expect(settingsFile('claude-code', false, '/repo', {})).toBe('/repo/.claude/settings.local.json')
    expect(settingsFile('claude-code', true, '/repo', {})).toBe(
      path.join(os.homedir(), '.claude', 'settings.json'),
    )
  })

  it('uses hooks.json for Codex', () => {
    expect(settingsFile('codex', false, '/repo', {})).toBe('/repo/.codex/hooks.json')
    expect(settingsFile('codex', true, '/repo', {})).toBe(
      path.join(os.homedir(), '.codex', 'hooks.json'),
    )
  })
})

/**
 * Codex resolves project hooks against the main repository, so an install run
 * inside a worktree used to write a file Codex never reads — and reported
 * success. Proven against the real binary 2026-08-03.
 */
describe('a Codex install run inside a git worktree', () => {
  /** The on-disk shape `git worktree add` produces, verified against real git. */
  function repoWithWorktree(): { main: string; worktree: string } {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-wt-'))
    const main = path.join(base, 'main')
    const worktree = path.join(base, 'wt')
    const gitDir = path.join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n')
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    return { main, worktree }
  }

  it('targets the main repository, which is the file Codex actually reads', () => {
    const { main, worktree } = repoWithWorktree()

    expect(settingsFile('codex', false, worktree, {})).toBe(path.join(main, '.codex', 'hooks.json'))
    expect(codexProjectRoot(worktree)).toBe(main)
  })

  it('resolves the same way from a subdirectory of the worktree', () => {
    const { main, worktree } = repoWithWorktree()
    const nested = path.join(worktree, 'apps', 'cli')
    mkdirSync(nested, { recursive: true })

    expect(codexProjectRoot(nested)).toBe(main)
  })

  it('leaves an ordinary checkout alone', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-repo-'))
    mkdirSync(path.join(base, '.git'), { recursive: true })
    const nested = path.join(base, 'packages', 'core')
    mkdirSync(nested, { recursive: true })

    expect(codexProjectRoot(base)).toBe(base)
    expect(codexProjectRoot(nested)).toBe(base)
  })

  it('falls back to the working directory outside a repository', () => {
    // Not every project is a git checkout, and an install there should still
    // land somewhere predictable rather than walking off to the filesystem root.
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-bare-'))

    expect(codexProjectRoot(base)).toBe(base)
  })

  it('names the directory Codex needs before it will look for project hooks', () => {
    // Writing the main repository's file is not enough: Codex only loads the
    // project layer when a `.codex` directory sits at or above cwd, and in a
    // worktree there is nothing to find. An empty directory was the difference
    // between the handler running and nothing running.
    const { worktree } = repoWithWorktree()

    expect(codexLayerDir(worktree)).toBe(path.join(worktree, '.codex'))
  })

  it('anchors that directory at the worktree root so subdirectories are covered', () => {
    const { worktree } = repoWithWorktree()
    const nested = path.join(worktree, 'apps', 'cli')
    mkdirSync(nested, { recursive: true })

    // Codex walks up from cwd looking for it, so one at the root serves every
    // directory an agent might run from.
    expect(codexLayerDir(nested)).toBe(path.join(worktree, '.codex'))
  })

  it('asks for nothing extra in an ordinary checkout, where both halves agree', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-plain-'))
    mkdirSync(path.join(base, '.git'), { recursive: true })

    expect(codexLayerDir(base)).toBeNull()
  })

  it('does not redirect Claude Code, which reads the worktree it runs in', () => {
    const { worktree } = repoWithWorktree()

    expect(settingsFile('claude-code', false, worktree, {})).toBe(
      path.join(worktree, '.claude', 'settings.local.json'),
    )
  })

  it('follows a relocated config home rather than installing where nothing reads', () => {
    // Orca points CODEX_HOME at a per-account home; writing to ~/.codex there
    // produced hooks Codex never loaded, and nothing reported a problem.
    expect(settingsFile('codex', true, '/repo', { CODEX_HOME: '/managed/codex' })).toBe(
      '/managed/codex/hooks.json',
    )
    expect(settingsFile('claude-code', true, '/repo', { CLAUDE_CONFIG_DIR: '/managed/claude' })).toBe(
      '/managed/claude/settings.json',
    )
    // An empty value is not a relocation.
    expect(settingsFile('codex', true, '/repo', { CODEX_HOME: '' })).toBe(
      path.join(os.homedir(), '.codex', 'hooks.json'),
    )
  })
})

describe('upgrading past a dropped event', () => {
  it('removes a handler for an event this build no longer serves', () => {
    // Found live in this repo: settings.local.json still ran
    // `main.js hook permission-request`, written by a build that had such an
    // event. The current binary exits 2 with "Unknown hook event" every time
    // the harness fires it, and reinstalling never cleaned it up because the
    // merge only touched events present in the incoming config.
    const stale = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: 'command' as const, command: hookCommand(EXEC, SCRIPT, 'permission-request') }] },
        ],
        Stop: [{ hooks: [{ type: 'command' as const, command: hookCommand(EXEC, SCRIPT, 'stop') }] }],
      },
    }

    const merged = mergeHooks(stale, ours(), SCRIPT)

    expect(merged.document.hooks?.['PermissionRequest']).toBeUndefined()
    expect(merged.removed).toEqual(['PermissionRequest'])
    expect(merged.replaced).toContain('Stop')
  })

  it('keeps someone else’s handler for that same dropped event', () => {
    const mixed = {
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              { type: 'command' as const, command: hookCommand(EXEC, SCRIPT, 'permission-request') },
              { type: 'command' as const, command: 'their-own-tool --check' },
            ],
          },
        ],
      },
    }

    const merged = mergeHooks(mixed, ours(), SCRIPT)

    expect(merged.document.hooks?.['PermissionRequest']?.[0]?.hooks).toEqual([
      { type: 'command', command: 'their-own-tool --check' },
    ])
  })

  it('does not accumulate duplicates when run twice', () => {
    const once = mergeHooks({}, ours(), SCRIPT)
    const twice = mergeHooks(once.document, ours(), SCRIPT)
    expect(twice.document.hooks?.['Stop']?.[0]?.hooks).toHaveLength(1)
    expect(twice.removed).toEqual([])
  })
})

describe('writing the settings file', () => {
  function scratch(): string {
    return mkdtempSync(path.join(os.tmpdir(), 'notifai-apply-'))
  }

  it('refuses to write through a symlink', () => {
    const dir = scratch()
    const real = path.join(dir, 'somewhere-else.json')
    const link = path.join(dir, 'settings.json')
    writeFileSync(real, '{"untouched":true}\n')
    symlinkSync(real, link)

    expect(() => applyPlan(link, { hooks: {} })).toThrow(/symlink/)
    // The point of refusing: the target must be exactly as it was.
    expect(readFileSync(real, 'utf8')).toBe('{"untouched":true}\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it('preserves an existing file’s mode and leaves no temp file behind', () => {
    const dir = scratch()
    const file = path.join(dir, 'settings.json')
    writeFileSync(file, '{}\n', { mode: 0o644 })

    applyPlan(file, { hooks: ours() })

    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('hooks.Stop')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('keeps a file it creates private, since settings can carry tokens', () => {
    const dir = scratch()
    const file = path.join(dir, 'nested', 'settings.json')
    applyPlan(file, { hooks: {} })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('finding what is installed', () => {
  it('reports handlers from either harness with their positions', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-find-'))
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), { hooks: ours() })

    const found = findInstallations(cwd, { CODEX_HOME: path.join(cwd, 'no-codex-here') })
    const claude = found.find((i) => i.harness === 'claude-code' && !i.global)

    expect(claude).toBeDefined()
    expect(claude?.handlers.map((h) => h.event).sort()).toEqual([
      'SessionEnd',
      'Stop',
      'UserPromptSubmit',
    ])
    expect(claude?.handlers.every((h) => h.groupIndex === 0 && h.handlerIndex === 0)).toBe(true)
  })

  it('reads the event a handler actually invokes, not the key it sits under', () => {
    // These diverge exactly when an upgrade drops an event, which is the case
    // worth detecting.
    expect(handlerEvent(hookCommand(EXEC, SCRIPT, 'permission-request'))).toBe('permission-request')
    expect(handlerEvent('unrelated --tool')).toBeNull()
  })

})

/**
 * Ownership was matched on the absolute script path, so a second
 * checkout did not recognise the first one's handlers as ours: both stayed,
 * the harness ran both, and one question produced two notifications.
 */
describe('two checkouts', () => {
  const OTHER = '/Users/rafael/other-checkout/apps/cli/dist/main.js'

  function documentWith(command: string): SettingsDocument {
    return { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 300 }] }] } }
  }

  function stopCommands(document: SettingsDocument): string[] {
    return (document.hooks?.['Stop'] ?? []).flatMap((group) => group.hooks.map((h) => h.command))
  }

  it('replaces a handler another checkout installed instead of running beside it', () => {
    const existing = documentWith(hookCommand(EXEC, OTHER, 'stop'))
    const merged = mergeHooks(
      existing,
      buildHookConfig({ execPath: EXEC, scriptPath: SCRIPT, replyTimeoutSeconds: 240, graceSeconds: 0 }),
      SCRIPT,
    )
    const commands = stopCommands(merged.document)
    expect(commands.filter((c) => c.includes('hook stop'))).toHaveLength(1)
    expect(commands[0]).toContain(SCRIPT)
    expect(commands.join(' ')).not.toContain(OTHER)
  })

  it('uninstalls a handler another checkout installed', () => {
    const removed = removeHooks(documentWith(hookCommand(EXEC, OTHER, 'stop')), SCRIPT)
    expect(stopCommands(removed.document)).toHaveLength(0)
  })

  it('still recognises an install that predates the marker', () => {
    // Same path, no marker: the form written by an older build.
    const legacy = documentWith(`'${EXEC}' '${SCRIPT}' hook stop`)
    expect(stopCommands(removeHooks(legacy, SCRIPT).document)).toHaveLength(0)
  })

  it("leaves someone else's hook alone", () => {
    const foreign = documentWith('/usr/local/bin/my-own-thing --stop')
    expect(stopCommands(removeHooks(foreign, SCRIPT).document)).toHaveLength(1)
  })
})

/**
 * OpenCode's extension point is a plugin module, not a command
 * hook, so it needs a different adapter — but deliberately not different logic.
 */
describe('the OpenCode adapter', () => {
  const source = opencodePluginSource({
    execPath: EXEC,
    scriptPath: SCRIPT,
    timeoutSeconds: 240,
  })

  it('shells out to the same hook commands the other harnesses run', () => {
    // The whole point: presence, escalation and retirement stay in the CLI.
    expect(source).toContain('"hook", event')
    expect(source).toContain('"--harness", "opencode"')
    expect(source).toContain(JSON.stringify(SCRIPT))
    expect(source).toContain(JSON.stringify(EXEC))
  })

  it('wires the three question lifecycle joints and leaves permissions alone', () => {
    expect(source).toContain('"chat.message"')
    expect(source).toContain('event: async ({ event })')
    expect(source).toContain('event?.type === "session.idle"')
    expect(source).toContain('event?.properties?.sessionID')
    expect(source).toContain('event?.type === "session.deleted"')
    expect(source).toContain('event?.properties?.info?.id')
    expect(source).not.toContain('"permission.ask"')
  })

  it('injects collected late answers into the next OpenCode user message', () => {
    expect(source).toContain('hookSpecificOutput?.additionalContext')
    expect(source).toContain('synthetic: true')
  })

  it('carries the ownership marker so a second checkout replaces it', () => {
    expect(source).toContain(OPENCODE_PLUGIN_MARKER)
    expect(isOurOpencodePlugin(source)).toBe(true)
    expect(isOurOpencodePlugin('export const SomeoneElse = () => ({})')).toBe(false)
  })

  it('installs beside the config rather than into it', () => {
    const local = opencodePluginPath(false, '/repo', {})
    expect(local).toBe(path.join('/repo', '.opencode', 'plugins', 'notifai.js'))
    const global = opencodePluginPath(true, '/repo', { OPENCODE_CONFIG_DIR: '/cfg/opencode' })
    expect(global).toBe(path.join('/cfg/opencode', 'plugins', 'notifai.js'))
  })

  it('is a harness `hooks install` knows about', () => {
    expect(HARNESSES).toContain('opencode')
    expect(settingsFile('opencode', false, '/repo', {})).toContain('notifai.js')
  })

  it('reports the build it will run, not its own path', () => {
    // `doctor` asks every handler which build it invokes. A plugin is a module
    // rather than a command line, so answering with the plugin's own path made
    // an ordinary OpenCode install look like a second checkout and turned the
    // duplicate check red on a healthy machine.
    expect(opencodePluginTarget(source)).toEqual({ exec: EXEC, script: SCRIPT, current: true })
    expect(opencodePluginTarget(source.replace(/^const ADAPTER_VERSION = .*\n/m, ''))).toEqual({
      exec: EXEC,
      script: SCRIPT,
      current: false,
    })
    expect(opencodePluginTarget('export const SomeoneElse = () => ({})')).toBeNull()
    // Ours, but with the constants edited beyond recognition: no answer beats
    // a wrong one, since the caller compares these for equality.
    expect(opencodePluginTarget(`${OPENCODE_PLUGIN_MARKER}\nconst EXEC = whatever\n`)).toBeNull()
  })
})

describe('detectHarness', () => {
  function project(...entries: string[]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-'))
    for (const entry of entries) {
      if (entry.endsWith('.md')) writeFileSync(path.join(dir, entry), '# project\n')
      else mkdirSync(path.join(dir, entry), { recursive: true })
    }
    return dir
  }

  it('detects Claude Code from a project .claude directory', () => {
    expect(detectHarness(project('.claude'))).toBe('claude-code')
  })

  it('detects Claude Code from CLAUDE.md alone', () => {
    // A repository worked in daily through Claude Code may never accumulate a
    // .claude/ directory; its project file is the only marker there is.
    expect(detectHarness(project('CLAUDE.md'))).toBe('claude-code')
  })

  it('detects Claude Code from .claude and CLAUDE.md together without double-counting', () => {
    expect(detectHarness(project('.claude', 'CLAUDE.md'))).toBe('claude-code')
  })

  it('does not infer a harness from AGENTS.md', () => {
    // AGENTS.md began as a Codex convention and is now read by most agent
    // tooling, Claude Code included. Naming a harness from it would be a guess
    // wearing detection's clothes. With no other project evidence this falls
    // through to machine evidence, which on a multi-tool machine is ambiguous.
    const dir = project('AGENTS.md')
    const answer = detectHarness(dir)
    expect(answer).not.toBe('codex')
    expect(HARNESSES.includes(answer as never) || answer === null).toBe(true)
  })

  it('pairs AGENTS.md with CLAUDE.md as Claude Code, not Codex', () => {
    // The shape this very repository has, and four of the five projects the
    // release was verified in.
    expect(detectHarness(project('CLAUDE.md', 'AGENTS.md'))).toBe('claude-code')
  })

  it('detects each harness from its own project directory', () => {
    expect(detectHarness(project('.codex'))).toBe('codex')
    expect(detectHarness(project('.cursor'))).toBe('cursor')
    expect(detectHarness(project('.opencode'))).toBe('opencode')
  })

  it('returns null when the project itself names two harnesses', () => {
    // Genuine ambiguity, and the caller must ask rather than pick. Not the
    // same as having no evidence.
    expect(detectHarness(project('.claude', '.codex'))).toBeNull()
  })

  it('prefers project evidence over anything installed on the machine', () => {
    // The regression. Machine-global markers used to be OR-ed in per harness,
    // so a developer with several agent tools installed got a candidate for
    // every one of them, the "exactly one" test never passed, and detection
    // returned null in every repository on that machine — including ones whose
    // own contents named a single harness unambiguously.
    //
    // This asserts the ordering rather than the machine state, so it holds on
    // a CI box with a bare home directory and on a developer laptop carrying
    // all four.
    expect(detectHarness(project('.cursor'))).toBe('cursor')
    expect(detectHarness(project('CLAUDE.md'))).toBe('claude-code')
  })

  it('falls back to machine evidence only when the project offers none', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-empty-'))
    // Whatever this machine has, an empty project must never crash and must
    // return either a single harness or null — never an arbitrary pick.
    const answer = detectHarness(empty)
    expect(answer === null || HARNESSES.includes(answer)).toBe(true)
  })
})
