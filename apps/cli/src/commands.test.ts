import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CapabilityDocument,
  EvidenceSnapshot,
  ListRepliesResponse,
  ReplyView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import {
  askCommand,
  accessStatusCommand,
  assessReadiness,
  capabilitiesCommand,
  configSetCommand,
  contradictingAnswer,
  describeHookFailure,
  doctorCommand,
  EXIT,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  SKILLS_SOURCE,
  loginCommand,
  projectSlugFrom,
  repliesCommand,
  sendCommand,
  statusCommand,
  type CommandDeps,
  type CommandIo,
  type CommandSpinner,
} from './commands.js'
import { applyPlan, buildHookConfig } from './install-hooks.js'
import type { NativeSkill, NativeSkills, SkillScope } from './native-skills.js'

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
  it('shows an actionable no-plan access state', async () => {
    const io = new CapturedIo()
    const client = {
      accessStatus: async () => ({
        status: 'no_active_plan',
        reason: 'no_active_grant',
        expires_at: null,
      }),
    } as unknown as ApiClient

    expect(await accessStatusCommand(makeDeps(io, client), {})).toBe(EXIT.failed)
    expect(io.outLines).toEqual([
      'No active plan or temporary Alpha access for this account.',
      'next: Ask a platform administrator to grant temporary Alpha access, then retry.',
    ])
  })

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

  it('rejects a question nobody will wait for', async () => {
    // --reply asks; --no-block declares nothing will wait. The answer would be
    // captured server-side and then reachable only by hand, so the user taps a
    // real button and nothing happens — worse than never asking, because it
    // spends their attention and their trust in the channel.
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
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyWindow: 3_600,
        noBlock: true,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('notifai ask')
  })

  it('maps reply flags into the draft and waits for the answer', async () => {
    const io = new CapturedIo()
    let submitted: SubmitNotificationRequestT | undefined
    const client = {
      submit: async (body: SubmitNotificationRequestT) => {
        submitted = body
        return receipt
      },
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyWindow: 3_600,
        replyTimeout: 30,
      }),
    ).toBe(EXIT.ok)
    expect(submitted?.draft.reply).toEqual({ expires_in_seconds: 3_600 })
  })

  it('rejects --reply-timeout 0, the other spelling of nobody waiting', async () => {
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
        title: 'Question',
        body: 'Deploy?',
        reply: true,
        replyTimeout: 0,
      }),
    ).toBe(EXIT.usage)
    expect(submitCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('notifai ask')
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
    const client = {
      submit: async () => receipt,
      replies: async () => replyResponse([reply]),
    } as unknown as ApiClient

    expect(
      await sendCommand(makeDeps(io, client), {
        title: 'Deploy?',
        body: 'Choose when ready.',
        reply: true,
        replyTimeout: 30,
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

describe('delivery evidence status', () => {
  function snapshot(
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
  ): EvidenceSnapshot {
    return {
      request_id: 'req_status_test',
      event: 'tests_passed',
      accepted_at: '2026-08-05T13:05:48.000Z',
      overall: 'provider_accepted_all',
      deliveries: [
        {
          delivery_id: 'del_status_test',
          device_id: 'dev_status_test',
          device_name: 'iPhone',
          state: 'provider_accepted',
          attempts: 1,
          provider_status: 200,
          provider_reason: null,
          provider_id: 'provider_status_test',
          updated_at: '2026-08-05T13:05:50.000Z',
          companion_receipt: companionReceipt,
          events: [
            {
              stage: 'attempt_started',
              source: 'worker',
              reason: null,
              attempt: 1,
              occurred_at: '2026-08-05T13:05:49.000Z',
            },
            {
              stage: 'provider_accepted',
              source: 'worker',
              reason: null,
              attempt: 1,
              occurred_at: '2026-08-05T13:05:50.000Z',
            },
          ],
        },
      ],
    }
  }

  it('calls an unobserved first-minute receipt unknown rather than failed', async () => {
    const io = new CapturedIo()
    const client = {
      evidence: async () => snapshot({ state: 'unknown', observed_at: null, latency_ms: null }),
    } as unknown as ApiClient

    expect(await statusCommand(makeDeps(io, client), 'req_status_test', {})).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain('Provider Acceptance: accepted')
    expect(said).toContain('Companion Receipt: unknown')
    expect(said).toContain('not a failure')
    expect(said).toContain('attempt_started')
  })

  it('reports the observed device receipt and measured provider-to-companion latency', async () => {
    const io = new CapturedIo()
    const client = {
      evidence: async () =>
        snapshot({
          state: 'observed',
          observed_at: '2026-08-05T13:17:17.000Z',
          latency_ms: 687_000,
        }),
    } as unknown as ApiClient

    expect(await statusCommand(makeDeps(io, client), 'req_status_test', {})).toBe(EXIT.ok)
    const said = io.outLines.join('\n')
    expect(said).toContain('Companion Receipt: observed')
    expect(said).toContain('11m 27s after Provider Acceptance')
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
      `ok    Question routing: cursor project (${path.join(cwd, '.cursor', 'hooks.json')})`,
    )
    expect(io.outLines.some((line) => line.includes('Cursor: send one prompt'))).toBe(true)
  })

  it('uninstalls only Notifai Cursor hooks and preserves foreign hooks', () => {
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
    expect(projectSlugFrom('Notifai')).toBe('notifai')
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
    expect(io.intros).toEqual(['Notifai sign in'])
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
    expect(io.intros).toEqual(['Notifai doctor'])
    expect(io.checks.some((check) => !check.ok && check.message.startsWith('This machine:'))).toBe(true)
    expect(io.checks.some((check) => check.ok && check.message.startsWith('Protocol version:'))).toBe(true)
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
    expect(JSON.parse(io.outLines[0] ?? '{}')).toHaveProperty('states')
    expect(io.intros).toEqual([])
    expect(io.checks).toEqual([])
  })
})

describe('init', () => {
  const readyIphone = {
    device_id: 'dev_iphone',
    display_name: 'iPhone',
    platform: 'ios' as const,
    permission_status: 'authorized',
    registration_healthy: true,
    last_seen_at: '2026-08-05T18:00:00.000Z',
  }

  function setupEvidence(
    requestId: string,
    companionReceipt: EvidenceSnapshot['deliveries'][number]['companion_receipt'],
    device = readyIphone,
  ): EvidenceSnapshot {
    return {
      request_id: requestId,
      event: 'setup_verified',
      accepted_at: '2026-08-05T18:00:00.000Z',
      overall: 'provider_accepted_all',
      deliveries: [
        {
          delivery_id: 'del_setup',
          device_id: device.device_id,
          device_name: device.display_name,
          state: 'provider_accepted',
          attempts: 1,
          provider_status: 200,
          provider_reason: null,
          provider_id: 'provider_setup',
          updated_at: '2026-08-05T18:00:01.000Z',
          companion_receipt: companionReceipt,
          events:
            companionReceipt.state === 'observed'
              ? [
                  {
                    stage: 'companion_received',
                    source: 'companion',
                    reason: null,
                    attempt: null,
                    occurred_at: companionReceipt.observed_at!,
                  },
                ]
              : [],
        },
      ],
    }
  }

  function setupReceipt(requestId = 'req_setup'): SubmissionReceipt {
    return {
      ...receipt,
      request_id: requestId,
      deliveries: [
        {
          ...receipt.deliveries[0]!,
          device_id: readyIphone.device_id,
          device_name: readyIphone.display_name,
        },
      ],
    }
  }

  function managedSkill(scope: SkillScope, cwd: string): NativeSkill {
    return {
      name: 'notifai',
      scope,
      path: path.join(cwd, '.agents', 'skills', 'notifai'),
      source: 'RafaelVidaurre/notifai',
      sourceType: 'github',
      sourceUrl: 'https://github.com/RafaelVidaurre/notifai.git',
      ref: 'v0.1.8',
    }
  }

  function setupReadyDeps(
    io: CapturedIo,
    cwd: string,
    nativeSkills: NativeSkills,
    calls: { submit: number },
  ): CommandDeps {
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        calls.submit += 1
        return setupReceipt()
      },
      evidence: async () =>
        setupEvidence('req_setup', {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    return {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
      nativeSkills,
    }
  }

  it('writes the project identifier into .notifai/config.toml and is idempotent', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'My Project-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const configPath = path.join(cwd, '.notifai', 'config.toml')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
    // Safe by default: without an explicit --skills opt-in, init only writes
    // configuration and never spawns the skill installer.
    expect(io.outLines.join('\n')).not.toContain('Installing the notifai agent skill')
    expect(io.outLines.join('\n')).not.toContain('All set.')

    io.outLines = []
    expect(await initCommand(deps, { skills: false })).toBe(EXIT.failed)
    // Idempotent: the second run re-derives the same slug and says so as a
    // settled state rather than repeating the write.
    expect(io.outLines.join('\n')).toContain('Project identity: "my-project-')
    expect(readFileSync(configPath, 'utf8')).toContain('project = "my-project-')
  })

  it('surfaces one next step, not the whole remaining list', async () => {
    // The behavioural core of the design: someone handed five things to do
    // does none of them. Signing in gates the device check, so naming both
    // would send the reader to fix something not yet known to be wrong.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-one-step-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, { health: async () => true } as unknown as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: cwd, XDG_STATE_HOME: cwd },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: This machine')
    expect(out).toContain('notifai login')
    // The device gap is real and downstream; it must stay hidden until the
    // sign-in that would let anyone actually check it has happened.
    expect(out).not.toContain('companion app')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('honors an explicit --project-id', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-explicit-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, { projectId: 'Custom Name', skills: false })).toBe(EXIT.failed)
    expect(readFileSync(path.join(cwd, '.notifai', 'config.toml'), 'utf8')).toContain(
      'project = "custom-name"',
    )
  })

  it('run unattended, names the optional steps instead of running or asking about them', async () => {
    // An agent's init must not reach for npx or a prompt.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-'))
    const io = new CapturedIo()
    const deps = { ...makeDeps(io, {} as ApiClient), cwd }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).not.toContain('Installing the notifai agent skill')
    // Never prompted, and never assumed into a change it did not request.
    expect(io.errLines).toEqual([])
  })

  it('pins the skill installer to the tagged public release syntax', () => {
    expect(SKILLS_SOURCE).toBe('RafaelVidaurre/notifai#v0.1.8')
    expect(SKILLS_SOURCE).not.toContain('@v')
  })

  it('recognizes a skill installed from the exact immutable release', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-pinned-skill-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const nativeSkills: NativeSkills = {
      add: async () => 0,
      list: async (scope) => ({
        skills: [
          {
            name: 'notifai',
            scope,
            path: path.join(cwd, '.agents', 'skills', 'notifai'),
            source: 'RafaelVidaurre/notifai',
            sourceType: 'github',
            sourceUrl: 'https://github.com/RafaelVidaurre/notifai.git',
            ref: 'v0.1.8',
          },
        ],
      }),
    }
    const readiness = await assessReadiness(
      { ...makeDeps(io, client), cwd, nativeSkills },
      { skillScope: 'project' },
    )
    expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE} in the project scope`,
    })
  })

  it.each(['project', 'global'] as const)(
    'recognizes native installer provenance in the selected %s scope',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-managed-${scope}-`))
      const io = new CapturedIo()
      const client = {
        health: async () => true,
        capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
        listDevices: async () => ({ devices: [] }),
      } as unknown as ApiClient
      const calls: SkillScope[] = []
      const nativeSkills: NativeSkills = {
        add: async () => 0,
        list: async (selected) => {
          calls.push(selected)
          return { skills: [managedSkill(selected, cwd)] }
        },
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'ready',
        detail: `installed from ${SKILLS_SOURCE} in the ${scope} scope`,
      })
      expect(calls).toEqual([scope])
    },
  )

  it.each(['project', 'global'] as const)(
    'does not trust unmanaged same-path content in the %s scope',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-unmanaged-${scope}-`))
      const io = new CapturedIo()
      const client = {
        health: async () => true,
        capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
        listDevices: async () => ({ devices: [] }),
      } as unknown as ApiClient
      const nativeSkills: NativeSkills = {
        add: async () => 0,
        list: async (selected) => ({
          skills: [{ ...managedSkill(selected, cwd), source: null, sourceType: null, ref: null }],
        }),
      }

      const readiness = await assessReadiness(
        { ...makeDeps(io, client), cwd, nativeSkills },
        { skillScope: scope },
      )
      expect(readiness.states.find((state) => state.id === 'skill')).toMatchObject({
        status: 'optional-gap',
        detail: `not installed from ${SKILLS_SOURCE} in ${scope} scope`,
      })
    },
  )

  it('requires an explicit skill scope before unattended installation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-scope-required-'))
    const io = new CapturedIo()
    let addCalls = 0
    const nativeSkills: NativeSkills = {
      add: async () => {
        addCalls += 1
        return 0
      },
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand({ ...makeDeps(io, {} as ApiClient), cwd, nativeSkills }, { skills: true })).toBe(
      EXIT.usage,
    )
    expect(addCalls).toBe(0)
    expect(io.errLines.join('\n')).toContain('--skills-scope project')
  })

  it('rejects an invalid unattended skill scope instead of guessing', async () => {
    const io = new CapturedIo()
    expect(
      await initCommand(
        { ...makeDeps(io, {} as ApiClient), cwd: mkdtempSync(path.join(os.tmpdir(), 'init-skill-invalid-')) },
        { skills: true, skillsScope: 'machine' as SkillScope },
      ),
    ).toBe(EXIT.usage)
    expect(io.errLines.join('\n')).toContain('Choose `project` or `global`')
  })

  it.each(['project', 'global'] as const)(
    'passes an unattended %s choice to the native installer and continues setup',
    async (scope) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `init-skill-${scope}-`))
      const io = new CapturedIo()
      const calls: { submit: number } = { submit: 0 }
      let installed = false
      let receivedScope: SkillScope | undefined
      const nativeSkills: NativeSkills = {
        add: async (options) => {
          receivedScope = options.scope
          installed = true
          return 0
        },
        list: async (selected) => ({
          skills: installed && selected === scope ? [managedSkill(scope, cwd)] : [],
        }),
      }

      const result = await initCommand(
        setupReadyDeps(io, cwd, nativeSkills, calls),
        { skills: true, skillsScope: scope, hooks: false },
      )
      expect(result).toBe(EXIT.ok)
      expect(receivedScope).toBe(scope)
      expect(calls.submit).toBe(1)
      expect(io.outLines.join('\n')).toContain('All set.')
    },
  )

  it('lets the native interactive flow choose scope and resumes after cancellation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-cancelled-'))
    const io = new InteractiveIo()
    const calls: { submit: number } = { submit: 0 }
    let receivedScope: SkillScope | undefined = 'global'
    const nativeSkills: NativeSkills = {
      add: async (options) => {
        receivedScope = options.scope
        return 0
      },
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.ok,
    )
    expect(receivedScope).toBeUndefined()
    expect(calls.submit).toBe(1)
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('reports an optional native installer failure without blocking remaining setup', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-skill-failed-'))
    const io = new InteractiveIo()
    const calls: { submit: number } = { submit: 0 }
    const nativeSkills: NativeSkills = {
      add: async () => 1,
      list: async () => ({ skills: [] }),
    }

    expect(await initCommand(setupReadyDeps(io, cwd, nativeSkills, calls), { skills: true, hooks: false })).toBe(
      EXIT.failed,
    )
    expect(calls.submit).toBe(1)
    expect(io.errLines.join('\n')).toContain('Skill installation failed')
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('tells the user what only they can do when nothing is signed in', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-nocred-'))
    const io = new CapturedIo()
    const deps: CommandDeps = {
      ...makeDeps(io, {} as ApiClient),
      cwd,
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('notifai login')
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
    // Refused, so it stays the next step rather than being treated as done.
    expect(io.outLines.join('\n')).toContain('notifai login')
  })

  it('never prompts or opens a browser when an agent runs it unattended', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-agent-no-input-'))
    const io = new (class extends CapturedIo {
      override async confirm(): Promise<boolean> {
        throw new Error('an unattended init reached a prompt')
      }

      override openUrl(): void {
        throw new Error('an unattended init opened a browser')
      }
    })()
    const deps: CommandDeps = {
      ...makeDeps(io, { health: async () => true } as unknown as ApiClient),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'empty store' },
    }

    expect(await initCommand(deps, {})).toBe(EXIT.failed)
    expect(io.outLines.join('\n')).toContain('Next: This machine')
  })

  it('makes the unavailable distribution bridge explicit when no app has registered', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-no-device-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [] }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Your devices')
    expect(out).toContain('private TestFlight invitation on iPhone or Mac')
    expect(out).toContain('open your Notifai TestFlight invitation on that device')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it.each([
    ['denied', 'system settings'],
    ['not_determined', 'allow its notification prompt'],
  ])('gives one permission-specific next action for %s', async (permission, expected) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), `init-permission-${permission}-`))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: [{ ...readyIphone, permission_status: permission, registration_healthy: false }],
      }),
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain(`iPhone (${permission})`)
    expect(out).toContain(expected)
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('waits on the supported device registry, then ends with an observed real receipt', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-device-bridge-'))
    const io = new InteractiveIo()
    let now = 0
    let deviceReady = false
    let submitCalls = 0
    let submittedDraft: SubmitNotificationRequestT | null = null
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: deviceReady ? [readyIphone] : [] }),
      submit: async (draft: SubmitNotificationRequestT) => {
        submitCalls += 1
        submittedDraft = draft
        return setupReceipt()
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
        deviceReady = true
      },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(io.prompts).toEqual(['Wait here while you finish that on your device?'])
    expect(io.spinnerEvents).toContain('stop:iPhone is ready to receive')
    expect(io.spinnerEvents).toContain('stop:Receipt observed from iPhone')
    expect(io.outLines.join('\n')).toContain('Companion Receipt observed from iPhone')
    expect(io.outLines.join('\n')).toContain('All set.')
    expect(submitCalls).toBe(1)
    expect(submittedDraft?.draft.event).toBe('setup_verified')
    expect(submittedDraft?.draft.targets).toEqual({ mode: 'selected', device_ids: ['dev_iphone'] })

    io.outLines = []
    io.prompts = []
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitCalls).toBe(1)
    expect(io.prompts).toEqual([])
    expect(io.outLines.join('\n')).toContain('All set.')
  })

  it('persists a partial proof and checks the same request instead of sending again', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-partial-'))
    const io = new CapturedIo()
    let now = 0
    let submitCalls = 0
    let savedRequestMissing = false
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt(submitCalls === 1 ? 'req_partial' : 'req_replacement')
      },
      evidence: async (requestId: string) => {
        if (savedRequestMissing && requestId === 'req_partial') {
          throw new ApiCallError(404, 'not_found', 'No such request.')
        }
        return setupEvidence(
          requestId,
          savedRequestMissing
            ? {
                state: 'observed',
                observed_at: '2026-08-05T18:00:02.000Z',
                latency_ms: 1_000,
              }
            : { state: 'unknown', observed_at: null, latency_ms: null },
        )
      },
    } as unknown as ApiClient
    const deps: CommandDeps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
    expect(io.errLines.join('\n')).toContain('not proof of non-receipt')

    io.outLines = []
    io.errLines = []
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.outLines.join('\n')).toContain('Checking verification notification req_partial again.')

    io.outLines = []
    io.errLines = []
    savedRequestMissing = true
    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.ok)
    expect(submitCalls).toBe(2)
    expect(io.outLines.join('\n')).toContain('saved proof had expired; sent replacement req_replacement')
    expect(io.outLines.join('\n')).toContain('Companion Receipt observed from iPhone')
  })

  it('reports a proof-state write failure instead of crashing or sending twice', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-proof-unwritable-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt('req_unwritable')
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: '/dev/null' },
    }

    await expect(initCommand(deps, { hooks: false, skills: false })).resolves.toBe(EXIT.failed)
    expect(submitCalls).toBe(1)
    expect(io.errLines.join('\n')).toContain('Could not save setup proof req_unwritable')
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
  })

  it('does not claim proof for a macOS-only setup whose receipt bridge is unavailable', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-macos-proof-'))
    const io = new CapturedIo()
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({
        devices: [{ ...readyIphone, device_id: 'dev_mac', display_name: 'Mac', platform: 'macos' }],
      }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt()
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    expect(submitCalls).toBe(0)
    expect(io.outLines.join('\n')).toContain('Next: Delivery proof')
    expect(io.outLines.join('\n')).toContain('no supported macOS receipt bridge')
  })

  it('treats a revoked credential as the one blocker and points back to pairing', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'init-revoked-'))
    const io = new CapturedIo()
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => {
        throw new ApiCallError(401, 'machine_revoked', 'This machine was revoked.')
      },
    } as unknown as ApiClient
    const deps = {
      ...makeDeps(io, client),
      cwd,
      env: { XDG_CONFIG_HOME: path.join(cwd, 'config'), XDG_STATE_HOME: path.join(cwd, 'state') },
    }

    expect(await initCommand(deps, { hooks: false, skills: false })).toBe(EXIT.failed)
    const out = io.outLines.join('\n')
    expect(out).toContain('Next: Account')
    expect(out).toContain('pair it again')
    expect(out).toContain('notifai login')
    expect(out.match(/^Next:/gm)).toHaveLength(1)
  })

  it('scopes proof to each project worktree even on the same paired machine', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'init-worktrees-state-'))
    let submitCalls = 0
    const client = {
      health: async () => true,
      capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
      listDevices: async () => ({ devices: [readyIphone] }),
      submit: async () => {
        submitCalls += 1
        return setupReceipt(`req_worktree_${submitCalls}`)
      },
      evidence: async (requestId: string) =>
        setupEvidence(requestId, {
          state: 'observed',
          observed_at: '2026-08-05T18:00:02.000Z',
          latency_ms: 1_000,
        }),
    } as unknown as ApiClient

    for (const name of ['worktree-a', 'worktree-b']) {
      const cwd = mkdtempSync(path.join(os.tmpdir(), `${name}-`))
      const io = new CapturedIo()
      const deps = {
        ...makeDeps(io, client),
        cwd,
        env: { XDG_CONFIG_HOME: stateRoot, XDG_STATE_HOME: stateRoot },
      }
      expect(
        await initCommand(deps, { projectId: 'shared-project', hooks: false, skills: false }),
      ).toBe(EXIT.ok)
    }

    expect(submitCalls).toBe(2)
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
    // The label is the user's word for it; the detail is what must survive.
    expect(said).toMatch(/Protocol version/)
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
