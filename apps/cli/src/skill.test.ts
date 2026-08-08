import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(new URL('../../../skills/notifai/SKILL.md', import.meta.url), 'utf8')
const harnessReference = readFileSync(
  new URL('../../../skills/notifai/references/harness-setup.md', import.meta.url),
  'utf8',
)

describe('Notifai agent skill', () => {
  it('leads with the notification decision before message composition', () => {
    expect(skill.indexOf('## When to notify')).toBeGreaterThan(0)
    expect(skill.indexOf('## When to notify')).toBeLessThan(skill.indexOf('## Compose and send'))
  })

  it('teaches kind profiles and a correctly classified completion', () => {
    expect(skill).toContain('--kind done')
    expect(skill).toContain('| `update` (default) | `none` | `passive` |')
    expect(skill).toContain('| `done` | `done` | `passive` |')
    expect(skill).toContain('| question (`--reply`) | `attention` | `active` |')
  })

  it('documents reply lifecycle, routing, session minting, and doctor exits', () => {
    for (const required of [
      '--reply-choice',
      'notifai close <request_id>',
      'notifai devices',
      '--device',
      '--all',
      "require('node:crypto').randomUUID()",
      'exit status is nonzero',
    ]) {
      expect(skill).toContain(required)
    }
  })

  it('moves per-harness mechanics into progressive disclosure', () => {
    expect(skill).toContain('[Harness setup and recovery](references/harness-setup.md)')
    for (const harness of ['Claude Code', 'Codex', 'Cursor', 'OpenCode']) {
      expect(harnessReference).toContain(`**${harness}:**`)
    }
  })
})
