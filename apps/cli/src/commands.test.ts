import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CapabilityDocument,
  ListRepliesResponse,
  ReplyView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@notifai/protocol'
import { describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import {
  askCommand,
  capabilitiesCommand,
  configSetCommand,
  contradictingAnswer,
  describeHookFailure,
  doctorCommand,
  EXIT,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  loginCommand,
  projectSlugFrom,
  repliesCommand,
  sendCommand,
  type CommandDeps,
  type CommandIo,
  type CommandSpinner,
} from './commands.js'
import { applyPlan, buildHookConfig } from './install-hooks.js'

class CapturedIo implements CommandIo {
  outLines: string[] = []
  errLines: string[] = []

  out(line: string) {
    this.outLines.push(line)
  }

  err(line: string) {
    this.errLines.push(line)
  }

  async confirm() {
    return false
  }

  openUrl() {}
}

class InteractiveIo extends CapturedIo {
  interactive = true
  selectAnswer: string | null = 'global'
  confirmAnswer = true
  prompts: string[] = []
  notes: { message: string; title?: string }[] = []
  intros: string[] = []
  outros: string[] = []
  spinnerEvents: string[] = []
  checks: { ok: boolean; message: string }[] = []

  override async confirm(question: string) {
    this.prompts.push(question)
    return this.confirmAnswer
  }

  async select(
    message: string,
    _options: { value: string; label: string; hint?: string }[],
  ): Promise<string | null> {
    this.prompts.push(message)
    return this.selectAnswer
  }

  async intro(title: string) {
    this.intros.push(title)
  }

  async outro(message: string) {
    this.outros.push(message)
  }

  async note(message: string, title?: string) {
    this.notes.push({ message, ...(title === undefined ? {} : { title }) })
  }

  async spinner(message: string): Promise<CommandSpinner> {
    this.spinnerEvents.push(`start:${message}`)
    return {
      message: (next) => this.spinnerEvents.push(`message:${next}`),
      stop: (next) => this.spinnerEvents.push(`stop:${next}`),
      error: (next) => this.spinnerEvents.push(`error:${next}`),
    }
  }

  async check(ok: boolean, message: string) {
    this.checks.push({ ok, message })
  }
}

function makeDeps(io: CapturedIo, client: ApiClient): CommandDeps {
  return {
    io,
    store: {
      load: () => ({
        machineId: 'mac_test',
        secret: 'test-secret',
        baseUrl: 'https://test.notifai.invalid',
        machineName: 'test-machine',
      }),
      save: () => {},
      clear: () => {},
      describe: () => 'test credential store',
    },
    env: { XDG_CONFIG_HOME: path.join(os.tmpdir(), 'notifai-cli-command-tests') },
    cwd: os.tmpdir(),
    clientFactory: () => client,
  }
}

const receipt: SubmissionReceipt = {
  request_id: 'req_reply_test',
  replayed: false,
  overall: 'provider_accepted_all',
  deliveries: [
    {
      delivery_id: 'del_reply_test',
      device_id: 'dev_test',
      device_name: 'iPhone',
      state: 'provider_accepted',
      attempts: 1,
      provider_status: 200,
      provider_reason: null,
      provider_id: 'provider_test',
      updated_at: '2026-08-01T18:00:00.000Z',
    },
  ],
  warnings: [],
}

const reply: ReplyView = {
  reply_id: 'rpl_test',
  seq: 1,
  delivery_id: 'del_reply_test',
  device_id: 'dev_test',
  device_name: 'iPhone',
  text: 'yes, after the migration',
  created_at: '2026-08-01T18:01:00.000Z',
}

function replyResponse(replies: ReplyView[] = []): ListRepliesResponse {
  return {
    request_id: receipt.request_id,
    reply_expires_at: '2026-08-02T18:00:00.000Z',
    replies,
  }
}

describe('command contracts', () => {
  it('renders capability field paths instead of array indexes', async () => {
    const io = new CapturedIo()
    const document: CapabilityDocument = {
      schema_version: 1,
      platform: 'ios',
      payload_limit_bytes: 4096,
      sounds: ['default'],
      interruption_levels: ['passive', 'active', 'time_sensitive'],
      fields: [
        { path: 'presentation.title', status: 'supported' },
        { path: 'platform.ios.category', status: 'unsupported', reason: 'Deferred from V1.' },
      ],
    }
    const client = { capabilities: async () => document } as unknown as ApiClient

    expect(await capabilitiesCommand(makeDeps(io, client), {})).toBe(EXIT.ok)
    expect(io.outLines).toContain('  presentation.title: supported')
    expect(io.outLines).toContain('  platform.ios.category: unsupported — Deferred from V1.')
    expect(io.outLines.some((line) => line.startsWith('  0:'))).toBe(false)
  })

  it('passes the selected macOS platform through to the capability client', async () => {
    const io = new CapturedIo()
    let requestedPlatform: string | undefined
    const document: CapabilityDocument = {
      schema_version: 1,
      platform: 'macos',
      payload_limit_bytes: 4096,
      sounds: ['default'],
      interruption_levels: ['passive', 'active', 'time_sensitive'],
      fields: [],
    }
    const client = {
      capabilities: async (platform?: string) => {
        requestedPlatform = platform
        return document
      },
    } as unknown as ApiClient

    expect(await capabilitiesCommand(makeDeps(io, client), { platform: 'macos' })).toBe(EXIT.ok)
    expect(requestedPlatform).toBe('macos')
    expect(io.outLines[0]).toBe('macos capability contract v1 (payload limit 4096 bytes)')
  })

  it('rejects an invalid draft before calling submit', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        throw new Error('submit should not be reached')
      },
    } as unknown as ApiClient

    expect(await sendCommand(makeDeps(io, client), { title: 'T', body: 'B', badge: -1 })).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('platform.ios.badge')
  })

  it('maps reply flags into the draft and does not poll with --no-block', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    let replyCalls = 0
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
      replies: async () => {
        replyCalls += 1
        return replyResponse()
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyWindow: 3_600,
        noBlock: true,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.reply).toEqual({ expires_in_seconds: 3_600 })
    expect(replyCalls).toBe(0)
  })

  it.each([
    { title: 'Deploy?   ', body: 'Ready.' },
    { title: 'Deployment', body: 'Should I deploy?\n' },
  ])('warns on stderr when $title / $body ends in a question after trimming', async (flags) => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(await sendCommand(makeDeps(io, client), flags)).toBe(EXIT.ok)
    expect(io.errLines).toEqual([
      'Heads up: this notification ends with a question but has no reply action. Add --reply (and optionally --reply-choice) so it can be answered from the notification.',
    ])
  })

  it('suppresses the question warning when --reply is present', async () => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Deploy?',
        body: 'Choose when ready.',
        reply: true,
        noBlock: true,
      }),
    ).toBe(EXIT.ok)
    expect(io.errLines).toEqual([])
  })

  it('rejects --reply-choice without the --reply action it configures', async () => {
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      submit: async () => {
        submitCalls += 1
        return receipt
      },
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Deploy?',
        body: 'Choose when ready.',
        replyChoice: ['Now', 'Later'],
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines).toEqual([
      'Use --reply with --reply-timeout, --reply-window, --reply-choice, or --no-block.',
    ])
  })

  it('keeps a warned JSON send successful and stdout machine-pure', async () => {
    const io = new CapturedIo()
    const client = { submit: async () => receipt } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Deployment',
        body: 'Should I deploy?',
        json: true,
      }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual(receipt)
    expect(io.errLines).toHaveLength(1)
  })

  it('loops in server-capped long polls until a reply arrives', async () => {
    const io = new CapturedIo()
    let now = 0
    const polls: { waitSeconds: number; afterSeq: number }[] = []
    const client = {
      submit: async () => receipt,
      replies: async (_requestId: string, options: { waitSeconds: number; afterSeq: number }) => {
        polls.push(options)
        now += options.waitSeconds * 1_000
        return replyResponse(polls.length === 3 ? [reply] : [])
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 60,
      }),
    ).toBe(EXIT.ok)
    expect(polls).toHaveLength(3)
    expect(polls.every((poll) => poll.waitSeconds <= 25)).toBe(true)
    expect(io.outLines.at(-1)).toBe('reply from iPhone: yes, after the migration')
  })

  it('backs off and retries a transient network error while waiting', async () => {
    const io = new CapturedIo()
    let now = 0
    let replyCalls = 0
    const sleeps: number[] = []
    const client = {
      submit: async () => receipt,
      replies: async () => {
        replyCalls += 1
        if (replyCalls === 1) throw new NetworkError('temporary disconnect')
        return replyResponse([reply])
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
    }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 10,
      }),
    ).toBe(EXIT.ok)
    expect(replyCalls).toBe(2)
    expect(sleeps).toEqual([250])
  })

  it('returns exit 3 with one JSON object when no reply arrives before the timeout', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      submit: async () => receipt,
      replies: async (_requestId: string, options: { waitSeconds: number }) => {
        now += options.waitSeconds * 1_000
        return replyResponse()
      },
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), now: () => now, sleep: async () => {} }

    expect(
      await sendCommand(deps, {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 1,
        json: true,
      }),
    ).toBe(EXIT.noReply)
    expect(io.outLines).toHaveLength(1)
    // `degraded` is part of the shape on every reply wait, not only when it is
    // true: an agent must be able to read it without knowing it might be absent.
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({ receipt, replies: [], degraded: false })
  })

  it('prints the stable send JSON shape when a reply is received', async () => {
    const io = new CapturedIo()
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 10,
        json: true,
      }),
    ).toBe(EXIT.ok)
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toEqual({
      receipt,
      replies: [reply],
      degraded: false,
    })
  })

  it('passes the replies cursor and prints replies for later retrieval', async () => {
    const io = new CapturedIo()
    let requested: { waitSeconds: number; afterSeq: number } | undefined
    const client = {
      replies: async (_requestId: string, options: { waitSeconds: number; afterSeq: number }) => {
        requested = options
        return replyResponse([reply])
      },
    } as unknown as ApiClient

    expect(await repliesCommand(makeDeps(io, client), receipt.request_id, { after: 7 })).toBe(EXIT.ok)
    expect(requested).toEqual({ waitSeconds: 0, afterSeq: 7 })
    expect(io.outLines).toEqual(['reply from iPhone: yes, after the migration'])
  })
})

