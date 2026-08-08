import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ListRepliesResponse,
  ReplyView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import { EXIT, askCommand, hookRunCommand, type CommandDeps, type CommandIo } from './commands.js'
import { loadConfig, projectSessionPointerPath, sanitizeSessionId } from './config.js'
import {
  claimQuestionPush,
  clearSessionState,
  drainRetirements,
  drainOrphanRetirements,
  isUserAway,
  orphanRetirements,
  pruneAbandonedSessions,
  releaseQuestionPush,
  readProjectSession,
  readSessionState,
  registerQuestion,
  writeProjectSession,
  writeSessionState,
} from './hooks.js'

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

interface Recorder {
  submitted: SubmitNotificationRequestT[]
  /** `submitted[i]`'s request id, so a test can name what it just sent. */
  receipts: string[]
  closed: string[]
  /** Simulates an offline machine; retirement has to survive one. */
  failSubmits?: boolean
  /** Runs while an agent_question submit is in flight, before onSubmitted. */
  beforeQuestionSubmit?: () => void
}

function fakeClient(recorder: Recorder, replies: ReplyView[]): ApiClient {
  let submissions = 0
  return {
    beginPairing: notUsed,
    pollPairing: notUsed,
    // Both current companion apps register reply categories.
    listDevices: async () => ({
      devices: [
        {
          device_id: 'dev_iphone',
          display_name: 'Furankuphone',
          platform: 'ios' as const,
          permission_status: 'authorized',
          registration_healthy: true,
          last_seen_at: null,
        },
        {
          device_id: 'dev_mac',
          display_name: 'FurankuMac',
          platform: 'macos' as const,
          permission_status: 'authorized',
          registration_healthy: true,
          last_seen_at: null,
        },
      ],
    }),
    capabilities: notUsed,
    evidence: notUsed,
    createMediaUpload: notUsed,
    uploadMedia: notUsed,
    health: async () => true,
    submit: async (body) => {
      if (recorder.failSubmits === true) throw new Error('offline')
      if (body.draft.event === 'agent_question') recorder.beforeQuestionSubmit?.()
      recorder.submitted.push(body)
      submissions += 1
      recorder.receipts.push(`req_hook_${submissions}`)
      return {
        request_id: `req_hook_${submissions}`,
        replayed: false,
        overall: 'provider_accepted_all',
        deliveries: [],
        warnings: [],
      } satisfies SubmissionReceipt
    },
    replies: async (requestId) =>
      ({ request_id: requestId, reply_expires_at: null, replies }) satisfies ListRepliesResponse,
    closeReplies: async (requestId) => {
      recorder.closed.push(requestId)
    },
  } as ApiClient
}

function notUsed(): never {
  throw new Error('not used in these tests')
}

function reply(overrides: Partial<ReplyView> = {}): ReplyView {
  return {
    reply_id: 'rpl_test',
    seq: 1,
    delivery_id: 'del_test',
    device_id: 'dev_test',
    device_name: 'Furankuphone',
    text: 'Allow',
    choice_id: 'allow',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

interface Harness {
  deps: CommandDeps
  io: CapturedIo
  recorder: Recorder
  env: NodeJS.ProcessEnv
}

const NOW = 1_800_000_000_000

/**
 * `idleSeconds` defaults to null — "this machine has no idle source" — so these
 * cases exercise the degraded path and stay independent of whether the person
 * running the suite is touching their own keyboard.
 */
function harness(replies: ReplyView[] = [], idleSeconds: number | null = null): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-'))
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
  }
  const io = new CapturedIo()
  const recorder: Recorder = { submitted: [], receipts: [], closed: [] }
  // Virtual clock: sleeps advance it instead of costing wall time. A frozen
  // clock would make the reply poll's deadline unreachable and spin forever.
  let clock = NOW
  return {
    io,
    recorder,
    env,
    deps: {
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
      env,
      cwd: root,
      clientFactory: () => fakeClient(recorder, replies),
      now: () => clock,
      idleSeconds: () => idleSeconds,
      sleep: async (milliseconds: number) => {
        clock += milliseconds
      },
    },
  }
}

function stdin(payload: unknown): () => Promise<string> {
  return async () => JSON.stringify(payload)
}

/** Long enough ago to be away under the 120s default. */
const AWAY = NOW - 600_000
const PRESENT = NOW - 5_000

describe('presence gate', () => {
  it('treats a never-seen session as present, so a missing hook cannot hijack the terminal', () => {
    const { env, deps } = harness()
    const config = loadConfig({ cwd: deps.cwd, env })
    expect(isUserAway({}, config, NOW, null)).toBe(false)
  })

  it('is away only once the configured silence has elapsed', () => {
    const { env, deps } = harness()
    const config = loadConfig({ cwd: deps.cwd, env })
    expect(isUserAway({ last_prompt_at: PRESENT }, config, NOW, null)).toBe(false)
    expect(isUserAway({ last_prompt_at: AWAY }, config, NOW, null)).toBe(true)
  })

  // The case that motivated this: "run the full test suite", then three
  // minutes of watching. Elapsed time alone said away; the machine knows better.
  it('keeps a user who is watching a long turn present, however long the turn ran', () => {
    const { env, deps } = harness()
    const config = loadConfig({ cwd: deps.cwd, env })
    expect(isUserAway({ last_prompt_at: AWAY }, config, NOW, 3)).toBe(false)
  })

  // Found by a live Claude Code session: a spawned agent's session
  // always has a just-set last_prompt_at, so requiring session silence too meant
  // its FIRST question could never escalate — the "kick off agents and walk
  // away" case the feature is for.
  it('lets a freshly spawned session escalate when the machine says nobody is there', () => {
    const { env, deps } = harness()
    const config = loadConfig({ cwd: deps.cwd, env })
    expect(isUserAway({ last_prompt_at: PRESENT }, config, NOW, 900)).toBe(true)
    expect(isUserAway({ last_prompt_at: AWAY }, config, NOW, 900)).toBe(true)
  })

  it('pushes a spawned session first question once the machine has gone quiet', async () => {
    const h = harness([reply({ text: 'Yes' })], 900)
    // Prompt 20s ago, exactly as a just-spawned agent has.
    writeSessionState('spawn1', h.env, { last_prompt_at: NOW - 20_000 })
    registerQuestion('spawn1', h.env, { question: 'Ship it?' }, NOW)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'spawn1' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.recorder.submitted[0]?.draft.targets).toEqual({
      mode: 'selected',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
    expect(h.recorder.submitted[0]?.draft.presentation).toMatchObject({
      title: 'Question',
      body: 'Ship it?',
    })
    expect(h.recorder.submitted[0]?.draft.platform).toEqual({
      ios: { sound: 'attention', interruption_level: 'active' },
      macos: { sound: 'attention', interruption_level: 'active' },
    })
  })

  it('names the resolved project in the pushed question title', async () => {
    const h = harness([reply({ text: 'Yes' })], 900)
    const projectDir = path.join(h.deps.cwd, '.notifai')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      path.join(projectDir, 'config.toml'),
      'project = "notifai-cli"\nask_grace_seconds = 0\n',
    )
    writeSessionState('project-title', h.env, { last_prompt_at: AWAY })
    registerQuestion('project-title', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'project-title', cwd: h.deps.cwd }))

    expect(h.recorder.submitted[0]?.draft.presentation.title).toBe('Question · notifai-cli')
  })

  it('falls back to elapsed time where no idle source exists', () => {
    const { env, deps } = harness()
    const config = loadConfig({ cwd: deps.cwd, env })
    expect(isUserAway({ last_prompt_at: AWAY }, config, NOW, null)).toBe(true)
  })

  it('does not push a question to the phone while the user is at the keyboard', async () => {
    // Silent for ten minutes by the session clock, but active by the machine's.
    const h = harness([reply({ text: 'Yes' })], 2)
    writeSessionState('idle1', h.env, { last_prompt_at: AWAY })
    registerQuestion('idle1', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'idle1' }))
    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.errLines.join('\n')).toContain('at the keyboard')
  })
})

