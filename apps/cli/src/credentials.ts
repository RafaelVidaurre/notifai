import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { globalConfigDir } from './config.js'

export interface MachineCredential {
  machineId: string
  secret: string
  baseUrl: string
  machineName: string
}

export interface CredentialStore {
  load(): MachineCredential | null
  save(credential: MachineCredential): void
  clear(): void
  /** Where the secret lives, for `doctor` and docs. */
  describe(): string
}

const SERVICE = 'io.notifai.cli'

/** macOS Keychain via the `security` CLI — no native addons (proposal concern). */
export class KeychainStore implements CredentialStore {
  load(): MachineCredential | null {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', 'machine', '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim()
      return JSON.parse(raw) as MachineCredential
    } catch {
      return null
    }
  }

  save(credential: MachineCredential): void {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-U',
        '-s',
        SERVICE,
        '-a',
        'machine',
        '-w',
        JSON.stringify(credential),
      ],
      { stdio: 'ignore' },
    )
  }

  clear(): void {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', 'machine'], {
        stdio: 'ignore',
      })
    } catch {
      // nothing stored
    }
  }

  describe(): string {
    return `macOS Keychain (${SERVICE})`
  }
}

/** 0600 file fallback for hosts without a keychain. */
export class FileStore implements CredentialStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private filePath(): string {
    return path.join(globalConfigDir(this.env), 'credentials.json')
  }

  load(): MachineCredential | null {
    const file = this.filePath()
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as MachineCredential
    } catch {
      return null
    }
  }

  save(credential: MachineCredential): void {
    const file = this.filePath()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  }

  clear(): void {
    rmSync(this.filePath(), { force: true })
  }

  describe(): string {
    return this.filePath()
  }
}

function keychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('security', ['help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  if (env['NOTIFAI_CREDENTIALS'] === 'file') return new FileStore(env)
  return keychainAvailable() ? new KeychainStore() : new FileStore(env)
}
