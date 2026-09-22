import test from 'ava'
import esmock from 'esmock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The field symptom (#72) was invisible to every in-process test: the SDK's
// validateToolOutput runs on the SERVER side of a real tools/call, so a unit test
// that inspects the handler's return value passes while the client sees only
// `MCP error -32602: Output validation error: ...`. These go over the real
// transport, the only place the defect was observable.

/** A real server on an OS-assigned port, with the auth seam and the Work API stubbed. */
async function startServer (workApiRequest) {
  const { start } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async (h) => (h ? { auth_token: 't', email: 'a@b.c', user_id: 'a@b.c' } : null),
      resolveLincxSession: async () => ({ auth_token: 't', email: 'a@b.c', user_id: 'a@b.c' }),
      resolveUserBucket: (auth) => auth?.user_id ?? 'unknown',
      validateSession: async () => ({ valid: true, session: { auth_token: 't', email: 'a@b.c', networks: [] } })
    },
    '../services/workApi.js': { workApiRequest }
  })
  return start({ port: 0 })
}

const close = (server) => new Promise((resolve) => server.close(resolve))

async function connect (port) {
  const client = new Client({ name: 'error-surface-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer test-token' } }
  }))
  return client
}

const REPORT_ARGS = {
  network_id: 'xvret6',
  dimensionSetId: 'xvret6-ohcdkn',
  startDate: '2026-09-10',
  endDate: '2026-09-12'
}

// Field case 1: a set that does not carry `hour`, queried with a non-UTC timezone.
// The guard refuses correctly — the bug was that the refusal never reached the user.
test.serial('report_query error surfacing (#72) > the hour-less timezone refusal reaches the client as its message', async t => {
  const { server, port } = await startServer(async (_s, _m, path) => {
    if (path.startsWith('/api/dimension-sets/')) return { data: { dimensions: ['zone', 'date'] } }
    throw new Error('the report must never be fetched — the pre-flight refuses first')
  })
  const client = await connect(port)
  // Without teardown the listener outlives a failed assertion and ava reports a
  // timeout instead of the assertion.
  t.teardown(async () => { await client.close(); await close(server) })

  const r = await client.callTool({ name: 'report_query', arguments: { ...REPORT_ARGS, timezone: 'America/Denver' } })

  t.is(r.isError, true)
  t.regex(r.content[0].text, /missing \[hour\]/)
  t.regex(r.content[0].text, /'hour' is required for timezone 'America\/Denver'/)
  t.notRegex(r.content[0].text, /no structured content was provided/)
})

// Field case 2: a nonexistent set id with NO timezone — proves the defect was never
// specific to the timezone guard. `get_dimension_set` already answered cleanly here;
// `report_query` must now match it.
test.serial('report_query error surfacing (#72) > an upstream 404 reaches the client as its message, matching get_dimension_set', async t => {
  // workApiRequest rethrows upstream failures with `status`/`data` hoisted onto the
  // Error (see services/workApi.js) — handleWorkApiError reads those, not `response`.
  const notFound = () => Object.assign(new Error('Request failed with status code 404'), {
    status: 404,
    data: { message: 'Not found' }
  })
  const { server, port } = await startServer(async () => { throw notFound() })
  const client = await connect(port)
  t.teardown(async () => { await client.close(); await close(server) })

  const r = await client.callTool({ name: 'report_query', arguments: { ...REPORT_ARGS, dimensionSetId: 'xvret6-zzzzzz' } })
  const g = await client.callTool({ name: 'get_dimension_set', arguments: { network_id: 'xvret6', id: 'xvret6-zzzzzz' } })

  t.is(r.isError, true)
  t.notRegex(r.content[0].text, /no structured content was provided/)
  t.regex(r.content[0].text, /not found/i)
  // The whole point of the report: the two tools now say the same thing about the
  // same bad id, instead of one explaining and the other throwing a schema violation.
  t.is(r.content[0].text, g.content[0].text)
})