/**
 * Wanting notifications while still at the machine is a legitimate setting —
 * nobody should have to stop using their computer in order to be reached.
 * Presence is a precondition only while the user wants it to be, and switching
 * it off must not disturb the grace timer.
 */
describe('presence gating is optional (require_idle)', () => {
  function writeGlobalConfig(h: Harness, toml: string): void {
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.toml'), toml)
  }

  it('counts a user actively typing as reachable', () => {
    // One second of idle: as present as it is possible to be.
    const config = loadConfig({ cwd: '/nowhere', env: {}, flags: {} })
    expect(isUserAway({ last_prompt_at: NOW }, config, NOW, 1)).toBe(false)

    const off = loadConfig({ cwd: '/nowhere', env: {}, flags: {} })
    off.require_idle = { value: false, source: 'default' }
    expect(isUserAway({ last_prompt_at: NOW }, off, NOW, 1)).toBe(true)
  })

  it('escalates a question while the user is at the keyboard', async () => {
    const h = harness([], 1)
    writeGlobalConfig(h, 'require_idle = false\nask_grace_seconds = 0\n')
    writeSessionState('present1', h.env, { last_prompt_at: NOW })
    registerQuestion('present1', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present1' }))

    expect(h.recorder.submitted).toHaveLength(1)
    expect(h.io.errLines.join('\n')).not.toContain('at the keyboard')
  })

  it('still gives the terminal its grace window first', async () => {
    // The two knobs are independent: not needing the user to leave does not
    // mean skipping the wait that offers the question to the terminal.
    const h = harness([], 1)
    writeGlobalConfig(h, 'require_idle = false\nask_grace_seconds = 300\n')
    writeSessionState('present2', h.env, { last_prompt_at: NOW })
    registerQuestion('present2', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present2' }))

    expect(h.recorder.submitted).toHaveLength(1)
    // The clock only advances when the hook sleeps, so this is proof the wait
    // actually happened rather than being skipped.
    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThanOrEqual(300_000)
  })

  it('honours the grace window on a machine with no idle source at all', async () => {
    // With presence gating on, no idle source means refusing to wait
    // ('no-signal'). With it off there is nothing to watch for, so the timer
    // is just a timer and works everywhere.
    const h = harness([], null)
    writeGlobalConfig(h, 'require_idle = false\nask_grace_seconds = 120\n')
    registerQuestion('present3', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present3' }))

    expect(h.recorder.submitted).toHaveLength(1)
    expect((h.deps.now?.() ?? NOW) - NOW).toBeGreaterThanOrEqual(120_000)
    expect(h.io.errLines.join('\n')).not.toContain('no idle signal')
  })

  it('is not a way to switch escalation on when the user has switched it off', async () => {
    // ask_notifications is the "do not reach me" switch and outranks this one;
    // wanting to be reachable while working is a different question entirely.
    const h = harness([], 1)
    writeGlobalConfig(h, 'require_idle = false\nask_notifications = false\n')
    registerQuestion('present4', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'present4' }))

    expect(h.recorder.submitted).toHaveLength(0)
  })
})

describe('terminal-first grace window', () => {
  /** Registers a question asked `agoMs` ago, with the user long since silent. */
  function pending(h: Harness, session: string, agoMs: number): void {
    writeSessionState(session, h.env, { last_prompt_at: AWAY })
    registerQuestion(session, h.env, { question: 'Ship it?' }, NOW - agoMs)
  }

  it('holds the question in the terminal until the window elapses', async () => {
    // Idle 900s: the user is gone, so the wait runs to completion rather than
    // being abandoned. Sleeps advance the virtual clock.
    const h = harness([reply({ text: 'Yes' })], 900)
    pending(h, 'g1', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g1' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    // Nothing was pushed before the 300s default had passed.
    expect(h.deps.now?.()).toBeGreaterThanOrEqual(NOW + 300_000)
  })

  it('counts the window from when the question was sent, not from the turn end', async () => {
    // Asked 290s ago while the agent kept working: only 10s of wait remains.
    const h = harness([reply({ text: 'Yes' })], 900)
    pending(h, 'g2', 290_000)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g2' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.deps.now?.()).toBeLessThan(NOW + 60_000)
  })

  it('sends nothing if the user comes back to the keyboard during the window', async () => {
    let idle = 900
    const h = harness([reply({ text: 'Yes' })], 900)
    // Machine goes active on the second poll: the user sat down.
    h.deps.idleSeconds = () => {
      const current = idle
      idle = 1
      return current
    }
    pending(h, 'g3', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g3' }))
    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.errLines.join('\n')).toContain('came back')
  })

  it('refuses to hold a terminal it cannot monitor', async () => {
    // No idle source: waiting would block the prompt with no way to notice the
    // user returning, so it asks immediately instead.
    const h = harness([reply({ text: 'Yes' })], null)
    pending(h, 'g4', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g4' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.deps.now?.()).toBe(NOW)
    expect(h.io.errLines.join('\n')).toContain('no idle signal')
  })

  it('never lets the window crowd out the reply wait past the hook budget', async () => {
    // Both dials at maximum would be 540 + 540 — nearly twice the 600s ceiling
    // the harness kills a hook at, and a killed hook loses an answer already
    // given. The reply wait wins, so the window yields to nothing at all.
    const h = harness([reply({ text: 'Yes' })], 900)
    const dir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'config.toml'),
      'ask_grace_seconds = 540\nhook_reply_timeout_seconds = 540\n',
    )
    pending(h, 'g5', 0)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'g5' }))
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
    expect(h.deps.now?.()).toBe(NOW)
  })
})

