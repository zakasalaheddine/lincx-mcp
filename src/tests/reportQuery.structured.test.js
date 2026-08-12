import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'

const ROWS = [
  { zone: 'A', date: '2026-05-19', hour: '00', loads: 100, revenue: 1.5, level: 'x' },
  { zone: 'A', date: '2026-05-19', hour: '01', loads: 50, revenue: 0.5, level: 'x' },
  { zone: 'B', date: '2026-05-19', hour: '00', loads: 20, revenue: 0.1, level: 'x' }
]

/** Fresh module graph per test, so the row set is per-test state, not shared. */
async function getReportTool (rows) {
  const { registerReportingTools } = await esmock('../tools/reportingTools.js', {
    '../services/workApi.js': workApiMock([
      ['GET', /^\/api\/reports\/ds1$/, () => rows]
    ]),
    '../services/sessionManager.js': sessionMock()
  })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerReportingTools(server)
  return (server)._registeredTools.report_query
}

test('report_query structured output (T2-2) > aggregated mode: structuredContent matches the declared outputSchema and mirrors content text', async t => {
  const tool = await getReportTool(ROWS)

  const r = await tool.handler(
    { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', groupBy: ['zone'], raw: false },
    { sessionId: 'test-session' }
  )

  t.not(r.structuredContent, undefined)
  t.is(r.structuredContent.total.loads, 170)
  t.is(r.structuredContent.groups.length, 2)
  // content text is functionally equivalent (spec back-compat requirement).
  t.is(JSON.parse(r.content[0].text).total.loads, 170)
  // The SDK validates structuredContent against tool.outputSchema before sending —
  // assert that contract holds here.
  t.is(tool.outputSchema.safeParse(r.structuredContent).success, true)
})

test('report_query structured output (T2-2) > raw mode: structuredContent carries raw rows and still validates against outputSchema', async t => {
  const tool = await getReportTool(ROWS)

  const r = await tool.handler(
    { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', raw: true },
    { sessionId: 'test-session' }
  )

  t.is(r.structuredContent.raw.length, 3)
  t.is(r.structuredContent.total, undefined)
  t.is(r.structuredContent.rawTruncated, undefined) // small → not capped
  t.is(tool.outputSchema.safeParse(r.structuredContent).success, true)
})

test('report_query structured output (T2-2) > raw mode caps rows so the whole result stays under the 30k size guard', async t => {
  const many = Array.from({ length: 5_000 }, (_, i) => ({
    zone: `Zone-${i}`, date: '2026-05-19', hour: '00', loads: i, clicks: i % 7, revenue: i * 0.013, level: 'date-hour-zone'
  }))
  const tool = await getReportTool(many)

  const r = await tool.handler(
    { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', raw: true },
    { sessionId: 'test-session' }
  )

  t.true(r.structuredContent.raw.length < 5_000)
  t.is(r.structuredContent.rowsScanned, 5_000)
  t.is(r.structuredContent.rawTruncated.total, 5_000)
  t.is(r.structuredContent.rawTruncated.returned, r.structuredContent.raw.length)
  // The whole serialized result (content + structuredContent) must clear the hard guard.
  t.true(JSON.stringify(r).length <= 30_000)
  t.is(tool.outputSchema.safeParse(r.structuredContent).success, true)
})