describe('Cursor hook commands', () => {
  const execPath = '/usr/local/bin/node'
  const scriptPath = '/opt/notifai/dist/main.js'

  it('installs native Cursor hooks with a single bounded answer continuation', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-install-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)

    const installed = JSON.parse(
      readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf8'),
    ) as {
      version: number
      hooks: Record<string, { command: string; timeout?: number; loop_limit?: number }[]>
    }
    expect(installed.version).toBe(1)
    expect(Object.keys(installed.hooks).sort()).toEqual([
      'beforeSubmitPrompt',
      'sessionEnd',
      'stop',
    ])
    expect(installed.hooks['beforeSubmitPrompt']?.[0]?.command).toContain(
      'hook user-prompt-submit --owner notifai --harness cursor',
    )
    expect(installed.hooks['stop']?.[0]).toMatchObject({
      command: expect.stringContaining('hook stop --owner notifai --harness cursor'),
      loop_limit: 1,
    })
  })

  it('reports a native Cursor installation through doctor', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-doctor-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        HOME: path.join(cwd, 'home'),
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }
    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)
    io.outLines = []

    await doctorCommand(deps, {})

    expect(io.outLines).toContain(
      `ok    hooks: cursor project (${path.join(cwd, '.cursor', 'hooks.json')})`,
    )
    expect(io.outLines.some((line) => line.includes('Cursor: send one prompt'))).toBe(true)
  })

  it('uninstalls only NotifAI Cursor hooks and preserves foreign hooks', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-uninstall-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }
    expect(
      hooksInstallCommand(deps, { harness: 'cursor', execPath, scriptPath }),
    ).toBe(EXIT.ok)
    const file = path.join(cwd, '.cursor', 'hooks.json')
    const installed = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      hooks: Record<string, { command: string }[]>
    }
    installed.hooks['stop']?.unshift({ command: './keep-my-cursor-hook.sh' })
    writeFileSync(file, `${JSON.stringify(installed, null, 2)}\n`)

    expect(
      hooksUninstallCommand(deps, { harness: 'cursor', scriptPath }),
    ).toBe(EXIT.ok)

    const remaining = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      hooks: Record<string, { command: string }[]>
    }
    expect(remaining.version).toBe(1)
    expect(remaining.hooks['stop']).toEqual([{ command: './keep-my-cursor-hook.sh' }])
    expect(JSON.stringify(remaining)).not.toContain('--owner notifai')
  })
})