describe('config resolution inside a hook', () => {
  it('reads project config from the session cwd, not the hook process cwd', async () => {
    const h = harness([reply({ choice_id: 'allow' })])
    // A project that has turned the feature off.
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-proj-'))
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(project, '.notifai', 'config.local.toml'),
      'ask_notifications = false\n',
    )
    writeSessionState('c1', h.env, { last_prompt_at: AWAY })
    registerQuestion('c1', h.env, { question: 'Ship it?' })

    // deps.cwd is elsewhere; only envelope.cwd points at the project. The
    // payload's cwd is the harness's statement of which project this is, and
    // must win over whatever directory we were spawned in.
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'c1', cwd: project }))

    expect(h.recorder.submitted).toEqual([])
    expect(h.io.outLines).toEqual([])
  })
})

describe('nagging guards', () => {
  it('does not ask twice for one question across successive Stops', async () => {
    const h = harness([])
    writeSessionState('n1', h.env, { last_prompt_at: AWAY })
    registerQuestion('n1', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n1' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n1' }))

    expect(h.recorder.submitted).toHaveLength(1)
  })

  it('respects the harness recursion guard', async () => {
    const h = harness([reply({ text: 'Yes' })])
    writeSessionState('n2', h.env, { last_prompt_at: AWAY })
    registerQuestion('n2', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n2', stop_hook_active: true }))

    expect(h.recorder.submitted).toEqual([])
    expect(h.io.outLines).toEqual([])
  })

  it('delivers a new question registered during an answer continuation', async () => {
    const h = harness([reply({ text: 'First answer' })], 900)
    writeSessionState('n3', h.env, { last_prompt_at: AWAY })
    registerQuestion('n3', h.env, { question: 'First question?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n3' }))
    await h.deps.sleep?.(1)
    registerQuestion('n3', h.env, { question: 'Follow-up question?' }, (h.deps.now?.() ?? NOW))
    h.io.outLines = []

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n3', stop_hook_active: true }))

    const questions = h.recorder.submitted.filter((entry) => entry.draft.event === 'agent_question')
    expect(questions.map((entry) => entry.draft.presentation.body)).toEqual([
      'First question?',
      'Follow-up question?',
    ])
    expect(h.io.outLines.join('\n')).toContain('First answer')
  })

  it('stops chained questions at the consecutive continuation cap', async () => {
    const h = harness([], 900)
    writeSessionState('n4', h.env, {
      last_prompt_at: AWAY,
      continuation: { answered_at: NOW - 1, count: 3 },
    })
    registerQuestion('n4', h.env, { question: 'One more?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'n4', stop_hook_active: true }))

    expect(h.recorder.submitted).toEqual([])
    expect(readSessionState('n4', h.env).pending?.question).toBe('One more?')
    expect(h.io.errLines.join('\n')).toContain('continuation limit (3) reached')
  })
})

describe('late answer collection', () => {
  it('collects a late answer on Stop and resumes with it instead of asking twice', async () => {
    const answers: ReplyView[] = []
    const h = harness(answers, 900)
    writeSessionState('late-stop', h.env, { last_prompt_at: AWAY })
    registerQuestion('late-stop', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'late-stop' }))
    expect(readSessionState('late-stop', h.env).pending?.request_id).toBe('req_hook_1')
    answers.push(reply({ text: 'Ship it' }))
    h.io.outLines = []

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'late-stop' }))

    expect(h.recorder.submitted.filter((entry) => entry.draft.event === 'agent_question')).toHaveLength(1)
    expect(h.recorder.closed).toContain('req_hook_1')
    expect(readSessionState('late-stop', h.env).pending).toBeUndefined()
    expect(h.io.outLines).toHaveLength(1)
    expect(JSON.parse(h.io.outLines[0] ?? '{}')).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('Ship it'),
    })
  })

  it('collects a late answer on UserPromptSubmit and retires it truthfully', async () => {
    const answers: ReplyView[] = []
    const h = harness(answers, 900)
    writeSessionState('late-prompt', h.env, { last_prompt_at: AWAY })
    registerQuestion('late-prompt', h.env, { question: 'Ship it?' }, NOW)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'late-prompt' }))
    answers.push(reply({ text: 'Hold' }))
    h.io.outLines = []

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'late-prompt', cwd: h.deps.cwd }),
    )

    const retirement = h.recorder.submitted.find(
      (entry) => entry.draft.event === 'question_retired',
    )?.draft
    expect(retirement?.lifecycle).toMatchObject({
      state: 'answered',
      retires_request_id: 'req_hook_1',
    })
    expect(retirement?.lifecycle?.state).not.toBe('answered_elsewhere')
    expect(readSessionState('late-prompt', h.env).pending).toBeUndefined()
    expect(JSON.parse(h.io.outLines[0] ?? '{}')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining('Hold'),
      },
    })
  })
})

