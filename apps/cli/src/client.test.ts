import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { NetworkError, createClient } from './client.js'

/**
 * These run against a real socket rather than a stubbed fetch, because the
 * failure being fixed is a property of the transport: a server that accepts the
 * connection and then says nothing. A mock that resolves or rejects cannot
 * reproduce it (NotifAI-tcn).
 */
let server: Server | undefined

afterEach(async () => {
  if (server) {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
})

/** Starts a server with the given behaviour and returns its base URL. */
async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('a server that never answers (NotifAI-tcn)', () => {
  it('gives up instead of hanging until the harness kills the hook', async () => {
    // Accepts the request, holds the socket open, writes nothing — ever.
    const held: unknown[] = []
    const baseUrl = await serving((_request, response) => {
      held.push(response)
    })
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    const started = Date.now()
    await expect(client.listDevices()).rejects.toBeInstanceOf(NetworkError)
    // The point is that it returns at all; the bound is loose so a busy CI box
    // does not make this flaky.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(held).toHaveLength(1)
  })

  it('says the server went quiet rather than reporting a bare abort', async () => {
    const baseUrl = await serving(() => {})
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    await expect(client.listDevices()).rejects.toThrow(/did not respond within/)
  })

  it('allows for the long poll it asked the server to hold', async () => {
    // The deadline is per request, so a 25s long poll must not be cut off by
    // the ordinary budget — otherwise waiting for a reply could never work.
    let seen: string | undefined
    const baseUrl = await serving((request, response) => {
      seen = request.url
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ request_id: 'req_1', reply_expires_at: null, replies: [] }))
    })
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    const result = await client.replies('req_1', { waitSeconds: 25, afterSeq: 0 })

    expect(seen).toContain('wait_seconds=25')
    expect(result.replies).toEqual([])
  })

  it('treats a truncated body as a transport failure, not a crash', async () => {
    // A body that stops mid-JSON used to escape as a raw parse error outside
    // the retry path, so nothing backed off and retried it.
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.write('{"devices": [')
      response.destroy()
    })
    const client = createClient(baseUrl, null, { timeoutMs: 500 })

    await expect(client.listDevices()).rejects.toBeInstanceOf(NetworkError)
  })
})
