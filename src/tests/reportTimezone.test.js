import { describe, it, expect } from 'vitest'
import { shiftUtcDate, isValidTimeZone, rebucketRowsToTimezone } from '../tools/reportingTools.js'

describe('shiftUtcDate', () => {
  it('shifts across month/year boundaries', () => {
    expect(shiftUtcDate('2026-07-14', -1)).toBe('2026-07-13')
    expect(shiftUtcDate('2026-07-31', 1)).toBe('2026-08-01')
    expect(shiftUtcDate('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('isValidTimeZone', () => {
  it('accepts IANA zones, rejects junk', () => {
    expect(isValidTimeZone('America/Denver')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Phobos')).toBe(false)
  })
})

describe('rebucketRowsToTimezone', () => {
  it('shifts UTC date/hour back into local time, crossing local midnight', () => {
    // UTC 2026-07-14 03:00, Denver = UTC-6 (MDT) → 2026-07-13 21:00 local
    const [r] = rebucketRowsToTimezone([{ date: '2026-07-14', hour: '3', loads: 5 }], 'America/Denver')
    expect(r.date).toBe('2026-07-13')
    expect(r.hour).toBe('21')
    expect(r.loads).toBe(5) // metrics untouched
  })

  it("is DST-correct: winter uses UTC-7 (MST), not summer's UTC-6", () => {
    // UTC 2026-01-14 03:00, Denver = UTC-7 (MST) → 2026-01-13 20:00 local
    const [r] = rebucketRowsToTimezone([{ date: '2026-01-14', hour: '3' }], 'America/Denver')
    expect(r.date).toBe('2026-01-13')
    expect(r.hour).toBe('20')
  })

  it('passes rows through unchanged when date is missing/malformed', () => {
    const rows = [{ hour: '3', loads: 1 }, { date: 'bad', loads: 2 }]
    expect(rebucketRowsToTimezone(rows, 'America/Denver')).toEqual(rows)
  })
})