describe('OpenCode answer preservation', () => {
  it('pushes without waiting and leaves the answerable request intact', async () => {
    const h = harness([reply({ text: 'Approve' })], 900)
    writeSessionState('open1', h.env, { last_prompt_at: AWAY })
    registerQuestion('open1', h.env, { question: 'Deploy?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'open1' }), 'opencode')

    expect(h.recorder.submitted.filter((entry) => entry.draft.event === 'agent_question')).toHaveLength(1)
    expect(h.recorder.closed).toEqual([])
    expect(
      h.recorder.submitted.filter((entry) => entry.draft.event === 'question_retired'),
    ).toEqual([])
    expect(readSessionState('open1', h.env).pending).toMatchObject({
      question: 'Deploy?',
      request_id: 'req_hook_1',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
    expect(h.io.outLines).toEqual([])
  })
})

describe('reply-wait presence monitoring', () => {
  it('returns the terminal when the user comes back after the push', async () => {
    const h = harness([], 900)
    let checks = 0
    h.deps.idleSeconds = () => {
      checks += 1
      return checks >= 4 ? 1 : 900
    }
    writeSessionState('returned', h.env, { last_prompt_at: AWAY })
    registerQuestion('returned', h.env, { question: 'Deploy?' }, NOW - 300_000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'returned' }))

    expect(h.recorder.submitted.filter((entry) => entry.draft.event === 'agent_question')).toHaveLength(1)
    expect(h.recorder.closed).toEqual([])
    expect(readSessionState('returned', h.env).pending?.request_id).toBe('req_hook_1')
    expect((h.deps.now?.() ?? NOW) - NOW).toBeLessThan(30_000)
    expect(h.io.errLines.join('\n')).toContain('came back')
    expect(h.io.errLines.join('\n')).toContain('notifai replies --pending')
  })
})

describe('Cursor stop output', () => {
  it('maps the phone answer to one native followup_message', async () => {
    const h = harness([reply({ text: 'Ship it' })], 900)
    writeSessionState('cursor-conversation', h.env, { last_prompt_at: AWAY })
    registerQuestion('cursor-conversation', h.env, { question: 'Deploy now?' })

    await hookRunCommand(
      h.deps,
      'stop',
      stdin({
        conversation_id: 'cursor-conversation',
        workspace_roots: [h.deps.cwd],
        loop_count: 0,
      }),
      'cursor',
    )

    expect(h.io.outLines).toHaveLength(1)
    const output = JSON.parse(h.io.outLines[0] ?? '{}') as Record<string, unknown>
    expect(output['followup_message']).toContain(
      'Notifai — the user answered from Furankuphone: "Ship it". Continue with that answer.',
    )
    expect(output).not.toHaveProperty('decision')
  })
})

/**
 * Stale questions piling up on a phone are worse than no questions at all:
 * they teach the user to ignore the surface. Every one of them was a delivered
 * question whose ids had been thrown away, so nothing could reach it again.
 */
describe('superseding a live question', () => {
  /** The lifecycle state of each retirement push the recorder captured. */
  function retirements(h: Harness): { state: unknown; retires: unknown }[] {
    return h.recorder.submitted
      .filter((s) => s.draft.event === 'question_retired')
      .map((s) => ({
        state: s.draft.lifecycle?.state,
        retires: s.draft.lifecycle?.retires_request_id,
      }))
  }

  it('retires the first question instead of orphaning it', async () => {
    const h = harness([])
    writeSessionState('sup1', h.env, { last_prompt_at: AWAY })
    registerQuestion('sup1', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup1' }))
    const first = h.recorder.receipts[0]
    expect(first).toBeDefined()

    // The agent carried on and asked something else. The first question is
    // dead the moment this returns, whether or not anyone answers the second.
    registerQuestion('sup1', h.env, { question: 'Deploy it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup1' }))

    expect(retirements(h)).toContainEqual({ state: 'superseded', retires: first })
    // And the replacement was still asked; superseding is not suppressing.
    expect(
      h.recorder.submitted.filter((s) => s.draft.presentation.body === 'Deploy it?'),
    ).toHaveLength(1)
  })

  it('keeps the ids when the retirement cannot be sent, and retries later', async () => {
    const h = harness([])
    writeSessionState('sup2', h.env, { last_prompt_at: AWAY })
    registerQuestion('sup2', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup2' }))
    const first = h.recorder.receipts[0]

    registerQuestion('sup2', h.env, { question: 'Deploy it?' })
    expect(readSessionState('sup2', h.env).retiring).toHaveLength(1)

    // Offline: the drain runs, fails, and must not forget what it was for.
    h.recorder.failSubmits = true
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup2' }))
    expect(readSessionState('sup2', h.env).retiring).toHaveLength(1)

    h.recorder.failSubmits = false
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup2' }))
    expect(retirements(h)).toContainEqual({ state: 'superseded', retires: first })
    expect(readSessionState('sup2', h.env).retiring).toEqual([])
  })

  it('keeps the original delivery targets when routing changes before retirement', async () => {
    const h = harness([])
    writeSessionState('sup-targets', h.env, { last_prompt_at: AWAY })
    registerQuestion('sup-targets', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup-targets' }))

    const live = readSessionState('sup-targets', h.env).pending
    expect(live).toMatchObject({
      request_id: 'req_hook_1',
      device_ids: ['dev_iphone', 'dev_mac'],
    })

    // The user changes their default routing before the agent supersedes the
    // question. Retirement belongs to the Deliveries that actually carried the
    // first question, not to whichever Device Installation is selected now.
    const configDir = path.join(h.env['XDG_CONFIG_HOME'] as string, 'notifai')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, 'config.toml'), 'devices = ["dev_iphone"]\n')
    registerQuestion('sup-targets', h.env, { question: 'Deploy it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup-targets' }))

    const retirement = h.recorder.submitted.find(
      (submission) => submission.draft.event === 'question_retired',
    )
    expect(retirement?.draft.lifecycle?.retires_request_id).toBe('req_hook_1')
    expect(retirement?.draft.targets).toEqual({
      mode: 'selected',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
  })

  it('sweeps a queued retirement even on a turn continuing from an answer', async () => {
    // stop_hook_active short-circuits the escalation path, and a superseding
    // turn is very often exactly this turn.
    const h = harness([])
    writeSessionState('sup3', h.env, { last_prompt_at: AWAY })
    registerQuestion('sup3', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup3' }))
    const first = h.recorder.receipts[0]

    registerQuestion('sup3', h.env, { question: 'Deploy it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup3', stop_hook_active: true }))

    expect(retirements(h)).toContainEqual({ state: 'superseded', retires: first })
  })

  it('does not lose a queued retirement when the user comes back to the terminal', async () => {
    // UserPromptSubmit resets session state to record presence, and that reset
    // used to take the retirement queue with it.
    const h = harness([])
    writeSessionState('sup4', h.env, { last_prompt_at: AWAY })
    registerQuestion('sup4', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup4' }))
    const first = h.recorder.receipts[0]

    registerQuestion('sup4', h.env, { question: 'Deploy it?' })
    h.recorder.failSubmits = true
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sup4' }))
    h.recorder.failSubmits = false

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'sup4' }))

    expect(retirements(h)).toContainEqual({ state: 'superseded', retires: first })
    expect(readSessionState('sup4', h.env).retiring).toEqual([])
  })

  it('parks nothing for a question that never reached a device', async () => {
    // No request_id means there is no notification anywhere to retire, and a
    // retirement push for one would be pure noise.
    const h = harness([])
    registerQuestion('sup5', h.env, { question: 'Ship it?' })
    registerQuestion('sup5', h.env, { question: 'Deploy it?' })

    expect(readSessionState('sup5', h.env).retiring ?? []).toEqual([])
  })
})

describe('a question that outlives its session', () => {
  function retirements(h: Harness): { state: unknown; retires: unknown }[] {
    return h.recorder.submitted
      .filter((s) => s.draft.event === 'question_retired')
      .map((s) => ({
        state: s.draft.lifecycle?.state,
        retires: s.draft.lifecycle?.retires_request_id,
      }))
  }

  /** Escalate a question that nobody answers, so it is live on the devices. */
  async function pushUnanswered(h: Harness, sessionId: string): Promise<string> {
    writeSessionState(sessionId, h.env, { last_prompt_at: AWAY })
    registerQuestion(sessionId, h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: sessionId }))
    const requestId = h.recorder.receipts[0]
    expect(requestId).toBeDefined()
    return requestId!
  }

  it('retires a question the harness exited on, from a later session', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead1')

    // The user quits the harness. SessionEnd cannot reach the network, so the
    // question must survive the state file it used to die with.
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead1' }))
    expect(readSessionState('dead1', h.env)).toEqual({})

    // A different session's next hook holds a client and inherits the debt.
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'next1' }))
    expect(h.recorder.closed).toContain(first)
    expect(retirements(h)).toContainEqual({ state: 'expired', retires: first })
  })

  it('carries parked retirements across SessionEnd too', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead2')

    // Superseded while offline: the retirement is parked, not sent.
    registerQuestion('dead2', h.env, { question: 'Deploy it?' })
    h.recorder.failSubmits = true
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'dead2' }))
    h.recorder.failSubmits = false

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead2' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next2' }))
    expect(retirements(h)).toContainEqual({ state: 'superseded', retires: first })
  })

  it('keeps the debt when the drain fails, and drops entries past the TTL', async () => {
    const h = harness([])
    const first = await pushUnanswered(h, 'dead3')
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead3' }))

    // Still offline: the queue must survive a failed drain.
    h.recorder.failSubmits = true
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    h.recorder.failSubmits = false
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    expect(retirements(h)).toContainEqual({ state: 'expired', retires: first })

    // And a second drain does not send it twice.
    const count = retirements(h).filter((r) => r.retires === first).length
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next3' }))
    expect(retirements(h).filter((r) => r.retires === first)).toHaveLength(count)
  })

  it('gives up on an orphan older than a day instead of queueing it for ever', async () => {
    const h = harness([])
    orphanRetirements(
      h.env,
      [{
        request_id: 'req_old',
        collapse_key: 'ck_old',
        device_ids: ['dev_iphone'],
        question: 'Old?',
        state: 'expired',
      }],
      undefined,
      NOW - 25 * 3600 * 1000,
    )
    const drained = await drainOrphanRetirements(
      { client: h.deps.clientFactory('https://test.notifai.invalid', 'Bearer x'), config: loadConfig({ cwd: h.deps.cwd, env: h.env }) },
      h.env,
      NOW,
    )
    // Dropped as handled, but no retirement push was spent on it.
    expect(drained).toContain('req_old')
    expect(h.recorder.submitted).toHaveLength(0)
  })

  it('queues nothing for a session with nothing live on the devices', async () => {
    const h = harness([])
    registerQuestion('dead4', h.env, { question: 'Ship it?' })
    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 'dead4' }))
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'next4' }))
    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.recorder.closed).toHaveLength(0)
  })
})