describe('harness activation guidance', () => {
  const execPath = '/usr/local/bin/node'
  const scriptPath = '/opt/notifai/dist/main.js'

  it('does not require a Claude Code restart for project hook files', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(
      hooksInstallCommand(deps, { harness: 'claude-code', execPath, scriptPath }),
    ).toBe(EXIT.ok)

    expect(io.outLines.join('\n')).toContain(
      'Claude Code reloads project hook files without a restart.',
    )
  })

  it('does not invent a Codex hook trust gate', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-activation-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(hooksInstallCommand(deps, { harness: 'codex', execPath, scriptPath })).toBe(
      EXIT.ok,
    )

    const output = io.outLines.join('\n')
    expect(output).toContain('Send one Codex prompt, then check `notifai doctor`.')
    expect(output).not.toMatch(/trust|approve/i)
  })

  it('keeps OpenCode permission prompts local and reports its continuation limit', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-activation-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const deps = { ...makeDeps(io, client), cwd }

    expect(hooksInstallCommand(deps, { harness: 'opencode', execPath, scriptPath })).toBe(
      EXIT.ok,
    )

    expect(io.outLines.join('\n')).toContain('Permission prompts stay in OpenCode.')
    expect(io.outLines.join('\n')).toContain('cannot reliably resume an idle agent turn')
    const pluginFile = path.join(cwd, '.opencode', 'plugins', 'notifai.js')
    const plugin = readFileSync(pluginFile, 'utf8')
    expect(plugin).toContain('const TIMEOUT_MS = 540000')

    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('hooks (opencode continuation)')
    expect(io.outLines.join('\n')).not.toContain('hooks (adapter)')

    writeFileSync(pluginFile, plugin.replace(/^const ADAPTER_VERSION = .*\n/m, ''))
    io.outLines = []
    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('hooks (adapter)')
    expect(io.outLines.join('\n')).toContain('obsolete OpenCode event wiring')
  })
})

