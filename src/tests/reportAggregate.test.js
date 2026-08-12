import test from 'ava'
import { aggregateReport } from '../tools/reportingTools.js'

// Two zones across two hourly rows each — mirrors the real report shape.
const rows = [
  { zone: 'Primary', date: '2026-05-19', hour: '00', loads: 100, clicks: 10, revenue: 1.1, level: 'date-hour-zone' },
  { zone: 'Primary', date: '2026-05-19', hour: '01', loads: 50, clicks: 5, revenue: 2.2, level: 'date-hour-zone' },
  { zone: 'Expired', date: '2026-05-19', hour: '00', loads: 20, clicks: 1, revenue: 0.1, level: 'date-hour-zone' }
]

{ // aggregateReport
  test('aggregateReport > returns a grand total (no group rows) when groupBy is empty', t => {
    const { total, groups } = aggregateReport(rows, [])
    t.is(groups, undefined)
    t.is(total.loads, 170)
    t.is(total.clicks, 16)
    t.is(total.revenue, 3.4) // 1.1 + 2.2 + 0.1, rounded to cents
  })

  test('aggregateReport > sums numeric metrics grouped by a field, sorted by loads desc', t => {
    const { total, groups } = aggregateReport(rows, ['zone'])
    t.is(total.loads, 170)
    t.is(groups.length, 2)
    // Primary first (more loads)
    t.like(groups[0], { zone: 'Primary', loads: 150, clicks: 15, _rows: 2 })
    t.like(groups[1], { zone: 'Expired', loads: 20, clicks: 1, _rows: 1 })
  })

  test('aggregateReport > rounds money fields to cents (no float drift)', t => {
    // 0.1 + 0.2 would be 0.30000000000000004 without rounding
    const drift = [
      { zone: 'Z', revenue: 0.1, loads: 1 },
      { zone: 'Z', revenue: 0.2, loads: 1 }
    ]
    const { total } = aggregateReport(drift, [])
    t.is(total.revenue, 0.3)
  })

  test('aggregateReport > buckets rows missing a groupBy field under (n/a)', t => {
    const mixed = [
      { zone: 'A', loads: 5 },
      { loads: 3 } // no zone
    ]
    const { groups } = aggregateReport(mixed, ['zone'])
    const naBucket = groups.find((g) => g.zone === '(n/a)')
    t.like(naBucket, { loads: 3 })
  })
}