describe('hostile input', () => {
  it('never sends the credential to a base_url a repository asked for', async () => {
    const h = harness([reply({ text: 'Yes' })])
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-evil-'))
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(
      path.join(project, '.notifai', 'config.toml'),
      'base_url = "https://attacker.example"\n',
    )
    writeSessionState('h1', h.env, { last_prompt_at: AWAY })
    registerQuestion('h1', h.env, { question: 'Ship it?' })

    let seen: string | null = null
    h.deps.clientFactory = (baseUrl) => {
      seen = baseUrl
      return fakeClient(h.recorder, [reply({ text: 'Yes' })])
    }
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'h1', cwd: project }))

    expect(seen).toBe('https://test.notifai.invalid')
  })

  it('clamps an out-of-range away threshold instead of trusting it', () => {
    const h = harness()
    const project = mkdtempSync(path.join(os.tmpdir(), 'notifai-bounds-'))
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    writeFileSync(path.join(project, '.notifai', 'config.toml'), 'away_after_seconds = -1\n')
    const config = loadConfig({ cwd: project, env: h.env })
    // -1 would make someone who just typed count as absent.
    expect(config.away_after_seconds.value).toBeGreaterThanOrEqual(5)
  })
})

describe('ask registration', () => {
  it('rejects a malformed choice set at registration, not at push time', () => {
    const h = harness()
    // Inside a hook, a rejection is only a stderr note the agent never reads —
    // so it would look registered and then silently never ask.
    expect(askCommand(h.deps, 'Ship it?', { choice: 'Yes|No', session: 'a1' })).toBe(EXIT.usage)
    expect(readSessionState('a1', h.env).pending).toBeUndefined()
  })

  it('stores validated labels verbatim, commas and all', () => {
    const h = harness()
    expect(
      askCommand(h.deps, 'Ship it?', {
        choice: ['Yes, ship it', 'No, hold'],
        session: 'a2',
      }),
    ).toBe(EXIT.ok)
    expect(readSessionState('a2', h.env).pending?.choices).toEqual(['Yes, ship it', 'No, hold'])
  })

  it('resolves the session as flag, then hook pointer, then NOTIFAI_SESSION', async () => {
    // The exported id is often a chosen label while hook state is keyed by the
    // harness's own id, so the pointer must outrank the env var.
    const h = harness()
    h.deps.env['NOTIFAI_SESSION'] = 'my-label'
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'real1', cwd: h.deps.cwd }),
      'claude-code',
    )
    expect(askCommand(h.deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('real1', h.env).pending?.question).toBe('Ship it?')
    expect(readSessionState('my-label', h.env).pending).toBeUndefined()
  })

  it('falls back to NOTIFAI_SESSION where no hook has spoken', () => {
    const h = harness()
    h.deps.env['NOTIFAI_SESSION'] = 'solo-session'
    expect(askCommand(h.deps, 'Ship it?', {})).toBe(EXIT.ok)
    expect(readSessionState('solo-session', h.env).pending?.question).toBe('Ship it?')
  })

  it('fails explicitly instead of rerouting incomplete live state', () => {
    const h = harness()
    writeSessionState('incomplete', h.env, {
      pending: {
        question: 'Original?',
        request_id: 'req_original',
        collapse_key: 'collapse-original',
      },
    })

    expect(askCommand(h.deps, 'Replacement?', { session: 'incomplete' })).toBe(EXIT.failed)
    expect(h.io.errLines.join('\n')).toContain(
      'refusing to retire it without request, collapse, and device identifiers',
    )
    expect(readSessionState('incomplete', h.env).pending?.question).toBe('Original?')
  })
})

