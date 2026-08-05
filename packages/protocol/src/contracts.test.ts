import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES_V1,
  defaultDeliveryPolicy,
  effectiveKind,
  estimateApnsPayloadBytes,
  IOS_CAPABILITIES_V1,
  MACOS_CAPABILITIES_V1,
  REPLY_CATEGORY_ID,
  REPLY_CHOICE_CATEGORY_ID,
  summarizeOverall,
  validateDraft,
  type NotificationDraftT,
} from './index.js'
import { buildApnsEnvelope, RECEIPT_TOKEN_LENGTH } from './apns.js'

function draft(overrides: Partial<NotificationDraftT> = {}): NotificationDraftT {
  return {
    schema_version: 1,
    event: 'work-completed',
    presentation: { title: 'Build finished', body: 'All checks passed.' },
    targets: { mode: 'all' },
    delivery: defaultDeliveryPolicy(),
    ...overrides,
  }
}

describe('validateDraft', () => {
  it('accepts a minimal valid draft', () => {
    const report = validateDraft(draft())
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  })

  it('carries the delivery receipt token on both alert and silent pushes', () => {
    // The extension authorizes its receipt with this and nothing else, so a
    // payload without it is an extension that cannot report (NotifAI-gyu).
    const ids = { requestId: 'req_x', deliveryId: 'del_x', receiptToken: 'r'.repeat(22) }
    const alert = buildApnsEnvelope(draft(), ids, null)
    expect((alert.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBe(
      'r'.repeat(22),
    )
    // A `done` retirement is a background push assembled by a separate branch;
    // it publishes the same identifiers as the alert it retires.
    const retirement = draft({ lifecycle: { tier: 'done', retires_request_id: 'req_old' } })
    const silent = buildApnsEnvelope(retirement, ids, null)
    expect((silent.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBe(
      'r'.repeat(22),
    )
    // Omitted rather than null when absent — no key earns envelope bytes for
    // saying nothing.
    const without = buildApnsEnvelope(draft(), { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((without.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBeUndefined()
  })

  it('accepts a draft with a project identifier and renders it in the envelope', () => {
    const withProject = draft({ project: 'my-app.v2' })
    expect(validateDraft(withProject).ok).toBe(true)
    const envelope = buildApnsEnvelope(withProject, { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['project']).toBe('my-app.v2')
    // Project sends must run the NSE so the communication upgrade can apply.
    expect((envelope.payload['aps'] as Record<string, unknown>)['mutable-content']).toBe(1)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['project_image_url']).toBeUndefined()

    const withAvatar = buildApnsEnvelope(
      withProject,
      { requestId: 'req_x', deliveryId: 'del_x' },
      null,
      'ios',
      { name: 'My App', imageUrl: 'https://signed.example/avatar.png' },
    )
    const notifai = withAvatar.payload['notifai'] as Record<string, unknown>
    expect(notifai['project_image_url']).toBe('https://signed.example/avatar.png')
    expect(notifai['project_name']).toBe('My App')
  })

  it('carries the session identifier into the envelope for badge rendering', () => {
    const withSession = draft({ project: 'my-app', session: 'sess_abc123' })
    expect(validateDraft(withSession).ok).toBe(true)
    const envelope = buildApnsEnvelope(withSession, { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['session']).toBe('sess_abc123')
  })

  it('rejects project identifiers outside the slug alphabet', () => {
    const report = validateDraft(draft({ project: 'My App!' }))
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('rejects schema violations with invalid_request', () => {
    const report = validateDraft({ ...draft(), presentation: { title: '', body: 'x' } })
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('rejects unknown top-level fields instead of silently dropping them', () => {
    const report = validateDraft({ ...draft(), icon: 'rocket.png' })
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('reports oversized payloads with payload_too_large', () => {
    const report = validateDraft(
      draft({
        presentation: { title: 'T'.repeat(500), body: 'B'.repeat(2000), subtitle: 'S'.repeat(500) },
        platform: { ios: { custom_data: Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [`key_${i}`, 'v'.repeat(512)]),
        ) } },
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.code === 'payload_too_large')).toBe(true)
  })

  it('estimates payload bytes above zero and below the limit for ordinary drafts', () => {
    const bytes = estimateApnsPayloadBytes(draft())
    expect(bytes).toBeGreaterThan(100)
    expect(bytes).toBeLessThan(4096)
  })

  it('adds the fixed APNs reply category and accounts for it in the payload estimate', () => {
    const withoutReply = draft()
    const withReply = draft({ reply: { expires_in_seconds: 86400 } })
    const envelope = buildApnsEnvelope(withReply, { requestId: 'req_x', deliveryId: 'del_x' }, null)

    expect((envelope.payload['aps'] as Record<string, unknown>)['category']).toBe(REPLY_CATEGORY_ID)
    expect(estimateApnsPayloadBytes(withReply)).toBeGreaterThan(estimateApnsPayloadBytes(withoutReply))
  })

  it('carries the reply window deadline so companions can offer an in-app reply', () => {
    const withReply = draft({ reply: { expires_in_seconds: 86400 } })
    const deadline = new Date('2026-08-03T09:15:00.000Z')
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }

    const envelope = buildApnsEnvelope(withReply, ids, null, 'ios', null, deadline)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['reply_expires_at']).toBe(
      '2026-08-03T09:15:00.000Z',
    )

    // No reply requested means no deadline to publish, whatever is passed in.
    const withoutReply = buildApnsEnvelope(draft(), ids, null, 'ios', null, deadline)
    expect(
      (withoutReply.payload['notifai'] as Record<string, unknown>)['reply_expires_at'],
    ).toBeUndefined()
  })

  it('validates replies on both companion platforms', () => {
    const withReply = draft({ reply: { expires_in_seconds: 86400 } })

    expect(validateDraft(withReply, IOS_CAPABILITIES_V1).ok).toBe(true)
    // D-062: the Mac registers the reply category and answers through the same
    // outbox, so a reply targeted at it is no longer rejected.
    expect(validateDraft(withReply, MACOS_CAPABILITIES_V1).ok).toBe(true)
  })

  it('carries the choice set to the device and only for closed questions', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const choices = [
      { id: 'staging', label: 'Staging' },
      { id: 'prod', label: 'Production' },
    ]
    const question = draft({ reply: { expires_in_seconds: 3600, kind: 'choice', choices } })

    const envelope = buildApnsEnvelope(question, ids, null)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['reply_choices']).toEqual(choices)
    // A closed question must not present a free-text field beside its answers.
    expect((envelope.payload['aps'] as Record<string, unknown>)['category']).toBe(
      REPLY_CHOICE_CATEGORY_ID,
    )

    // A free-text reply must not ship an empty picker to the device.
    const text = buildApnsEnvelope(draft({ reply: { expires_in_seconds: 3600 } }), ids, null)
    expect((text.payload['notifai'] as Record<string, unknown>)['reply_choices']).toBeUndefined()
    expect((text.payload['aps'] as Record<string, unknown>)['category']).toBe(REPLY_CATEGORY_ID)
  })

  it('rejects closed questions that cannot be answered', () => {
    // kind says 'choice' but nothing is offered.
    expect(validateDraft(draft({ reply: { expires_in_seconds: 3600, kind: 'choice' } }))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'reply.choices' })],
    })

    // Two answers the agent cannot tell apart.
    expect(
      validateDraft(
        draft({
          reply: {
            expires_in_seconds: 3600,
            kind: 'choice',
            choices: [
              { id: 'yes', label: 'Yes' },
              { id: 'yes', label: 'Yeah' },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'reply.choices' })],
    })

    // Choices without a closed question would silently never be shown.
    expect(
      validateDraft(
        draft({
          reply: { expires_in_seconds: 3600, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
        }),
      ),
    ).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: 'reply.choices' })] })
  })

  it('keeps pre-existing reply blocks valid and defaulted to free text', () => {
    const legacy = draft({ reply: { expires_in_seconds: 86400 } })
    expect(validateDraft(legacy, IOS_CAPABILITIES_V1).ok).toBe(true)
    expect(buildApnsEnvelope(legacy, { requestId: 'req_x', deliveryId: 'del_x' }, null).payload).toBeDefined()
  })

  it('describes the supported iOS and macOS capability contracts', () => {
    expect(CAPABILITIES_V1.describe('ios')?.platform).toBe('ios')
    expect(CAPABILITIES_V1.describe('macos')).toBe(MACOS_CAPABILITIES_V1)
    expect(MACOS_CAPABILITIES_V1.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'presentation.image', status: 'downgraded' }),
        expect.objectContaining({ path: 'reply', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.sound', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.thread_id', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.category', status: 'unsupported' }),
        expect.objectContaining({ path: 'sound_file', status: 'unsupported' }),
      ]),
    )
  })

  it('warns when macOS delivery omits a requested image', () => {
    const withImage = draft({
      presentation: { title: 'Hi', body: 'Body', image: { media_id: 'med_example' } },
    })

    expect(validateDraft(withImage, MACOS_CAPABILITIES_V1)).toMatchObject({
      ok: true,
      errors: [],
      warnings: [
        {
          path: 'presentation.image',
          message: expect.stringContaining('omitted on macOS'),
        },
      ],
    })
    expect(validateDraft(withImage, IOS_CAPABILITIES_V1).warnings).toEqual([])
  })

  it('warns when a target requests Time Sensitive behavior without the capability', () => {
    const timeSensitive = draft({
      platform: { ios: { interruption_level: 'time_sensitive' } },
    })
    const macTimeSensitive = draft({
      platform: { macos: { interruption_level: 'time_sensitive' } },
    })
    const active = draft({ platform: { ios: { interruption_level: 'active' } } })

    expect(validateDraft(timeSensitive, IOS_CAPABILITIES_V1)).toMatchObject({
      ok: true,
      warnings: [
        {
          path: 'platform.ios.interruption_level',
          message: expect.stringContaining('Time Sensitive breakthrough is unavailable'),
        },
      ],
    })
    expect(validateDraft(macTimeSensitive, MACOS_CAPABILITIES_V1).warnings).toEqual([
      expect.objectContaining({ path: 'platform.macos.interruption_level' }),
    ])
    expect(validateDraft(active, IOS_CAPABILITIES_V1).warnings).toEqual([])
  })

  it('uses the same APNs envelope rules for estimation and rendering', () => {
    const withImage = draft({
      event: 'tests_passed',
      presentation: { title: 'Hi', body: 'Body', image: { media_id: 'med_example' } },
      platform: { ios: {} },
    })
    const mediaUrl = 'https://x.invalid/'.padEnd(500, 'a')
    const envelope = buildApnsEnvelope(
      withImage,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        // Every real dispatch carries one, so the estimate reserves its width.
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
      },
      mediaUrl,
    )
    const aps = envelope.payload['aps'] as Record<string, unknown>

    expect(aps['interruption-level']).toBe('active')
    expect(aps['mutable-content']).toBe(1)
    expect(estimateApnsPayloadBytes(withImage)).toBe(
      new TextEncoder().encode(JSON.stringify(envelope.payload)).length,
    )
  })

  it('uses macOS platform options in the shared APNs envelope', () => {
    const macosDraft = draft({
      presentation: { title: 'Hi', body: 'Body' },
      platform: {
        macos: {
          sound: null,
          badge: 3,
          thread_id: 'desktop-builds',
          interruption_level: 'passive',
          relevance_score: 0.8,
          target_content_id: 'build-detail',
          custom_data: { run_id: '42' },
        },
      },
    })
    const envelope = buildApnsEnvelope(
      macosDraft,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
      },
      null,
      'macos',
    )
    const aps = envelope.payload['aps'] as Record<string, unknown>
    const notifai = envelope.payload['notifai'] as Record<string, unknown>

    expect(envelope.priority).toBe(5)
    expect(aps).toMatchObject({
      badge: 3,
      'thread-id': 'desktop-builds',
      'interruption-level': 'passive',
      'relevance-score': 0.8,
      'target-content-id': 'build-detail',
    })
    expect(aps).not.toHaveProperty('sound')
    expect(notifai['data']).toEqual({ run_id: '42' })
    expect(estimateApnsPayloadBytes(macosDraft, 'macos')).toBe(
      new TextEncoder().encode(JSON.stringify(envelope.payload)).length,
    )
  })
})

