#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import {
  askCommand,
  accessStatusCommand,
  authStatusCommand,
  capabilitiesCommand,
  closeCommand,
  configSetCommand,
  configShowCommand,
  devicesCommand,
  doctorCommand,
  hookRunCommand,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  loginCommand,
  logoutCommand,
  realIo,
  repliesCommand,
  sendCommand,
  statusCommand,
  type CommandDeps,
} from './commands.js'
import { defaultCredentialStore } from './credentials.js'
import { HARNESSES } from './install-hooks.js'
import type { Platform } from '@raidiant/notifai-protocol'
import { nativeSkills, type SkillScope } from './native-skills.js'

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
}

/**
 * Harness hooks deliver their event payload on stdin. Bounded on both time and
 * size: a wrapper that opens the pipe without writing would otherwise hold the
 * read until the harness killed the hook, delaying the user's own prompt.
 */
async function readStdin(timeoutMs = 2000, maxBytes = 1_000_000): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    process.stdin.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) return finish()
      chunks.push(chunk)
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

/**
 * One source of truth for the version: the manifest npm actually published.
 *
 * It was hardcoded here as well, and the first patch release proved why that
 * does not hold — `package.json` moved and `notifai --version` kept reporting
 * the old number, which is exactly the string someone pastes into a bug report
 * to say what they are running.
 */
function version(): string {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version
    }
  } catch {
    // Fall through: an unreadable manifest must not stop the CLI running.
  }
  return 'unknown'
}

const program = new Command('notifai')
  .description('Send native device notifications from agents and local programs')
  .version(version())

// Setup leads: `init` is the single entry command for first-run friendliness.
program
  .command('init')
  .description(
    'Set up Notifai here, idempotently: sign-in, project id, hooks, device readiness, live receipt proof. ' +
      'Interactive at a human terminal; never prompts otherwise (agents: pass flags)',
  )
  .option('--project-id <id>', 'project identifier slug (default: derived from the directory name)')
  .option('--skills', 'install/update the agent skill from its pinned public release')
  .option('--no-skills', 'suppress the optional agent-skill status line')
  .option('--skills-scope <scope>', 'unattended skill scope: project or global')
  .option('--hooks', 'install harness hooks for registered-question routing')
  .option('--no-hooks', 'skip the hooks without being asked')
  .action(async (opts: { projectId?: string; skills?: boolean; skillsScope?: SkillScope; hooks?: boolean }) => {
    process.exit(await initCommand(deps, opts))
  })

program
  .command('doctor')
  .description('Audit config, credential, server, contract, device, hook, and saved receipt proof (no live send)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await doctorCommand(deps, opts))
  })

program
  .command('login')
  .description('Pair this machine with your Notifai account via browser approval')
  .option('--name <name>', 'machine name shown in the dashboard (default: hostname)')
  .option('--base-url <url>', 'Notifai server URL')
  .option('--no-open', 'do not open the approval page in a browser')
  .action(async (opts: { name?: string; baseUrl?: string; open?: boolean }) => {
    process.exit(await loginCommand(deps, opts))
  })

program
  .command('logout')
  .description('Remove the stored machine credential')
  .action(() => {
    process.exit(logoutCommand(deps))
  })

const auth = program.command('auth').description('Authentication helpers')
auth
  .command('status')
  .description('Show the stored machine identity')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    process.exit(authStatusCommand(deps, opts))
  })
auth
  .command('access')
  .description('Show the account plan and access decision')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await accessStatusCommand(deps, opts))
  })

program
  .command('devices')
  .description('List registered devices and their delivery readiness')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await devicesCommand(deps, opts))
  })

program
  .command('capabilities')
  .description('Show a platform capability contract')
  .option('--platform <platform>', 'platform to describe (default: ios)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean; platform?: Platform }) => {
    process.exit(await capabilitiesCommand(deps, opts))
  })

