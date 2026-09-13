import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'
import { missingDimensions, isValidHour, isUtcZone } from '../tools/reportingTools.js'

// One row per UTC day, no hour — what upstream returns for a set without 'hour'.
const DAILY = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'].map((date, i) => ({
  date, zone: 'NSD', loads: 100 + i, revenue: i + 1
}))
const HOURLY = [
  { date: '2026-09-02', hour: '03', zone: 'NSD', loads: 10, revenue: 1 }, // 09-01 21:00 Denver
  { date: '2026-09-02', hour: '12', zone: 'NSD', loads: 20, revenue: 2 } // 09-02 06:00 Denver
]

/**
 * report_query with a mocked Work API. `dims` is the set's dimensions array, or a
 * function to throw from the lookup. `calls` records every path hit.
 */
async function getReportTool ({ dims, rows }) {
  const calls = []
  const { registerReportingTools } = await esmock('../tools/reportingTools.js', {
    '../services/workApi.js': workApiMock([
      ['GET', /^\/api\/dimension-sets\/ds1$/, () => {
        calls.push('dimension-set')
        if (dims instanceof Error) throw dims
        return { data: { id: 'ds1', dimensions: dims } }
      }],
      ['GET', /^\/api\/reports\/ds1$/, () => { calls.push('report'); return rows }]
    ]),
    '../services/sessionManager.js': sessionMock()
  })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerReportingTools(server)
  return { tool: server._registeredTools.report_query, calls }
}

const run = (tool, args) => tool.handler(
  { dimensionSetId: 'ds1', startDate: '2026-09-01', endDate: '2026-09-02', raw: false, ...args },
  { sessionId: 'test-session' }
)

test('pre-flight > timezone on a set without hour errors and skips the report fetch', async t => {
  const { tool, calls } = await getReportTool({ dims: ['date', 'zone', 'device'], rows: DAILY })
  const r = await run(tool, { groupBy: ['date'], timezone: 'America/Denver' })
  t.regex(r.content[0].text, /^Error: dimension set ds1 is missing \[hour\]\. 'hour' is required for timezone 'America\/Denver'/)
  t.is(r.structuredContent, undefined)
  t.deepEqual(calls, ['dimension-set'])
})

test('pre-flight > groupBy and filter keys missing from the set are named', async t => {
  const { tool, calls } = await getReportTool({ dims: ['date', 'hour', 'zone'], rows: HOURLY })
  const r = await run(tool, { groupBy: ['advertiser'], filter: { campaign: 'X' } })
  t.regex(r.content[0].text, /missing \[advertiser, campaign\]\. Add them/)
  t.notRegex(r.content[0].text, /timezone/)
  t.deepEqual(calls, ['dimension-set'])
})

test('pre-flight > UTC or omitted timezone on an hour-less set runs normally', async t => {
  for (const timezone of [undefined, 'UTC', 'Etc/UTC']) {
    const { tool } = await getReportTool({ dims: ['date', 'zone'], rows: DAILY })
    const r = await run(tool, { groupBy: ['date'], timezone })
    t.truthy(r.structuredContent, `timezone=${timezone}`)
    // Labels unshifted: each date still carries its own UTC day's loads.
    const loadsByDate = Object.fromEntries(DAILY.map((row) => [row.date, row.loads]))
    for (const g of r.structuredContent.groups) t.is(g.loads, loadsByDate[g.date], `timezone=${timezone} ${g.date}`)
  }
})

test('fallback > dimension-set lookup fails and rows have no hour → error, not shifted dates', async t => {
  const { tool, calls } = await getReportTool({ dims: new Error('boom'), rows: DAILY })
  const r = await run(tool, { groupBy: ['date'], timezone: 'America/Denver' })
  t.regex(r.content[0].text, /^Error: dimension set ds1 returned daily rows with no hour/)
  t.deepEqual(calls, ['dimension-set', 'report'])
})

test('fallback > set claims hour but rows come back daily → error', async t => {
  const { tool } = await getReportTool({ dims: ['date', 'hour', 'zone'], rows: DAILY })
  const r = await run(tool, { groupBy: ['date', 'hour'], timezone: 'America/Denver' })
  t.regex(r.content[0].text, /returned daily rows with no hour/)
  t.notRegex(r.content[0].text, /"hour":"18"/)
})

test('regression > set with hour + America/Denver still rebuckets hourly rows', async t => {
  const { tool } = await getReportTool({ dims: ['date', 'hour', 'zone'], rows: HOURLY })
  const r = await run(tool, { groupBy: ['date'], timezone: 'America/Denver' })
  const byDate = Object.fromEntries(r.structuredContent.groups.map((g) => [g.date, g.loads]))
  t.deepEqual(byDate, { '2026-09-01': 10, '2026-09-02': 20 })
  t.is(tool.outputSchema.safeParse(r.structuredContent).success, true)
})

test('helpers > missingDimensions is case-insensitive; isValidHour; isUtcZone', t => {
  t.deepEqual(missingDimensions(['Date', 'Hour', 'geoRegion'], ['hour', 'georegion', 'zone']), ['zone'])
  for (const h of [0, '0', '03', 23, '23']) t.true(isValidHour(h), String(h))
  for (const h of [undefined, null, '', '24', 24, 'x', '1.5']) t.false(isValidHour(h), String(h))
  t.true(isUtcZone('GMT'))
  t.false(isUtcZone('America/Denver'))
})
