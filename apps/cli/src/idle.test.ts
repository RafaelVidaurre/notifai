import { describe, expect, it } from 'vitest'
import { parseIdleSeconds, readIdleSeconds } from './idle.js'

describe('OS idle probe', () => {
  it('reads HIDIdleTime as nanoseconds', () => {
    // Verbatim shape of `ioreg -c IOHIDSystem -r -k HIDIdleTime`.
    const output = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc>
    {
      "HIDIdleTime" = 151627250
      "HIDPointerAcceleration" = 6144
    }
`
    expect(parseIdleSeconds(output)).toBeCloseTo(0.15, 2)
  })

  it('reads a long idle period', () => {
    expect(parseIdleSeconds('"HIDIdleTime" = 900000000000')).toBe(900)
  })

  it('returns null rather than a wrong number when the key is absent or junk', () => {
    // null degrades to the elapsed-time signal; a bogus 0 would instead pin the
    // user "present" forever and silently disable escalation altogether.
    expect(parseIdleSeconds('')).toBeNull()
    expect(parseIdleSeconds('"HIDPointerAcceleration" = 6144')).toBeNull()
    expect(parseIdleSeconds('"HIDIdleTime" = <ptr>')).toBeNull()
  })

  it('reports no signal on platforms without one, instead of throwing', () => {
    expect(readIdleSeconds('linux')).toBeNull()
    expect(readIdleSeconds('win32')).toBeNull()
  })
})