describe('question lifecycle (D-A, D-B, D-C)', () => {
  it('renders a done draft as a silent background state sync', () => {
    const retirement = draft({
      event: 'question_retired',
      lifecycle: { tier: 'done', state: 'answered', retires_request_id: 'req_original' },
      delivery: { ttl_seconds: 60, collapse_key: 'notifai-hook-q1' },
      // Presentation options that would be visible must not survive into the
      // silent form: Apple forbids alert, sound, and badge alongside
      // content-available.
      platform: { ios: { sound: 'done', badge: 2, interruption_level: 'time_sensitive' } },
    })
    const envelope = buildApnsEnvelope(retirement, { requestId: 'req_x', deliveryId: 'del_x' }, null)

    expect(envelope.payload['aps']).toEqual({ 'content-available': 1 })
    expect(envelope.pushType).toBe('background')
    // 5 is the only legal priority for a background push.
    expect(envelope.priority).toBe(5)
    const notifai = envelope.payload['notifai'] as Record<string, unknown>
    // The lifecycle and the two correlation ids are the whole message: the
    // collapse key removes the DELIVERED notification, retires_request_id
    // finds the on-device HISTORY entry and marks it done.
    expect(notifai['lifecycle']).toEqual({
      tier: 'done',
      state: 'answered',
      retires_request_id: 'req_original',
    })
    expect(notifai['retires_request_id']).toBe('req_original')
    expect(notifai['collapse_key']).toBe('notifai-hook-q1')
  })

  it('publishes retires_request_id only on a done draft', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    // Schema-valid but meaningless: an end detail on a live tier is rejected.
    expect(
      validateDraft(
        draft({ lifecycle: { tier: 'needs_you', retires_request_id: 'req_original' } }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({ code: 'invalid_request', path: 'lifecycle.retires_request_id' }),
      ],
    })
    // An alert never carries the retirement pointer.
    const plain = buildApnsEnvelope(draft(), ids, null)
    expect((plain.payload['notifai'] as Record<string, unknown>)['retires_request_id']).toBeUndefined()
  })

  it('keeps needs-you and lifecycle-less drafts as alerts', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const question = draft({ lifecycle: { tier: 'needs_you' }, reply: { expires_in_seconds: 3600 } })
    const envelope = buildApnsEnvelope(question, ids, null)

    expect(envelope.pushType).toBe('alert')
    expect((envelope.payload['aps'] as Record<string, unknown>)['alert']).toBeDefined()
    expect((envelope.payload['notifai'] as Record<string, unknown>)['lifecycle']).toEqual({
      tier: 'needs_you',
    })

    // Absent means new: pre-lifecycle clients change meaning for nothing.
    const plain = buildApnsEnvelope(draft(), ids, null)
    expect(plain.pushType).toBe('alert')
    expect((plain.payload['notifai'] as Record<string, unknown>)['lifecycle']).toBeUndefined()
  })

  it('rejects an end state outside the done tier', () => {
    expect(
      validateDraft(draft({ lifecycle: { tier: 'needs_you', state: 'answered' } })),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'invalid_request', path: 'lifecycle.state' })],
    })
    expect(validateDraft(draft({ lifecycle: { tier: 'done', state: 'superseded' } })).ok).toBe(true)
  })
})

