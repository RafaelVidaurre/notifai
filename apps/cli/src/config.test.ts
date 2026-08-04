import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, sessionConfigPath } from './config.js'
import { buildDraft } from './send.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'notifai-cli-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function setup(options: {
  globalToml?: string
  projectToml?: string
  projectLocalToml?: string
  sessionToml?: string
  sessionId?: string
}) {
  const home = path.join(tmp, `case-${Math.random().toString(36).slice(2)}`)
  const configDir = path.join(home, 'notifai')
  mkdirSync(configDir, { recursive: true })
  if (options.globalToml !== undefined) {
    writeFileSync(path.join(configDir, 'config.toml'), options.globalToml)
  }
  const project = path.join(home, 'repo', 'nested')
  mkdirSync(project, { recursive: true })
  const projectDir = path.join(home, 'repo', '.notifai')
  if (options.projectToml !== undefined) {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'config.toml'), options.projectToml)
  }
  if (options.projectLocalToml !== undefined) {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'config.local.toml'), options.projectLocalToml)
  }
  const state = path.join(home, 'state')
  const env = { XDG_CONFIG_HOME: home, XDG_STATE_HOME: state } as NodeJS.ProcessEnv
  if (options.sessionToml !== undefined) {
    const file = sessionConfigPath(options.sessionId ?? 'sess', env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, options.sessionToml)
  }
  return { env, cwd: project }
}

describe('harness config layers', () => {
  it('orders session over project-local over project over global', () => {
    const { env, cwd } = setup({
      globalToml: 'away_after_seconds = 10\n',
      projectToml: 'away_after_seconds = 20\n',
      projectLocalToml: 'away_after_seconds = 30\n',
      sessionToml: 'away_after_seconds = 40\n',
      sessionId: 'abc',
    })
    expect(loadConfig({ cwd, env, sessionId: 'abc' }).away_after_seconds).toMatchObject({
      value: 40,
      source: expect.stringMatching(/^session:/),
    })
    // Same files, different session: the session layer simply does not apply.
    expect(loadConfig({ cwd, env, sessionId: 'other' }).away_after_seconds).toMatchObject({
      value: 30,
      source: expect.stringMatching(/^project-local:/),
    })
    expect(loadConfig({ cwd, env }).away_after_seconds.value).toBe(30)
  })

  it('keeps a personal toggle out of the committed project file', () => {
    const { env, cwd } = setup({
      projectToml: 'ask_notifications = true\n',
      projectLocalToml: 'ask_notifications = false\n',
    })
    const config = loadConfig({ cwd, env })
    expect(config.ask_notifications.value).toBe(false)
    expect(config.ask_notifications.source).toMatch(/config\.local\.toml$/)
  })

  it('keeps hostile or colliding session ids inside their own file', () => {
    const { env, cwd } = setup({
      sessionToml: 'away_after_seconds = 99\n',
      sessionId: '../../etc/passwd',
    })
    // The id round-trips to its own state, and nothing escapes the directory.
    expect(loadConfig({ cwd, env, sessionId: '../../etc/passwd' }).away_after_seconds.value).toBe(99)
    expect(sessionConfigPath('../../etc/passwd', env)).toContain('/notifai/sessions/')
    expect(sessionConfigPath('../../etc/passwd', env)).not.toContain('..')
    // Ids that a sanitiser would have collapsed together must stay distinct:
    // sharing a file meant sharing presence and pending questions.
    expect(sessionConfigPath('a/b', env)).not.toBe(sessionConfigPath('a?b', env))
    expect(loadConfig({ cwd, env, sessionId: 'a/b' }).away_after_seconds.value).toBe(120)
  })

  it('defaults the hook behaviour to on, gated by the presence check rather than a flag', () => {
    const { env, cwd } = setup({})
    const config = loadConfig({ cwd, env })
    expect(config.ask_notifications.value).toBe(true)
    expect(config.away_after_seconds.value).toBe(120)
    // 300 grace + 180 reply + 60 installer headroom = 540, inside the 600s
    // ceiling both harnesses kill a command hook at.
    expect(config.hook_reply_timeout_seconds.value).toBe(180)
    expect(config.ask_grace_seconds.value).toBe(300)
  })
})

