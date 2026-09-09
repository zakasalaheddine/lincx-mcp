import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sessionMock } from './helpers/mockWorkApi.js'

// Regression: get_event_stats_keys must pass the caller's network_id through
// to workApiRequest as options.networkId. Before the fix the handler discarded
// the validated network_id, so every call hit the NO_NETWORK guard and failed
// before reaching the Work API.

async function getEventStatsKeysTool (captured) {
  const { registerReportingTools } = await esmock('../tools/reportingTools.js', {
    '../services/workApi.js': {
      workApiRequest: async (_session, _method, path, opts) => {
        captured.path = path
        captured.networkId = opts?.networkId
        return { data: [] }
      },
      handleWorkApiError: (err) => `Error: ${err.message}`,
      truncateIfNeeded: (s) => s,
      buildListEnvelope: (d) => d,
      listEnvelopeToText: (s) => s
    },
    '../services/sessionManager.js': sessionMock()
  })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerReportingTools(server)
  return server._registeredTools.get_event_stats_keys
}

test('get_event_stats_keys > passes network_id to workApiRequest as networkId', async t => {
  const captured = {}
  const tool = await getEventStatsKeysTool(captured)

  await tool.handler({ network_id: 'svce6t' }, { sessionId: 'test-session' })

  t.is(captured.path, '/api/event-stats')
  t.is(captured.networkId, 'svce6t',
    'network_id must reach workApiRequest — a discarded value fails the NO_NETWORK guard')
})