describe('projectSlugFrom', () => {
  it('canonicalizes directory names into contract-valid slugs', () => {
    expect(projectSlugFrom('My App')).toBe('my-app')
    expect(projectSlugFrom('NotifAI')).toBe('notifai')
    expect(projectSlugFrom('--weird__Name.2')).toBe('weird__name.2')
    expect(projectSlugFrom('!!!')).toBe('project')
  })
})

describe('interactive command UX', () => {
  it('styles login pairing progress for a human terminal', async () => {
    const io = new InteractiveIo()
    let now = 0
    let savedMachine = ''
    let polls = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://test.notifai.invalid/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => {
        polls += 1
        return polls === 1 ? { status: 'pending' } : { status: 'approved', machine_id: 'mac_new' }
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      store: {
        load: () => null,
        save: (credential) => {
          savedMachine = credential.machineId
        },
        clear: () => {},
        describe: () => 'test credential store',
      },
    }

    expect(await loginCommand(deps, { name: 'workstation', open: false })).toBe(EXIT.ok)
    expect(io.intros).toEqual(['NotifAI sign in'])
    expect(io.notes).toEqual([
      {
        title: 'Approve this machine',
        message: 'Code: ABCD-EFGH\nhttps://test.notifai.invalid/pair/ABCD-EFGH',
      },
    ])
    expect(io.spinnerEvents).toEqual([
      'start:Waiting for approval…',
      'message:Waiting for approval…',
      'stop:Machine "workstation" approved',
    ])
    expect(io.outLines).toEqual([])
    expect(savedMachine).toBe('mac_new')
  })

  it('keeps unattended login progress plain and unstyled', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      beginPairing: async () => ({
        pairing_id: 'pair_test',
        code: 'ABCD-EFGH',
        approve_url: 'https://test.notifai.invalid/pair/ABCD-EFGH',
        expires_at: new Date(10_000).toISOString(),
        poll_interval_seconds: 1,
      }),
      pollPairing: async () => ({ status: 'approved', machine_id: 'mac_new' }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }

    expect(await loginCommand(deps, { open: false })).toBe(EXIT.ok)
    expect(io.outLines.slice(0, 3)).toEqual([
      'Pairing code: ABCD-EFGH',
      'Approve this machine at: https://test.notifai.invalid/pair/ABCD-EFGH',
      'Waiting for approval…',
    ])
  })

  it('asks a human to choose a config layer when no layer flag was passed', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-layer-'))
    const io = new InteractiveIo()
    io.selectAnswer = 'local'
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'sound', 'done', {})).toBe(EXIT.ok)
    expect(io.prompts[0]).toBe('Where should this setting live?')
    expect(io.prompts[1]).toContain(path.join(cwd, '.notifai', 'config.local.toml'))
    expect(readFileSync(path.join(cwd, '.notifai', 'config.local.toml'), 'utf8')).toContain(
      'sound = "done"',
    )
  })

  it('bypasses interactive config selection with --yes and uses the global default', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-global-'))
    const io = new InteractiveIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'sound', 'done', { yes: true })).toBe(EXIT.ok)
    expect(io.prompts).toEqual([])
    expect(readFileSync(path.join(cwd, 'xdg', 'notifai', 'config.toml'), 'utf8')).toContain(
      'sound = "done"',
    )
  })

  it('rejects numeric config values that resolution would otherwise silently clamp', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-config-bounds-'))
    const io = new CapturedIo()
    const configFile = path.join(cwd, 'xdg', 'notifai', 'config.toml')
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'xdg') },
    }

    expect(await configSetCommand(deps, 'ask_grace_seconds', '600', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(await configSetCommand(deps, 'ask_grace_seconds', '1.5', { yes: true })).toBe(
      EXIT.usage,
    )
    expect(io.errLines).toEqual([
      'ask_grace_seconds must be between 0 and 540.',
      '"1.5" is not an integer.',
    ])
    expect(existsSync(configFile)).toBe(false)
  })

  it('renders doctor checks through the styled seam for humans', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-style-'))
    const io = new InteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await doctorCommand(deps, {})).toBe(EXIT.failed)
    expect(io.intros).toEqual(['NotifAI doctor'])
    expect(io.checks.some((check) => !check.ok && check.message.startsWith('credential:'))).toBe(true)
    expect(io.checks.some((check) => check.ok && check.message.startsWith('contract:'))).toBe(true)
    expect(io.outLines).toEqual([])
  })

  it('keeps doctor JSON as one machine-readable stdout document', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-doctor-json-'))
    const io = new InteractiveIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: {
        XDG_CONFIG_HOME: path.join(cwd, 'config'),
        XDG_STATE_HOME: path.join(cwd, 'state'),
        CODEX_HOME: path.join(cwd, 'codex'),
        CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    await doctorCommand(deps, { json: true })
    expect(io.outLines).toHaveLength(1)
    expect(JSON.parse(io.outLines[0] ?? '{}')).toHaveProperty('checks')
    expect(io.intros).toEqual([])
    expect(io.checks).toEqual([])
  })
})