program
  .command('send')
  .description('Send a notification')
  .requiredOption('--title <title>', 'notification title')
  .requiredOption('--body <body>', 'notification body')
  .option('--subtitle <subtitle>')
  .option('--detail <markdown>', 'long-form markdown shown only in the app, never on the banner')
  .option('--detail-file <path>', 'read --detail from a file (use - for stdin)')
  .option('--event <event>', 'agent event name, e.g. tests_passed')
  .option('--kind <kind>', 'what this is: update (default) | done | question (requires --reply)')
  .option('--project <id>', 'project identifier, e.g. my-app (lazily registered)')
  .option('--session <id>', 'session identity (env: NOTIFAI_SESSION); presentation varies by surface')
  .option('--device <id>', 'target a device id (repeatable)', (v: string, all: string[]) => [...all, v], [])
  .option('--all', 'target all routable devices (overrides configured devices)')
  .option('--ttl <seconds>', 'delivery window in seconds', (v: string) => Number(v))
  .option('--collapse-key <key>', 'replace earlier notifications with the same key')
  .option('--platform <platform>', 'platform whose optional fields to include (default: ios)')
  .option('--sound <sound>', 'default | done | attention | alert | none')
  .option('--badge <n>', 'app badge count', (v: string) => Number(v))
  .option('--thread-id <id>', 'group related notifications')
  .option('--level <level>', 'interruption level: passive | active | time_sensitive')
  .option('--relevance <score>', '0..1 relevance score', (v: string) => Number(v))
  .option('--target-content-id <id>')
  .option('--data <key=value>', 'custom data (repeatable)', (v: string, all: string[]) => [...all, v], [])
  .option('--image <path|url|media_id>', 'upload or attach an image')
  .option('--reply', 'enable the inline reply action and block for the answer')
  .option('--reply-timeout <seconds>', 'how long to wait for a reply (default: 900)', (v: string) => Number(v))
  .option('--reply-window <seconds>', 'how long the server accepts a reply (default: 3600)', (v: string) => Number(v))
  .option(
    '--reply-choice <label>',
    'with --reply, ask a closed question (2-6 answers); one value splits on commas, or repeat the flag',
    (v: string, all: string[]) => [...all, v], [],
  )
  // Kept registered, and always a usage error with --reply, so the caller gets
  // a message pointing at `ask` instead of "unknown option".
  .option('--no-block', 'rejected with --reply; use `notifai ask` to ask and end the turn')
  .option('--wait <seconds>', 'how long to wait for provider outcomes', (v: string) => Number(v))
  .option('--no-wait', 'return immediately after acceptance')
  .option('--idempotency-key <key>', 'safe-retry key (default: random)')
  .option('--base-url <url>', 'Notifai server URL')
  .option('--json', 'print the full submission receipt as JSON')
  .action(async (opts: Record<string, unknown>) => {
    // commander maps --no-wait onto the same "wait" flag; disentangle.
    const noWait = opts['wait'] === false
    const wait = typeof opts['wait'] === 'number' ? opts['wait'] : undefined
    const noBlock = opts['block'] === false
    const sendOpts = { ...opts }
    // Same empty-collector normalisation as `ask`.
    if (Array.isArray(sendOpts['replyChoice']) && sendOpts['replyChoice'].length === 0) {
      delete sendOpts['replyChoice']
    }
    delete sendOpts['block']
    // Long-form detail is usually a build log or a diff summary, which nobody
    // wants to shell-escape onto a command line.
    const detailFile = sendOpts['detailFile']
    delete sendOpts['detailFile']
    if (typeof detailFile === 'string') {
      if (sendOpts['detail'] !== undefined) {
        deps.io.err('Pass either --detail or --detail-file, not both.')
        process.exit(2)
      }
      try {
        sendOpts['detail'] = readFileSync(detailFile === '-' ? 0 : detailFile, 'utf8')
      } catch (err) {
        deps.io.err(`Could not read ${detailFile}: ${String(err)}`)
        process.exit(2)
      }
    }
    const flags = { ...sendOpts, noWait, noBlock } as Parameters<typeof sendCommand>[1]
    if (wait === undefined) delete (flags as { wait?: number }).wait
    else flags.wait = wait
    process.exit(await sendCommand(deps, flags))
  })