describe('user-prompt-submit hook', () => {
  it('records presence', async () => {
    const h = harness()
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's10' }))
    expect(readSessionState('s10', h.env).last_prompt_at).toBe(NOW)
  })

  it('diagnoses malformed or truncated hook input instead of silently doing nothing', async () => {
    const h = harness()

    expect(await hookRunCommand(h.deps, 'user-prompt-submit', async () => '{"session_id":')).toBe(
      EXIT.ok,
    )

    expect(h.io.errLines.join('\n')).toMatch(/malformed|truncated/i)
  })

  it('explains when a missing machine credential makes a hook skip routing', async () => {
    const h = harness()
    h.deps.store.load = () => null

    expect(
      await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 'unpaired' })),
    ).toBe(EXIT.ok)

    expect(h.io.errLines.join('\n')).toMatch(/not paired|credential/i)
  })

  it('preserves a delivered question through ask replacement and prompt transition', async () => {
    const h = harness([], 900)
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'transition', cwd: h.deps.cwd }),
      'claude-code',
    )
    expect(askCommand(h.deps, 'Ship it?', { choice: ['Yes', 'No'] })).toBe(EXIT.ok)
    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'transition', cwd: h.deps.cwd }))

    const live = readSessionState('transition', h.env).pending
    expect(live).toMatchObject({
      question: 'Ship it?',
      request_id: 'req_hook_1',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
    expect(live?.collapse_key).toMatch(/^notifai-hook-/)

    // A second plain `ask` resolves through the project pointer and supersedes
    // the live question. The next prompt then resets presence before another
    // Stop can run — the transition that used to erase the retirement debt.
    expect(askCommand(h.deps, 'Deploy it?', { choice: ['Staging', 'Production'] })).toBe(EXIT.ok)
    expect(readSessionState('transition', h.env).retiring).toEqual([
      {
        request_id: live?.request_id,
        collapse_key: live?.collapse_key,
        device_ids: ['dev_iphone', 'dev_mac'],
        question: 'Ship it?',
        state: 'superseded',
      },
    ])

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'transition', cwd: h.deps.cwd }),
      'claude-code',
    )

    const retirement = h.recorder.submitted.find(
      (submission) => submission.draft.event === 'question_retired',
    )?.draft
    expect(retirement?.delivery.collapse_key).toBe(live?.collapse_key)
    expect(retirement?.lifecycle).toEqual({
      tier: 'done',
      state: 'superseded',
      retires_request_id: live?.request_id,
    })
    expect(retirement?.targets).toEqual({
      mode: 'selected',
      device_ids: ['dev_iphone', 'dev_mac'],
    })
  })

  it('retires a question a real timed-out Stop left live on the devices', async () => {
    // Drives the actual flow rather than hand-writing state: the previous
    // version of this test fabricated a shape production never wrote, so it
    // passed while the retirement path was unreachable.
    const h = harness([])
    writeSessionState('s11', h.env, { last_prompt_at: AWAY })
    registerQuestion('s11', h.env, { question: 'Which environment?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 's11' }))
    const live = readSessionState('s11', h.env).pending
    expect(live?.request_id).toBe('req_hook_1')
    expect(live?.collapse_key).toBeDefined()

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's11', cwd: '/repo' }))

    expect(h.recorder.closed).toEqual(['req_hook_1'])
    const retirement = h.recorder.submitted.at(-1)?.draft
    expect(retirement?.presentation.title).toBe('Answered in the terminal')
    expect(retirement?.delivery.collapse_key).toBe(live?.collapse_key)
    expect(retirement?.reply).toBeUndefined()
  })

  it('marks the retirement done/answered_elsewhere so it ships silently', async () => {
    // A state change is not news: the retirement must ride the wire as a
    // lifecycle update, which the server renders as a background push — the
    // old "Answered" tombstone alert told the user what they just did.
    const h = harness([])
    writeSessionState('s15', h.env, { last_prompt_at: AWAY })
    registerQuestion('s15', h.env, { question: 'Which environment?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 's15' }))
    expect(h.recorder.submitted[0]?.draft.lifecycle).toEqual({ tier: 'needs_you' })

    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({ session_id: 's15', cwd: '/repo' }))

    const retirement = h.recorder.submitted.at(-1)?.draft
    expect(retirement?.lifecycle).toEqual({
      tier: 'done',
      state: 'answered_elsewhere',
      // The history-entry correlation id: companions key entries by request
      // id and never persisted the collapse key.
      retires_request_id: 'req_hook_1',
    })
  })

  it('retires as done/answered when the answer came from a device', async () => {
    const h = harness([reply({ text: 'Yes' })], 900)
    registerQuestion('s16', h.env, { question: 'Ship it?' })

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 's16' }))

    const retirement = h.recorder.submitted.find((s) => s.draft.event === 'question_retired')
    expect(retirement?.draft.lifecycle).toEqual({
      tier: 'done',
      state: 'answered',
      retires_request_id: 'req_hook_1',
    })
  })

  it('publishes a session pointer so a plain `notifai ask` can find itself', async () => {
    const h = harness()
    // A real directory reachable by two names. os.tmpdir() is /var/folders on
    // macOS, so create under /tmp explicitly to get the symlinked pair that
    // broke this live: the harness reports cwd unresolved, a shell resolved.
    const viaSymlink = mkdtempSync('/tmp/notifai-ptr-')
    const project = realpathSync(viaSymlink)
    if (project === viaSymlink) return // no symlink on this platform; nothing to prove

    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 's14', cwd: viaSymlink }),
      'claude-code',
    )

    expect(readProjectSession(project, h.env, NOW)).toBe('s14')
    expect(readProjectSession(viaSymlink, h.env, NOW)).toBe('s14')
    // A pointer older than a day is not evidence of a live session.
    expect(readProjectSession(project, h.env, NOW + 2 * 24 * 3600 * 1000)).toBeNull()

    clearSessionState('s14', h.env)
    expect(readProjectSession(project, h.env, NOW)).toBeNull()
  })
})

describe('session-end hook', () => {
  it('drops local state without touching the network, inside its ~1s budget', async () => {
    const h = harness()
    writeSessionState('s12', h.env, { last_prompt_at: NOW })

    const code = await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 's12' }))

    expect(code).toBe(EXIT.ok)
    expect(readSessionState('s12', h.env)).toEqual({})
    expect(h.recorder.closed).toEqual([])
  })

  it('clears only the ending session project pointer', async () => {
    const h = harness()
    await hookRunCommand(
      h.deps,
      'user-prompt-submit',
      stdin({ session_id: 'ending', cwd: h.deps.cwd }),
      'claude-code',
    )
    expect(readProjectSession(h.deps.cwd, h.env, NOW)).toBe('ending')

    await hookRunCommand(
      h.deps,
      'session-end',
      stdin({ session_id: 'ending', cwd: h.deps.cwd }),
      'claude-code',
    )

    expect(readProjectSession(h.deps.cwd, h.env, NOW)).toBeNull()
  })

  it('preserves incomplete live state and reports why it cannot retire it', async () => {
    const h = harness()
    writeSessionState('s-incomplete', h.env, {
      pending: {
        question: 'Still live?',
        request_id: 'req_incomplete',
        collapse_key: 'collapse-incomplete',
      },
    })

    await hookRunCommand(h.deps, 'session-end', stdin({ session_id: 's-incomplete' }))

    expect(readSessionState('s-incomplete', h.env).pending?.request_id).toBe('req_incomplete')
    expect(h.io.errLines.join('\n')).toContain(
      'refusing to retire it without request, collapse, and device identifiers',
    )
  })
})