describe('config precedence', () => {
  it('defaults apply with provenance', () => {
    const { env, cwd } = setup({})
    const config = loadConfig({ cwd, env })
    expect(config.wait_seconds.value).toBe(10)
    expect(config.wait_seconds.source).toBe('default')
    expect(config.ttl_seconds.value).toBe(86400)
  })

  it('project config (found by parent walk) beats machine-global', () => {
    const { env, cwd } = setup({
      globalToml: 'wait_seconds = 20\nsound = "default"\n',
      projectToml: 'wait_seconds = 5\n',
    })
    const config = loadConfig({ cwd, env })
    expect(config.wait_seconds.value).toBe(5)
    expect(config.wait_seconds.source).toMatch(/^project:/)
    expect(config.sound.value).toBe('default')
    expect(config.sound.source).toMatch(/^global:/)
  })

  it('flags beat everything', () => {
    const { env, cwd } = setup({ projectToml: 'wait_seconds = 5\n' })
    const config = loadConfig({ cwd, env, flags: { wait_seconds: 2 } })
    expect(config.wait_seconds.value).toBe(2)
    expect(config.wait_seconds.source).toBe('flag')
  })
})

describe('draft building', () => {
  const base = setup({})

  it('builds a minimal draft with defaults', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, { title: 'T', body: 'B' })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft).toEqual({
      schema_version: 1,
      presentation: { title: 'T', body: 'B' },
      targets: { mode: 'all' },
      delivery: { ttl_seconds: 86400, collapse_key: null },
    })
  })

  it('stamps the project from flag or project config (D-038)', () => {
    const { env, cwd } = setup({ projectToml: 'project = "my-app"\n' })
    const config = loadConfig({ cwd, env })
    const fromConfig = buildDraft(config, { title: 'T', body: 'B' })
    if (!fromConfig.ok) throw new Error(fromConfig.error)
    expect(fromConfig.draft.project).toBe('my-app')
    const fromFlag = buildDraft(config, { title: 'T', body: 'B', project: 'other-app' })
    if (!fromFlag.ok) throw new Error(fromFlag.error)
    expect(fromFlag.draft.project).toBe('other-app')
  })

  it('carries --kind and rejects one outside the vocabulary (D-060)', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const done = buildDraft(config, { title: 'T', body: 'B', kind: 'done' })
    if (!done.ok) throw new Error(done.error)
    expect(done.draft.kind).toBe('done')
    // Absent stays absent rather than becoming an explicit 'update': the
    // server reads a missing field as the default, and the envelope has 4096
    // bytes to spend on things that say something.
    const plain = buildDraft(config, { title: 'T', body: 'B' })
    if (!plain.ok) throw new Error(plain.error)
    expect(plain.draft.kind).toBeUndefined()
    // Caught in the CLI so the agent gets the list, not a schema error from
    // the server after a round trip.
    const bad = buildDraft(config, { title: 'T', body: 'B', kind: 'finished' })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('expected rejection')
    expect(bad.error).toContain('"done"')
  })

  it('uses configured devices unless --all is passed', () => {
    const { env, cwd } = setup({ projectToml: 'devices = ["dev_a", "dev_b"]\n' })
    const config = loadConfig({ cwd, env })
    const scoped = buildDraft(config, { title: 'T', body: 'B' })
    if (!scoped.ok) throw new Error(scoped.error)
    expect(scoped.draft.targets).toEqual({ mode: 'selected', device_ids: ['dev_a', 'dev_b'] })
    const all = buildDraft(config, { title: 'T', body: 'B', all: true })
    if (!all.ok) throw new Error(all.error)
    expect(all.draft.targets).toEqual({ mode: 'all' })
  })

  it('maps sound none to explicit null and parses custom data', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'T',
      body: 'B',
      sound: 'none',
      level: 'time_sensitive',
      data: ['run_id=42', 'branch=main'],
    })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.platform?.ios).toEqual({
      sound: null,
      interruption_level: 'time_sensitive',
      custom_data: { run_id: '42', branch: 'main' },
    })
  })

  it('maps optional fields into the selected macOS platform slot', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'T',
      body: 'B',
      platform: 'macos',
      sound: 'none',
      badge: 7,
      threadId: 'desktop-builds',
      level: 'passive',
      relevance: 0.8,
      targetContentId: 'build-detail',
      data: ['run_id=42'],
    })
    if (!build.ok) throw new Error(build.error)

    expect(build.platform).toBe('macos')
    expect(build.draft.platform).toEqual({
      macos: {
        sound: null,
        badge: 7,
        thread_id: 'desktop-builds',
        interruption_level: 'passive',
        relevance_score: 0.8,
        target_content_id: 'build-detail',
        custom_data: { run_id: '42' },
      },
    })
  })

  it('rejects malformed inputs with usage errors', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    expect(buildDraft(config, { title: '', body: 'B' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', sound: 'airhorn' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', data: ['nokey'] }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', level: 'shouting' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', platform: 'linux' }).ok).toBe(false)
  })
})
