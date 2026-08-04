import { createHash } from 'node:crypto'

/** SHA-256 encoding shared by the Node-based CLI, server, and test support. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
