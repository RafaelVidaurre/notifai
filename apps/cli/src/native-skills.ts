import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The two scopes offered by the skills installer. */
export type SkillScope = 'project' | 'global'

/** The installer-managed evidence needed by NotifAI readiness. */
export interface NativeSkill {
  name: string
  scope: SkillScope
  path: string
  source: string | null
  sourceType: string | null
  sourceUrl: string | null
  ref: string | null
}

export interface SkillsListResult {
  skills: NativeSkill[]
  error?: string
}

export interface SkillsAddOptions {
  source: string
  skill: string
  scope?: SkillScope
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface NativeSkills {
  /** Launch the native interactive `npx skills add` flow. */
  add(options: SkillsAddOptions): Promise<number>
  /** Ask the native installer for its managed install inventory. */
  list(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): Promise<SkillsListResult>
}

interface JsonSkill {
  name?: unknown
  path?: unknown
  scope?: unknown
  source?: unknown
  sourceType?: unknown
  sourceUrl?: unknown
}

interface LockEntry {
  source?: unknown
  sourceType?: unknown
  sourceUrl?: unknown
  ref?: unknown
}

interface LockFile {
  skills?: Record<string, LockEntry>
}

function skillLockPath(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): string {
  if (scope === 'project') return path.join(cwd, 'skills-lock.json')
  const stateHome = env['XDG_STATE_HOME']
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  return stateHome !== undefined && stateHome !== ''
    ? path.join(stateHome, 'skills', '.skill-lock.json')
    : path.join(home, '.agents', '.skill-lock.json')
}

function readLock(scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): LockFile {
  const file = skillLockPath(scope, cwd, env)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LockFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function lockEntryFor(lock: LockFile, name: string): LockEntry | undefined {
  const direct = lock.skills?.[name]
  if (direct) return direct
  const normalized = name.toLowerCase().replace(/[\s_]+/g, '-')
  const key = Object.keys(lock.skills ?? {}).find(
    (candidate) => candidate.toLowerCase().replace(/[\s_]+/g, '-') === normalized,
  )
  return key === undefined ? undefined : lock.skills?.[key]
}

function jsonArray(stdout: string): unknown[] | null {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) return null
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function managedSkills(stdout: string, scope: SkillScope, cwd: string, env: NodeJS.ProcessEnv): NativeSkill[] | null {
  const entries = jsonArray(stdout)
  if (entries === null) return null
  const lock = readLock(scope, cwd, env)
  return entries.flatMap((entry): NativeSkill[] => {
    if (entry === null || typeof entry !== 'object') return []
    const value = entry as JsonSkill
    if (
      typeof value.name !== 'string' ||
      typeof value.path !== 'string' ||
      value.scope !== scope
    ) {
      return []
    }
    const lockEntry = lockEntryFor(lock, value.name)
    return [
      {
        name: value.name,
        scope,
        path: value.path,
        source: typeof value.source === 'string' ? value.source : null,
        sourceType: typeof value.sourceType === 'string' ? value.sourceType : null,
        sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : null,
        ref: typeof lockEntry?.ref === 'string' ? lockEntry.ref : null,
      },
    ]
  })
}

function run(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' | 'capture' },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    })
    if (options.stdio === 'capture') {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      child.on('error', () => resolve({ code: 1, stdout }))
      child.on('exit', (code) => resolve({ code: code ?? 1, stdout }))
      return
    }
    child.on('error', () => resolve({ code: 1, stdout: '' }))
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout: '' }))
  })
}

/** The only process/filesystem adapter NotifAI needs for the external installer. */
export const nativeSkills: NativeSkills = {
  async add(options) {
    const args = ['-y', 'skills', 'add', options.source, '--skill', options.skill]
    if (options.scope === 'global') args.push('--global')
    // An explicit scope is the unattended contract. Native `--yes` keeps all
    // remaining installer prompts non-interactive after the scope is chosen.
    if (options.scope !== undefined) args.push('--yes')
    return (await run(args, { cwd: options.cwd, env: options.env, stdio: 'inherit' })).code
  },

  async list(scope, cwd, env) {
    const result = await run(
      ['-y', 'skills', 'list', '--json', ...(scope === 'global' ? ['--global'] : [])],
      { cwd, env, stdio: 'capture' },
    )
    if (result.code !== 0) return { skills: [], error: `npx skills list exited with code ${result.code}` }
    const skills = managedSkills(result.stdout, scope, cwd, env)
    return skills === null
      ? { skills: [], error: 'npx skills list returned invalid JSON' }
      : { skills }
  },
}