// The fix must not touch the success path: a real payload still validates against
// report_query's outputSchema and still arrives with isError unset.
test.serial('report_query error surfacing (#72) > a successful report is unaffected', async t => {
  const { server, port } = await startServer(async (_s, _m, path) => {
    if (path.startsWith('/api/dimension-sets/')) return { data: { dimensions: ['zone', 'hour'] } }
    return [{ date: '2026-09-11', hour: 12, zone: 'Primary', revenue: 1.5, loads: 2 }]
  })
  const client = await connect(port)
  t.teardown(async () => { await client.close(); await close(server) })

  const r = await client.callTool({ name: 'report_query', arguments: { ...REPORT_ARGS, groupBy: ['zone'] } })

  t.is(r.isError, undefined)
  t.is(r.structuredContent.dimensionSet, 'xvret6-ohcdkn')
  t.is(r.structuredContent.total.revenue, 1.5)
})

// Review follow-up: a filter that matches nothing is a correct ZERO, not a failure.
// It used to return a bare message, which for a schema'd tool the guard must flag
// isError — so "rows exist, none match" read as a failed call while "no rows at all
// upstream" read as a success. Same answer, two verdicts. Both are pinned here.
test.serial('report_query error surfacing (#72) > a zero-match filter is a success, same as no rows upstream', async t => {
  const row = (zone) => ({ date: '2026-09-11', hour: 12, zone, advertiser: 'Other', revenue: 1.5, loads: 2 })
  const { server, port } = await startServer(async (_s, _m, path) => {
    if (path.startsWith('/api/dimension-sets/')) return { data: { dimensions: ['zone', 'hour', 'advertiser'] } }
    return [row('Primary'), row('Secondary')]
  })
  const client = await connect(port)
  t.teardown(async () => { await client.close(); await close(server) })

  const matched = await client.callTool({
    name: 'report_query',
    arguments: { ...REPORT_ARGS, filter: { advertiser: 'Acme' } }
  })

  t.is(matched.isError, undefined)
  t.is(matched.structuredContent.rowsScanned, 0)
  t.is(matched.structuredContent.rowsFetched, 2)
  t.deepEqual(matched.structuredContent.total, {})
  // Hosts feed only `content` to the model, so the hint has to be in the text.
  t.regex(matched.content[0].text, /No rows matched filter/)
  t.regex(matched.content[0].text, /Values present in range/)

  // The other half of the reported pair: nothing upstream at all. Same verdict.
  const { server: empty, port: emptyPort } = await startServer(async (_s, _m, path) => {
    if (path.startsWith('/api/dimension-sets/')) return { data: { dimensions: ['zone', 'hour', 'advertiser'] } }
    return []
  })
  const emptyClient = await connect(emptyPort)
  t.teardown(async () => { await emptyClient.close(); await close(empty) })

  const none = await emptyClient.callTool({
    name: 'report_query',
    arguments: { ...REPORT_ARGS, filter: { advertiser: 'Acme' } }
  })

  t.is(none.isError, matched.isError)
  t.is(none.structuredContent.rowsScanned, 0)
})

// Raw mode carries the same note — it builds its own header instead of stringifying
// the structured object, so a note added only to structuredContent would vanish.
test.serial('report_query error surfacing (#72) > raw mode carries the zero-match note in its text', async t => {
  const { server, port } = await startServer(async (_s, _m, path) => {
    if (path.startsWith('/api/dimension-sets/')) return { data: { dimensions: ['zone', 'hour', 'advertiser'] } }
    return [{ date: '2026-09-11', hour: 12, zone: 'Primary', advertiser: 'Other', revenue: 1.5, loads: 2 }]
  })
  const client = await connect(port)
  t.teardown(async () => { await client.close(); await close(server) })

  const r = await client.callTool({
    name: 'report_query',
    arguments: { ...REPORT_ARGS, filter: { advertiser: 'Acme' }, raw: true }
  })

  t.is(r.isError, undefined)
  t.regex(r.content[0].text, /No rows matched filter/)
  t.is(r.structuredContent.raw.length, 0)
})