describe('malformed input', () => {
  it('never fails the harness on unparseable hook JSON', async () => {
    const h = harness()
    const code = await hookRunCommand(h.deps, 'stop', async () => 'not json{')
    expect(code).toBe(EXIT.ok)
    expect(h.io.outLines).toEqual([])
  })
})

describe('telling concurrent agents apart', () => {
  it('stamps the harness session on the question it pushes', async () => {
    // The hook has always known session_id and never passed it on, so two
    // agents in separate worktrees produced identical notifications and the
    // user could answer the wrong one's question.
    const h = harness([], 900)
    registerQuestion('sess-abc', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))

    expect(h.recorder.submitted[0]?.draft.session).toBe('sess-abc')
  })

  it('stamps the retirement too, so it lands on the right agent’s notification', async () => {
    const h = harness([reply({ text: 'Yes' })], 900)
    registerQuestion('sess-abc', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))

    const retirement = h.recorder.submitted.find((s) => s.draft.event === 'question_retired')
    expect(retirement?.draft.session).toBe('sess-abc')
  })

  it('prefers a name the user chose over the harness UUID', async () => {
    const h = harness([], 900)
    h.env['NOTIFAI_SESSION'] = 'migration-worktree'
    registerQuestion('sess-abc', h.env, { question: 'Ship it?' }, NOW)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-abc' }))

    expect(h.recorder.submitted[0]?.draft.session).toBe('migration-worktree')
  })
})

describe('clock jumps', () => {
  const config = loadConfig({ cwd: '/nowhere', env: {} })

  it('does not hijack a terminal because the clock jumped forward', () => {
    // NTP correction or a VM resume moves `now` without any time passing for
    // the person sitting at the keyboard. Without an idle source there is
    // nothing to check the delta against, so a huge one is not evidence.
    const state = { last_prompt_at: NOW - 400 * 24 * 3600 * 1000 }
    expect(isUserAway(state, config, NOW, null)).toBe(false)
  })

  it('does not read a backward jump as the user being present either', () => {
    // A negative delta is nonsense, not freshness. It resolves the same way:
    // no evidence, so leave the terminal alone.
    expect(isUserAway({ last_prompt_at: NOW + 60_000 }, config, NOW, null)).toBe(false)
  })

  it('still escalates on an ordinary long silence', () => {
    expect(isUserAway({ last_prompt_at: NOW - 3600_000 }, config, NOW, null)).toBe(true)
  })

  it('lets the OS idle signal decide regardless of the wall clock', () => {
    // The idle probe measures elapsed time directly, so it is unaffected — and
    // it outranks the proxy anyway.
    const nonsense = { last_prompt_at: NOW + 999_999_999 }
    expect(isUserAway(nonsense, config, NOW, 900)).toBe(true)
    expect(isUserAway(nonsense, config, NOW, 1)).toBe(false)
  })

  it('does not let a stamp from the future hold the terminal past the budget', async () => {
    // asked_at is wall-clock too. A future stamp used to make the grace window
    // unreachable, blocking Stop until the harness killed it.
    const h = harness([], 900)
    registerQuestion('sess-jump', h.env, { question: 'Ship it?' }, NOW + 30 * 24 * 3600 * 1000)

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'sess-jump' }))

    // It escalated rather than spinning: the window restarted from now.
    expect(h.recorder.submitted.length).toBeGreaterThan(0)
  })
})

/**
 * SessionEnd cleans up, but a crashed harness never reaches it,
 * and roughly a hundred sessions a day is tens of thousands of dead files a
 * year that nothing reads.
 */
describe('pruning abandoned session state', () => {
  function sessionFile(h: Harness, name: string): string {
    return path.join(h.env['XDG_STATE_HOME'] as string, 'notifai', 'sessions', name)
  }

  // Real wall-clock, because this reasons about file mtimes.
  const REAL = Date.now()

  it('removes state a crashed harness left behind, and keeps live state', () => {
    const h = harness()
    writeSessionState('alive', h.env, { last_prompt_at: NOW })
    writeSessionState('abandoned', h.env, { last_prompt_at: NOW })
    const old = new Date(REAL - 30 * 24 * 3600 * 1000)
    utimesSync(sessionFile(h, `${sanitizeSessionId('abandoned')}.json`), old, old)

    expect(pruneAbandonedSessions(h.env, REAL)).toBe(1)

    expect(readSessionState('alive', h.env).last_prompt_at).toBe(NOW)
    expect(readSessionState('abandoned', h.env)).toEqual({})
  })

  it('does not walk the directory again for a day', () => {
    const h = harness()
    writeSessionState('a', h.env, { last_prompt_at: NOW })
    pruneAbandonedSessions(h.env, REAL)

    const old = new Date(REAL - 30 * 24 * 3600 * 1000)
    utimesSync(sessionFile(h, `${sanitizeSessionId('a')}.json`), old, old)

    // Same day: skipped entirely, so the stale file survives.
    expect(pruneAbandonedSessions(h.env, REAL + 3600_000)).toBe(0)
    expect(readSessionState('a', h.env).last_prompt_at).toBe(NOW)
    // Next day: swept.
    expect(pruneAbandonedSessions(h.env, REAL + 25 * 3600 * 1000)).toBe(1)
  })

  it('does not read a clock jump as a directory full of dead sessions', () => {
    // A backward jump makes every file look like it came from the future.
    // Deleting live state there would lose a question already on the phone.
    const h = harness()
    writeSessionState('jumped', h.env, { last_prompt_at: NOW })

    expect(pruneAbandonedSessions(h.env, REAL - 400 * 24 * 3600 * 1000)).toBe(0)
    expect(readSessionState('jumped', h.env).last_prompt_at).toBe(NOW)
  })

  it('never fails a hook because housekeeping could not run', () => {
    expect(pruneAbandonedSessions({ XDG_STATE_HOME: '/dev/null' }, REAL)).toBe(0)
  })

  it('bounds what one runaway question can write to disk', () => {
    const h = harness()
    registerQuestion('big', h.env, { question: 'x'.repeat(50_000) })
    expect(readSessionState('big', h.env).pending?.question.length).toBeLessThanOrEqual(2000)
  })
})