describe('init', () => {
  it('writes the project identifier into .notifai/config.toml and is idempotent', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'My Project-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, {})).toBe(EXIT.ok)
    const configPath = path.join(cwd, '.notifai', 'config.toml')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
    // Safe by default: without an explicit --skills opt-in, init only writes
    // configuration and never spawns the skill installer.
    expect(io.outLines.join('\n')).toContain('Agent skill not installed (optional)')
    expect(io.outLines.join('\n')).toContain('verify device readiness: notifai doctor')
    expect(io.outLines.join('\n')).not.toContain('All set.')

    io.outLines = []
    expect(await initCommand(deps, { skills: false })).toBe(EXIT.ok)
    expect(io.outLines.join('\n')).toContain('already configured')
  })

  it('honors an explicit --project-id', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-explicit-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, { projectId: 'Custom Name', skills: false })).toBe(EXIT.ok)
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain(
      'project = "custom-name"',
    )
  })

  it('run unattended, names the optional steps instead of running or asking about them', async () => {
    // An agent's init must not reach for npx or a prompt.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, {})).toBe(EXIT.ok)
    const out = io.outLines.join('\n')
    expect(out).toContain('no published skill source configured')
    expect(out).not.toContain('notifai init --skills')
    expect(out).toContain('notifai hooks install')
    expect(out).not.toContain('Installing the notifai agent skill')
  })

  it('fails explicitly when --skills requests the unpublished source', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skills-unpublished-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, { skills: true })).toBe(EXIT.failed)
    expect(io.errLines).toContain(
      'The optional agent skill is not published yet; this build has no skill source configured.',
    )
  })

  it('tells the user what only they can do when nothing is signed in', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-nocred-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.ok)
    expect(io.outLines.join('\n')).toContain('sign in: notifai login')
  })

  it('offers a present human the sign-in and respects a refusal', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-human-'))
    const asked: string[] = []
    const io = new (class extends CapturedIo {
      interactive = true
      override async confirm(question: string) {
        asked.push(question)
        return false
      }
    })()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.ok)
    expect(asked.some((q) => q.includes('Sign in'))).toBe(true)
    expect(io.outLines.join('\n')).toContain('sign in: notifai login')
  })
})

