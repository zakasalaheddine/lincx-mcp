import { describe, it, expect, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mockWorkApi } from './helpers/mockWorkApi.js'

const api = mockWorkApi()

// Import AFTER the helper so vi.mock has hoisted before module resolution.
const { registerReportingTools } = await import('../tools/reportingTools.js')

function getReportTool () {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerReportingTools(server)
  return (server)._registeredTools.report_query
}

const ROWS = [
  { zone: 'A', date: '2026-05-19', hour: '00', loads: 100, revenue: 1.5, level: 'x' },
  { zone: 'A', date: '2026-05-19', hour: '01', loads: 50, revenue: 0.5, level: 'x' },
  { zone: 'B', date: '2026-05-19', hour: '00', loads: 20, revenue: 0.1, level: 'x' }
]

beforeEach(() => api.reset())

describe('report_query structured output (T2-2)', () => {
  it('aggregated mode: structuredContent matches the declared outputSchema and mirrors content text', async () => {
    api.on('GET', /^\/api\/reports\/ds1$/, () => ROWS)
    const tool = getReportTool()

    const r = await tool.handler(
      { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', groupBy: ['zone'], raw: false },
      { sessionId: 'test-session' }
    )

    expect(r.structuredContent).toBeDefined()
    expect(r.structuredContent.total.loads).toBe(170)
    expect(r.structuredContent.groups).toHaveLength(2)
    // content text is functionally equivalent (spec back-compat requirement).
    expect(JSON.parse(r.content[0].text).total.loads).toBe(170)
    // The SDK validates structuredContent against tool.outputSchema before sending —
    // assert that contract holds here.
    expect(tool.outputSchema.safeParse(r.structuredContent).success).toBe(true)
  })

  it('raw mode: structuredContent carries raw rows and still validates against outputSchema', async () => {
    api.on('GET', /^\/api\/reports\/ds1$/, () => ROWS)
    const tool = getReportTool()

    const r = await tool.handler(
      { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', raw: true },
      { sessionId: 'test-session' }
    )

    expect(r.structuredContent.raw).toHaveLength(3)
    expect(r.structuredContent.total).toBeUndefined()
    expect(r.structuredContent.rawTruncated).toBeUndefined() // small → not capped
    expect(tool.outputSchema.safeParse(r.structuredContent).success).toBe(true)
  })

  it('raw mode caps rows so the whole result stays under the 30k size guard', async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      zone: `Zone-${i}`, date: '2026-05-19', hour: '00', loads: i, clicks: i % 7, revenue: i * 0.013, level: 'date-hour-zone'
    }))
    api.on('GET', /^\/api\/reports\/ds1$/, () => many)
    const tool = getReportTool()

    const r = await tool.handler(
      { dimensionSetId: 'ds1', startDate: '2026-05-19', endDate: '2026-05-19', raw: true },
      { sessionId: 'test-session' }
    )

    expect(r.structuredContent.raw.length).toBeLessThan(5_000)
    expect(r.structuredContent.rowsScanned).toBe(5_000)
    expect(r.structuredContent.rawTruncated.total).toBe(5_000)
    expect(r.structuredContent.rawTruncated.returned).toBe(r.structuredContent.raw.length)
    // The whole serialized result (content + structuredContent) must clear the hard guard.
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(30_000)
    expect(tool.outputSchema.safeParse(r.structuredContent).success).toBe(true)
  })
})