describe('durable state writes', () => {
  function sessionFile(h: Harness, sessionId: string): string {
    return path.join(
      h.env['XDG_STATE_HOME'] as string,
      'notifai',
      'sessions',
      `${sanitizeSessionId(sessionId)}.json`,
    )
  }

  it('recovers a truncated state file with one complete atomic document', () => {
    const h = harness()
    const file = sessionFile(h, 'truncated')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"pending":')
    expect(readSessionState('truncated', h.env)).toEqual({})

    writeSessionState('truncated', h.env, { last_prompt_at: NOW })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ last_prompt_at: NOW })
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('refuses a session-state symlink instead of writing through it', () => {
    const h = harness()
    const file = sessionFile(h, 'linked')
    const target = path.join(path.dirname(file), 'target.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(target, '{"untouched":true}\n')
    symlinkSync(target, file)

    expect(() => writeSessionState('linked', h.env, { last_prompt_at: NOW })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('{"untouched":true}\n')
  })

  it('refuses project-pointer and retirement-queue symlinks too', () => {
    const h = harness()
    writeSessionState('linked-pointer', h.env, { last_prompt_at: NOW })
    const target = path.join(h.env['XDG_STATE_HOME'] as string, 'pointer-target.json')
    writeFileSync(target, '{"untouched":true}\n')
    const pointer = projectSessionPointerPath(h.deps.cwd, h.env)
    mkdirSync(path.dirname(pointer), { recursive: true })
    symlinkSync(target, pointer)

    expect(() =>
      writeProjectSession(h.deps.cwd, h.env, 'linked-pointer', NOW, 'claude-code'),
    ).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('{"untouched":true}\n')

    const queueTarget = path.join(h.env['XDG_STATE_HOME'] as string, 'queue-target.json')
    const queue = path.join(h.env['XDG_STATE_HOME'] as string, 'notifai', 'retire-queue.json')
    writeFileSync(queueTarget, '[]\n')
    symlinkSync(queueTarget, queue)
    expect(() =>
      orphanRetirements(
        h.env,
        [
          {
            request_id: 'req_linked',
            collapse_key: 'collapse-linked',
            device_ids: ['dev_iphone'],
            question: 'Still there?',
            state: 'expired',
          },
        ],
        'linked-pointer',
        NOW,
      ),
    ).toThrow(/symlink/)
    expect(readFileSync(queueTarget, 'utf8')).toBe('[]\n')
  })

  it('persists each successful retirement before a later corrupt entry interrupts the drain', async () => {
    const h = harness()
    writeSessionState('partial-drain', h.env, {
      retiring: [
        {
          request_id: 'req_good',
          collapse_key: 'collapse-good',
          device_ids: ['dev_iphone'],
          question: 'First?',
          state: 'expired',
        },
        {
          request_id: 'req_bad',
          collapse_key: 'collapse-bad',
          device_ids: [],
          question: 'Second?',
          state: 'expired',
        },
      ],
    })
    const ctx = {
      client: h.deps.clientFactory('https://test.notifai.invalid', 'Bearer x'),
      config: loadConfig({ cwd: h.deps.cwd, env: h.env }),
    }

    await expect(drainRetirements(ctx, 'partial-drain', h.env)).rejects.toThrow(
      /missing its device identifiers/,
    )

    expect(readSessionState('partial-drain', h.env).retiring?.map((entry) => entry.request_id)).toEqual([
      'req_bad',
    ])
  })
})

/**
 * Path-independent ownership stops the usual cause
 * of two handlers firing; this stops the consequence when something else does.
 */
describe('two hooks racing one question', () => {
  const REAL = Date.now()

  it('lets exactly one process push', () => {
    const h = harness()
    expect(claimQuestionPush('race1', h.env, REAL)).toBe(true)
    expect(claimQuestionPush('race1', h.env, REAL)).toBe(false)
  })

  it('frees the claim for the next turn', () => {
    const h = harness()
    claimQuestionPush('race2', h.env, REAL)
    releaseQuestionPush('race2', h.env)
    expect(claimQuestionPush('race2', h.env, REAL)).toBe(true)
  })

  it('breaks a claim whose holder cannot still be running', () => {
    // A crashed hook must not suppress every question for this session for
    // ever — that is worse than the duplicate the claim prevents.
    const h = harness()
    claimQuestionPush('race3', h.env, REAL - 10 * 60_000)
    expect(claimQuestionPush('race3', h.env, REAL)).toBe(true)
  })

  it('serializes a contender that arrives while a stale claim is being replaced', () => {
    const h = harness()
    claimQuestionPush('race-break', h.env, REAL - 10 * 60_000)
    let contender: ReturnType<typeof claimQuestionPush> | undefined

    const recovered = claimQuestionPush('race-break', h.env, REAL, () => {
      contender = claimQuestionPush('race-break', h.env, REAL)
    })

    expect(contender).toBeDefined()
    expect([recovered, contender].filter(Boolean)).toHaveLength(1)
  })

  it('does not let two sessions block each other', () => {
    const h = harness()
    expect(claimQuestionPush('race4a', h.env, REAL)).toBe(true)
    expect(claimQuestionPush('race4b', h.env, REAL)).toBe(true)
  })

  it('sends one notification when a second Stop arrives mid-flight', async () => {
    const h = harness([], 900)
    writeSessionState('race5', h.env, { last_prompt_at: AWAY })
    registerQuestion('race5', h.env, { question: 'Ship it?' })
    // Standing in for the other process: the claim is already held.
    claimQuestionPush('race5', h.env, Date.now())

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'race5' }))

    expect(h.recorder.submitted).toHaveLength(0)
    expect(h.io.errLines.join(" ")).toContain('already handling')
  })
})

describe('question registration racing a Stop submission', () => {
  it('preserves a newer question when the older submit publishes its request id', async () => {
    const h = harness([], 900)
    writeSessionState('submit-race', h.env, { last_prompt_at: AWAY })
    registerQuestion('submit-race', h.env, { question: 'Old question?' }, NOW)
    h.recorder.beforeQuestionSubmit = () => {
      h.recorder.beforeQuestionSubmit = undefined
      registerQuestion('submit-race', h.env, { question: 'New question?' }, NOW + 1)
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'submit-race' }))

    const state = readSessionState('submit-race', h.env)
    expect(state.pending?.question).toBe('New question?')
    expect(state.retiring).toContainEqual(
      expect.objectContaining({ request_id: 'req_hook_1', state: 'superseded' }),
    )
  })

  it('keeps the newer question when the older in-flight question receives an answer', async () => {
    const h = harness([reply({ text: 'Old answer' })], 900)
    writeSessionState('answer-race', h.env, { last_prompt_at: AWAY })
    registerQuestion('answer-race', h.env, { question: 'Old question?' }, NOW)
    h.recorder.beforeQuestionSubmit = () => {
      h.recorder.beforeQuestionSubmit = undefined
      registerQuestion('answer-race', h.env, { question: 'New question?' }, NOW + 1)
    }

    await hookRunCommand(h.deps, 'stop', stdin({ session_id: 'answer-race' }))

    const state = readSessionState('answer-race', h.env)
    expect(state.pending?.question).toBe('New question?')
    expect(
      h.recorder.submitted.find(
        (entry) =>
          entry.draft.event === 'question_retired' &&
          entry.draft.lifecycle?.retires_request_id === 'req_hook_1',
      )?.draft.lifecycle?.state,
    ).toBe('answered')
  })
})
