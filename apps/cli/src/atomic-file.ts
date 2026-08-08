import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface AtomicWriteOptions {
  /** Mode for a newly created file. Existing regular files keep their mode. */
  mode?: number
}

/**
 * Replace one regular file without exposing a truncated intermediate state.
 *
 * The temporary file is a unique sibling, so rename is atomic on every
 * supported filesystem. The contents are flushed before the rename, and a
 * symlink target is refused instead of silently writing through it.
 */
export function atomicWriteFileSync(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const mode = targetMode(file, options.mode ?? 0o600)
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.notifai-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle: number | undefined
  try {
    handle = openSync(temp, 'wx', mode)
    writeFileSync(handle, contents)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temp, file)
  } catch (err) {
    if (handle !== undefined) closeSync(handle)
    try {
      unlinkSync(temp)
    } catch {
      // Preserve the original error; the temp may not have been created.
    }
    throw err
  }
}

/** Mode to preserve, or the mode for a new file. Refuses a non-regular target. */
function targetMode(file: string, fallback: number): number {
  let stat
  try {
    stat = lstatSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `${file} is a symlink; refusing to write through it. Replace it with a regular file, ` +
        'or use a different state directory.',
    )
  }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file; refusing to replace it.`)
  return stat.mode & 0o777
}