program
  .command('replies [request_id]')
  .description('Retrieve replies for a notification request')
  .option('--pending', 'use the pushed question pending for this project session')
  .option('--wait <seconds>', 'how long to wait for a reply', (v: string) => Number(v))
  .option('--after <seq>', 'return replies after this sequence number', (v: string) => Number(v))
  .option('--json', 'machine-readable output')
  .action(async (requestId: string | undefined, opts: { wait?: number; after?: number; json?: boolean; pending?: boolean }) => {
    process.exit(await repliesCommand(deps, requestId, opts))
  })

program
  .command('status <request_id>')
  .description('Show the evidence trail for a notification request')
  .option('--json', 'machine-readable output')
  .action(async (requestId: string, opts: { json?: boolean }) => {
    process.exit(await statusCommand(deps, requestId, opts))
  })

program
  .command('ask <question>')
  .description('Register a question for the turn-end hook to route under your presence settings')
  .option(
    '--choice <label>',
    'answers to offer instead of free text (2-6); one value splits on commas, or repeat the flag',
    (v: string, all: string[]) => [...all, v], [],
  )
  .option('--session <id>', 'session id (default: the session working in this directory, else $NOTIFAI_SESSION)')
  .action((question: string, opts: { choice?: string[]; session?: string }) => {
    // commander's collector defaults to []; an empty list means "not asked".
    const flags: Parameters<typeof askCommand>[2] = {
      ...(opts.session !== undefined ? { session: opts.session } : {}),
      ...(opts.choice?.length ? { choice: opts.choice } : {}),
    }
    process.exit(askCommand(deps, question, flags))
  })

program
  .command('close <request_id>')
  .description('Retire a question so late answers are rejected rather than lost')
  .action(async (requestId: string) => {
    process.exit(await closeCommand(deps, requestId))
  })

program
  .command('hook <event>')
  .description('Internal: run a harness hook (reads hook JSON on stdin)')
  // Inert, and the point of it is that it is inert: the installed command line
  // carries a marker that says "Notifai wrote this" independently of which
  // checkout wrote it.
  .option('--owner <name>', 'internal ownership marker')
  .option('--harness <name>', 'internal harness output adapter')
  .action(async (event: string, opts: { harness?: string }) => {
    const harness = HARNESSES.find((candidate) => candidate === opts.harness)
    process.exit(
      await hookRunCommand(deps, event, readStdin, harness),
    )
  })

const hooks = program.command('hooks').description('Install harness hooks for registered-question routing')
hooks
  .command('install')
  .description('Wire this harness to route registered questions to your devices')
  .option(
    '--harness <name>',
    'claude-code | codex | cursor | opencode (default: detected; OpenCode delivers answers on the next prompt)',
  )
  .option('--global', 'install for every project instead of just this one')
  .action((opts: { harness?: string; global?: boolean }) => {
    process.exit(hooksInstallCommand(deps, opts))
  })
hooks
  .command('uninstall')
  .description('Remove the hooks this CLI installed')
  .option('--harness <name>', 'claude-code | codex | cursor | opencode (default: detected)')
  .option('--global', 'remove the machine-wide install')
  .action((opts: { harness?: string; global?: boolean }) => {
    process.exit(hooksUninstallCommand(deps, opts))
  })

const config = program.command('config').description('Show or change configuration')
config
  .command('show')
  .description('Show the resolved configuration')
  .option('--explain', 'show where each value comes from')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean; explain?: boolean }) => {
    process.exit(configShowCommand(deps, opts))
  })
config
  .command('set <key> <value>')
  .description(
    'Set a configuration value (choose a layer interactively; unattended defaults machine-global and requires --yes)',
  )
  .option('--project', 'write to the shared .notifai/config.toml instead')
  .option('--local', 'write to personal .notifai/config.local.toml (keep it gitignored)')
  .option('--session <id>', 'apply only to one session')
  .option('--yes', 'skip the confirmation gate')
  .action(
    async (
      key: string,
      value: string,
      opts: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
    ) => {
      process.exit(await configSetCommand(deps, key, value, opts))
    },
  )

await program.parseAsync(process.argv)
