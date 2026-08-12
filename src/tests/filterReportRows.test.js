import test from 'ava'
import { filterReportRows, aggregateReport } from '../tools/reportingTools.js'

const rows = [
  { advertiser: 'Acme', zone: 'Primary', date: '2026-07-14', hour: '00', loads: 100, revenue: 1.0 },
  { advertiser: 'Acme', zone: 'Primary', date: '2026-07-14', hour: '15', loads: 50, revenue: 2.0 },
  { advertiser: 'Globex', zone: 'Primary', date: '2026-07-14', hour: '00', loads: 20, revenue: 0.5 }
]

// filterReportRows
test('filterReportRows > passes everything through when no filter', t => {
  const r = filterReportRows(rows, undefined)
  t.is(r.rows.length, 3)
  t.deepEqual(r.missingKeys, [])
})

test('filterReportRows > keeps only matching rows, case-insensitively', t => {
  const r = filterReportRows(rows, { advertiser: 'acme' })
  t.is(r.rows.length, 2)
  t.deepEqual(r.missingKeys, [])
  // filtered rows aggregate to just Acme's totals
  t.is(aggregateReport(r.rows, []).total.loads, 150)
})

test('filterReportRows > flags a filter key that is not a dimension of any row (guards silent empty)', t => {
  const r = filterReportRows(rows, { campaign: 'X' })
  t.deepEqual(r.missingKeys, ['campaign'])
  t.is(r.rows.length, 0)
})

test('filterReportRows > returns value hints when key exists but no value matches (typo recovery)', t => {
  const r = filterReportRows(rows, { advertiser: 'Acmee' })
  t.deepEqual(r.missingKeys, [])
  t.is(r.rows.length, 0)
  t.true(r.valueHints.includes('advertiser=Acme'))
  t.true(r.valueHints.includes('advertiser=Globex'))
})

test('filterReportRows > supports multi-key AND filters', t => {
  const r = filterReportRows(rows, { advertiser: 'Acme', zone: 'Primary' })
  t.is(r.rows.length, 2)
})