describe('notification kind (D-060)', () => {
  const notifaiKeyOf = (d: NotificationDraftT) =>
    buildApnsEnvelope(d, { requestId: 'req_k', deliveryId: 'del_k' }, null).payload[
      'notifai'
    ] as Record<string, unknown>

  it('omits the default so it costs nothing in a 4096-byte envelope', () => {
    expect(notifaiKeyOf(draft({}))).not.toHaveProperty('kind')
    expect(notifaiKeyOf(draft({ kind: 'update' }))).not.toHaveProperty('kind')
    expect(effectiveKind(draft({}))).toBe('update')
  })

  it('carries finished work to the device', () => {
    expect(notifaiKeyOf(draft({ kind: 'done' }))['kind']).toBe('done')
    // The pre-flight size check shares the assembly, so a new key can never be
    // charged to the 4096-byte budget at send time but not at estimate time.
    expect(estimateApnsPayloadBytes(draft({ kind: 'done' }), 'ios')).toBeGreaterThan(
      estimateApnsPayloadBytes(draft({}), 'ios'),
    )
  })

  it('derives question from the reply window rather than trusting the label', () => {
    // A reply block is a question by construction, so the sender cannot get
    // this one wrong — and cannot get it wrong in the other direction either.
    const asked = draft({ reply: { expires_in_seconds: 3600 } })
    expect(effectiveKind(asked)).toBe('question')
    expect(notifaiKeyOf(asked)['kind']).toBe('question')
    expect(effectiveKind(draft({ kind: 'done', reply: { expires_in_seconds: 3600 } }))).toBe(
      'question',
    )
  })

  it('rejects a question nobody can answer', () => {
    expect(validateDraft(draft({ kind: 'question' }))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'invalid_request', path: 'kind' })],
    })
    expect(validateDraft(draft({ kind: 'question', reply: { expires_in_seconds: 3600 } })).ok).toBe(
      true,
    )
  })

  it('rejects a kind outside the closed vocabulary', () => {
    expect(validateDraft(draft({ kind: 'blocked' } as unknown as Partial<NotificationDraftT>)).ok).toBe(
      false,
    )
  })
})

describe('summarizeOverall', () => {
  it('is pending while any delivery is unsettled', () => {
    expect(summarizeOverall(['queued', 'provider_accepted'])).toBe('pending')
    expect(summarizeOverall(['retry_scheduled'])).toBe('pending')
  })
  it('classifies settled sets', () => {
    expect(summarizeOverall(['provider_accepted', 'provider_accepted'])).toBe('provider_accepted_all')
    expect(summarizeOverall(['provider_rejected', 'expired'])).toBe('provider_rejected_all')
    expect(summarizeOverall(['provider_accepted', 'outcome_unknown'])).toBe('provider_accepted_partial')
  })
  it('is pending for the empty set', () => {
    expect(summarizeOverall([])).toBe('pending')
  })
})