describe('an outage is not an answer', () => {
  /**
   * The dangerous shape: the first poll succeeds, then connectivity drops and
   * never comes back. waitForReply only throws when NO poll ever succeeded, so
   * this used to return the stale empty response as a plain exit 3 — and an
   * agent scripted to read exit 3 as "nobody objected" would proceed against a
   * refusal it never saw.
   */
  function outageAfterFirstPoll(io: CapturedIo): CommandDeps {
    let now = 0
    let polls = 0
    const client = {
      submit: async () => receipt,
      replies: async () => {
        polls += 1
        if (polls === 1) return replyResponse([])
        throw new NetworkError('link went down')
      },
    } as unknown as ApiClient
    return {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds
      },
    }
  }

  it('does not report an unreachable server as "no reply yet"', async () => {
    const io = new CapturedIo()
    const exit = await sendCommand(outageAfterFirstPoll(io), {
      title: 'Question',
      body: 'Deploy to production?',
      reply: true,
      replyTimeout: 10,
    })

    // Whatever code this is, it must not be the one that means "asked, and the
    // user stayed silent".
    expect(exit).not.toBe(EXIT.noReply)
    expect(exit).toBe(EXIT.network)
    expect(io.errLines.join('\n')).toContain('could not find out')
  })

  it('marks the JSON so an agent reading it programmatically can tell', async () => {
    const io = new CapturedIo()
    await sendCommand(outageAfterFirstPoll(io), {
      title: 'Question',
      body: 'Deploy?',
      reply: true,
      replyTimeout: 10,
      json: true,
    })

    const payload = JSON.parse(io.outLines[0] ?? '{}') as { degraded: boolean }
    expect(payload.degraded).toBe(true)
  })

  it('still reports a genuine silence as no-reply', async () => {
    const io = new CapturedIo()
    let now = 0
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([]),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    }

    expect(
      await sendCommand(deps, { title: 'Q', body: 'B', reply: true, replyTimeout: 5 }),
    ).toBe(EXIT.noReply)
  })
})

