import test from 'ava'
import { capGroups } from '../tools/reportingTools.js'

const base = { dimensionSet: 'ds', range: { startDate: '2026-07-01', endDate: '2026-07-07' }, groupBy: ['zone'], rowsScanned: 100 }
const total = { loads: 1000, revenue: 50 }

test('capGroups > returns groups untouched when undefined (grand-total mode)', t => {
  t.deepEqual(capGroups(base, total, undefined), {})
})

test('capGroups > keeps all groups when they fit', t => {
  const groups = Array.from({ length: 10 }, (_, i) => ({ zone: `z${i}`, loads: 10 - i }))
  const r = capGroups(base, total, groups)
  t.is(r.groups.length, 10)
  t.is(r.groupsTruncated, undefined)
})

test('capGroups > caps and annotates when groups exceed the budget, keeping the top-ranked', t => {
  // Fat payload per group forces truncation well under 30k chars.
  const groups = Array.from({ length: 5000 }, (_, i) => ({ zone: `zone-${i}`, blob: 'x'.repeat(200), loads: 5000 - i }))
  const r = capGroups(base, total, groups)
  t.not(r.groupsTruncated, undefined)
  t.is(r.groupsTruncated.total, 5000)
  t.is(r.groups.length, r.groupsTruncated.returned)
  t.true(r.groups.length < 5000)
  // The serialized result stays under the guard.
  t.true(JSON.stringify({ ...base, total, groups: r.groups }).length < 30_000)
  // Top-ranked group (input is pre-sorted desc) survives.
  t.is((r.groups[0]).zone, 'zone-0')
})
