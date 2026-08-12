import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import { classifyResult, getEventSink, recordEventAsync, computeStats } from '../services/usageAnalytics.js'
import { getSessionStore } from '../services/sessionStore.js'
import { bindMcpToLincxSession } from '../services/sessionManager.js'

{ // classifyResult
  test.serial('classifyResult > marks a normal result ok', t => {
    t.deepEqual(classifyResult({ content: [{ type: 'text', text: '{"id":"1"}' }] }), { status: 'ok' })
  })

  test.serial('classifyResult > detects a returned Error: text result (not just thrown / isError)', t => {
    const r = classifyResult({ content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] })
    t.is(r.status, 'error')
    t.is(r.error_kind, 'not_authenticated')
  })

  test.serial('classifyResult > classifies the oversized guard result via isError + body', t => {
    const r = classifyResult({ isError: true, content: [{ type: 'text', text: '{"error":"response_too_large","size":40000}' }] })
    t.deepEqual(r, { status: 'error', error_kind: 'response_too_large' })
  })

  test.serial('classifyResult > maps known Work API error prefixes', t => {
    t.is(classifyResult({ content: [{ type: 'text', text: "Error: Your Lincx session has expired. Use 'auth_login'." }] }).error_kind, 'auth_expired')
    t.is(classifyResult({ content: [{ type: 'text', text: 'Error: Bad request — must have property' }] }).error_kind, 'bad_params')
    t.is(classifyResult({ content: [{ type: 'text', text: 'Error: Resource not found. Double-check the ID.' }] }).error_kind, 'work_api_4xx')
    t.is(classifyResult({ content: [{ type: 'text', text: 'Error: Work API server error. Try again later.' }] }).error_kind, 'work_api_5xx')
    t.is(classifyResult({ content: [{ type: 'text', text: 'Error: Request timed out.' }] }).error_kind, 'timeout')
    t.is(classifyResult({ content: [{ type: 'text', text: 'Error: something weird' }] }).error_kind, 'other')
  })
}

const ev = (over = {}) => ({
  ts: Date.now(),
  type: 'tool',
  name: 'list_zones',
  status: 'ok',
  duration_ms: 5,
  response_chars: 100,
  params_keys: [],
  ...over
})

{ // EventSink (in-memory)
  test.serial('EventSink (in-memory) > returns most-recent-first and evicts beyond the cap', async t => {
    const sink = await getEventSink()
    for (let i = 0; i < 5; i++) await sink.append(ev({ name: `t${i}` }))
    const recent = await sink.readRecent(3)
    t.is(recent.length, 3)
    t.is(recent[0].name, 't4') // newest first
  })
}

{ // recordEventAsync
  test.serial('recordEventAsync > resolves and attaches the real user from the mcp session id', async t => {
    const session = {
      session_id: 'lincx-rec',
      user_id: 'u@x.com',
      email: 'u@x.com',
      auth_token: 't',
      networks: [{ id: 'n1', name: 'N' }],
      active_network: 'n1'
    }
    await (await getSessionStore()).set('lincx-rec', session)
    await bindMcpToLincxSession('mcp-rec', 'lincx-rec')

    await recordEventAsync({
      type: 'tool',
      name: 'get_zone',
      status: 'ok',
      duration_ms: 3,
      response_chars: 50,
      params_keys: ['id'],
      mcp_session_id: 'mcp-rec'
    })

    const recent = await (await getEventSink()).readRecent(1)
    t.is(recent[0].name, 'get_zone')
    t.is(recent[0].user_id, 'u@x.com')
    t.is(recent[0].email, 'u@x.com')
  })

  test.serial('recordEventAsync > never throws when the session can\'t be resolved', async t => {
    t.is(await recordEventAsync({
      type: 'tool',
      name: 'list_ads',
      status: 'ok',
      duration_ms: 1,
      response_chars: 10,
      params_keys: [],
      mcp_session_id: 'missing'
    }), undefined)
  })
}

{ // computeStats
  const base = { duration_ms: 10, response_chars: 100, params_keys: [] }
  const events = [
    { ts: 100, type: 'tool', name: 'list_zones', status: 'ok', user_id: 'a', email: 'a@x', mcp_session_id: 's1', ...base },
    { ts: 200, type: 'tool', name: 'get_zone', status: 'ok', user_id: 'a', email: 'a@x', mcp_session_id: 's1', ...base },
    { ts: 300, type: 'tool', name: 'report_query', status: 'error', error_kind: 'auth_expired', user_id: 'b', email: 'b@x', mcp_session_id: 's2', ...base }
  ]

  test.serial('computeStats > aggregates tool health, users, errors, and sequences', t => {
    const s = computeStats(events)

    const lz = s.tools.find((t) => t.name === 'list_zones')
    t.is(lz.calls, 1)
    t.is(lz.error_rate, 0)

    const rq = s.tools.find((t) => t.name === 'report_query')
    t.is(rq.errors, 1)
    t.is(rq.error_rate, 1)

    t.is(s.users.find((u) => u.user_id === 'a').distinct_tools, 2)
    t.is(s.errors.find((e) => e.kind === 'auth_expired').count, 1)
    t.is(s.sequences.transitions['list_zones>get_zone'], 1)
    t.is(s.window.events, 3)
  })
}