describe('asking before the hooks have ever run', () => {
  it('tells Claude Code to send a prompt without falsely requiring a restart', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-firstrun-'))
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), {
      hooks: buildHookConfig({
        execPath: '/usr/bin/node',
        scriptPath: '/opt/notifai/main.js',
        replyTimeoutSeconds: 180,
        graceSeconds: 300,
      }),
    })

    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd, env: { XDG_STATE_HOME: cwd } }

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    const said = io.errLines.join(' ')
    expect(said).toMatch(/project hook files reload without a restart/i)
    expect(said).not.toMatch(/Run `notifai hooks install` and send one prompt/)
  })

  it('says to install when nothing is installed at all', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-noinstall-'))
    const io = new CapturedIo()
    const deps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      env: { XDG_STATE_HOME: cwd, CODEX_HOME: path.join(cwd, 'none'), CLAUDE_CONFIG_DIR: path.join(cwd, 'none') },
    }

    expect(askCommand(deps, 'Ship it?', {})).toBe(EXIT.usage)
    expect(io.errLines.join(' ')).toMatch(/hooks install/)
  })
})

/**
 * A CLI newer than its server produced "hook failed, deferring to
 * the terminal", which reads like a flaky network, while escalation was in
 * fact completely broken in production.
 */
describe('a server behind this CLI', () => {
  it('names the field the server rejected instead of swallowing it', () => {
    const rejection = new ApiCallError(422, 'unsupported_field', 'The draft was not accepted.', null, [
      { code: 'unsupported_field', path: '/lifecycle', message: 'Unknown property.' },
    ])

    const said = describeHookFailure(rejection).join(' ')

    expect(said).toContain('/lifecycle')
    expect(said).toContain('unsupported_field')
    // And says which way round the mismatch is, which is the whole diagnosis.
    expect(said).toMatch(/server is older than this CLI/)
  })

  it('still reports a plain failure for anything that is not a rejection', () => {
    const said = describeHookFailure(new Error('socket hang up')).join(' ')
    expect(said).toContain('socket hang up')
    expect(said).not.toMatch(/older than this CLI/)
  })

  it('doctor says plainly that the server needs deploying', async () => {
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      // A server one schema version behind this build.
      capabilities: async () => ({ schema_version: 0, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skew-'))
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test store' },
    } as CommandDeps

    await doctorCommand(deps, {})

    const said = io.outLines.concat(io.errLines).join(' ')
    expect(said).toMatch(/contract/)
    expect(said).toMatch(/needs deploying/)
  })

  it('doctor is quiet when both sides agree', async () => {
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-noskew-'))
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test store' },
    } as CommandDeps

    await doctorCommand(deps, {})

    expect(io.outLines.concat(io.errLines).join(' ')).not.toMatch(/needs deploying|update the CLI/)
  })
})

/** First-reply-wins is the right default, silently is the wrong way. */
describe('a second device that disagrees', () => {
  function view(overrides: Partial<ReplyView>): ReplyView {
    return {
      reply_id: 'rpl',
      seq: 1,
      delivery_id: 'del',
      device_id: 'dev',
      device_name: 'iPhone',
      text: 'Yes',
      choice_id: null,
      created_at: new Date().toISOString(),
      ...overrides,
    }
  }

  it('says which answer counted and which was discarded', () => {
    const said = contradictingAnswer([
      view({ seq: 1, device_name: 'iPhone', text: 'Yes' }),
      view({ seq: 2, device_name: 'FurankuMac', text: 'No' }),
    ])
    expect(said).toContain('"Yes" from iPhone')
    expect(said).toContain('FurankuMac')
    expect(said).toMatch(/arrived first/)
  })

  it('is silent when the second answer agrees', () => {
    expect(
      contradictingAnswer([
        view({ seq: 1, device_name: 'iPhone', text: 'Ship it', choice_id: 'ship' }),
        view({ seq: 2, device_name: 'FurankuMac', text: 'Ship it', choice_id: 'ship' }),
      ]),
    ).toBeNull()
  })

  it('is silent for a single answer', () => {
    expect(contradictingAnswer([view({})])).toBeNull()
    expect(contradictingAnswer([])).toBeNull()
  })
})
