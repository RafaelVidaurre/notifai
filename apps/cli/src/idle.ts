import { execFileSync } from 'node:child_process'

/**
 * Seconds since the user last touched the keyboard or mouse, or null when this
 * machine cannot say.
 *
 * The hooks need to know whether the user is at their desk, and the only signal
 * they had was silence since the last prompt — which includes the agent's own
 * turn, so a user watching a long build was indistinguishable from a user who
 * had left. This is the corroborating signal.
 *
 * null is a first-class answer, not a failure: on a machine with no idle source
 * the caller keeps its previous behaviour rather than guessing. That is why
 * every error path here returns null instead of throwing.
 */
export function readIdleSeconds(platform: NodeJS.Platform = process.platform): number | null {
  if (platform !== 'darwin') return null
  try {
    // -r -k narrows the dump to the one node carrying the key (~5KB), so this
    // stays a ~20ms call on the hot path of every Stop hook.
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-r', '-k', 'HIDIdleTime'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseIdleSeconds(out)
  } catch {
    // Missing binary, sandbox denial, timeout — all mean "no signal".
    return null
  }
}

/** Exported for tests: HIDIdleTime is nanoseconds since the last HID event. */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput)
  if (match?.[1] === undefined) return null
  const nanos = Number(match[1])
  if (!Number.isFinite(nanos) || nanos < 0) return null
  return nanos / 1e9
}
