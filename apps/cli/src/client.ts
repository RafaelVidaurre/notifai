import type {
  ApiErrorBody,
  BeginPairingResponse,
  CapabilityDocument,
  CreateMediaUploadRequestT,
  CreateMediaUploadResponse,
  EvidenceSnapshot,
  ListDevicesResponse,
  ListRepliesResponse,
  Platform,
  PollPairingResponse,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'

export class ApiCallError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public nextAction: string | null = null,
    public details: unknown = null,
  ) {
    super(message)
  }
}

export class NetworkError extends Error {}

/**
 * A deadline that fired reads as an abort, which says nothing useful on its
 * own. Naming the timeout is what lets someone tell a hung server apart from a
 * refused connection.
 */
function networkFailure(err: unknown, root: string, limitMs: number): NetworkError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new NetworkError(`${root} did not respond within ${Math.round(limitMs / 1000)}s`)
  }
  return new NetworkError(`Could not reach ${root}: ${String(err)}`)
}

export interface ApiClient {
  beginPairing(body: {
    machine_name: string
    credential_hash: string
    poll_verifier_hash: string
  }): Promise<BeginPairingResponse>
  pollPairing(pairingId: string, pollVerifier: string): Promise<PollPairingResponse>
  listDevices(): Promise<ListDevicesResponse>
  capabilities(platform?: Platform): Promise<CapabilityDocument>
  submit(body: SubmitNotificationRequestT, waitSeconds: number): Promise<SubmissionReceipt>
  evidence(requestId: string): Promise<EvidenceSnapshot>
  replies(
    requestId: string,
    options: { waitSeconds: number; afterSeq: number },
  ): Promise<ListRepliesResponse>
  /** Retire a question so a late device answer is rejected rather than lost. */
  closeReplies(requestId: string): Promise<void>
  createMediaUpload(body: CreateMediaUploadRequestT): Promise<CreateMediaUploadResponse>
  uploadMedia(grant: CreateMediaUploadResponse, bytes: Uint8Array): Promise<void>
  health(): Promise<boolean>
}

export interface ClientOptions {
  /**
   * Ceiling for a single request, on top of any long poll the server has been
   * asked to hold. Callers running inside a harness hook shrink this so their
   * whole network path stays inside the budget the harness allows them.
   */
  timeoutMs?: number
}

/** Generous enough for a slow link, short enough that nothing hangs for ever. */
const DEFAULT_TIMEOUT_MS = 20_000

export function createClient(
  baseUrl: string,
  bearer: string | null,
  options: ClientOptions = {},
): ApiClient {
  const root = baseUrl.replace(/\/$/, '')
  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function call<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    /** Seconds the server was asked to hold the connection open. */
    serverWaitSeconds = 0,
  ): Promise<T> {
    // Without this, a server that accepts the connection and then never answers
    // hangs until the harness kills the whole hook — and the reply-poll deadline
    // cannot interrupt an individual fetch. The signal covers the
    // body read too, not just the response headers.
    const limitMs = budgetMs + serverWaitSeconds * 1000
    const signal = AbortSignal.timeout(limitMs)
    let response: Response
    try {
      response = await fetch(`${root}${apiPath}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: bearer } : {}),
        },
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      throw networkFailure(err, root, limitMs)
    }
    if (!response.ok) {
      let parsed: ApiErrorBody | null = null
      try {
        parsed = (await response.json()) as ApiErrorBody
      } catch {
        // non-JSON body
      }
      throw new ApiCallError(
        response.status,
        parsed?.error.code ?? 'internal_error',
        parsed?.error.message ?? `Request failed with status ${response.status}`,
        parsed?.error.next_action ?? null,
        parsed?.error.details ?? null,
      )
    }
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch (err) {
      // A truncated or abandoned body is a transport failure, not a protocol
      // one: it must be retryable like any other, not surface as a raw abort.
      throw networkFailure(err, root, limitMs)
    }
  }

  return {
    beginPairing: (body) => call('POST', '/api/v1/pairings', body),
    pollPairing: (pairingId, pollVerifier) =>
      call('POST', `/api/v1/pairings/${pairingId}/poll`, { poll_verifier: pollVerifier }),
    listDevices: () => call('GET', '/api/v1/devices'),
    capabilities: (platform = 'ios') => call('GET', `/api/v1/capabilities/${platform}`),
    submit: (body, waitSeconds) =>
      call('POST', `/api/v1/notifications?wait_seconds=${waitSeconds}`, body, waitSeconds),
    evidence: (requestId) => call('GET', `/api/v1/notifications/${requestId}`),
    replies: (requestId, { waitSeconds, afterSeq }) =>
      call(
        'GET',
        `/api/v1/notifications/${encodeURIComponent(requestId)}/replies?wait_seconds=${waitSeconds}&after_seq=${afterSeq}`,
        undefined,
        waitSeconds,
      ),
    closeReplies: (requestId) =>
      call('POST', `/api/v1/notifications/${encodeURIComponent(requestId)}/replies/close`),
    createMediaUpload: (body) => call('POST', '/api/v1/media', body),
    uploadMedia: async (grant, bytes) => {
      let response: Response
      try {
        response = await fetch(grant.upload_url, {
          method: 'PUT',
          headers: grant.upload_headers,
          body: bytes,
          // Media can be large, so this gets its own allowance rather than the
          // per-request budget — but still a finite one.
          signal: AbortSignal.timeout(Math.max(budgetMs, 60_000)),
        })
      } catch (err) {
        throw new NetworkError(`Upload failed: ${String(err)}`)
      }
      if (!response.ok) {
        throw new NetworkError(`Upload rejected with status ${response.status}`)
      }
    },
    health: async () => {
      try {
        await call('GET', '/healthz')
        return true
      } catch {
        return false
      }
    },
  }
}
