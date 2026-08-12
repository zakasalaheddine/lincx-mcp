import test from 'ava'
import { shiftUtcDate, isValidTimeZone, rebucketRowsToTimezone } from '../tools/reportingTools.js'

// shiftUtcDate
test('shiftUtcDate > shifts across month/year boundaries', t => {
  t.is(shiftUtcDate('2026-07-14', -1), '2026-07-13')
  t.is(shiftUtcDate('2026-07-31', 1), '2026-08-01')
  t.is(shiftUtcDate('2026-01-01', -1), '2025-12-31')
})

// isValidTimeZone
test('isValidTimeZone > accepts IANA zones, rejects junk', t => {
  t.is(isValidTimeZone('America/Denver'), true)
  t.is(isValidTimeZone('UTC'), true)
  t.is(isValidTimeZone('Mars/Phobos'), false)
})

// rebucketRowsToTimezone
test('rebucketRowsToTimezone > shifts UTC date/hour back into local time, crossing local midnight', t => {
  // UTC 2026-07-14 03:00, Denver = UTC-6 (MDT) → 2026-07-13 21:00 local
  const [r] = rebucketRowsToTimezone([{ date: '2026-07-14', hour: '3', loads: 5 }], 'America/Denver')
  t.is(r.date, '2026-07-13')
  t.is(r.hour, '21')
  t.is(r.loads, 5) // metrics untouched
})

test('rebucketRowsToTimezone > is DST-correct: winter uses UTC-7 (MST), not summer\'s UTC-6', t => {
  // UTC 2026-01-14 03:00, Denver = UTC-7 (MST) → 2026-01-13 20:00 local
  const [r] = rebucketRowsToTimezone([{ date: '2026-01-14', hour: '3' }], 'America/Denver')
  t.is(r.date, '2026-01-13')
  t.is(r.hour, '20')
})

test('rebucketRowsToTimezone > passes rows through unchanged when date is missing/malformed', t => {
  const rows = [{ hour: '3', loads: 1 }, { date: 'bad', loads: 2 }]
  t.deepEqual(rebucketRowsToTimezone(rows, 'America/Denver'), rows)
})
