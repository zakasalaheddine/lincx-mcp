import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import { classifyResult, getEventSink, recordEventAsync, computeStats, sessionKey } from '../services/usageAnalytics.js'
import { getSessionStore } from '../services/sessionStore.js'

// classifyResult
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

// EventSink (in-memory)
test.serial('EventSink (in-memory) > returns most-recent-first and evicts beyond the cap', async t => {
  const sink = await getEventSink()
  for (let i = 0; i < 5; i++) await sink.append(ev({ name: `t${i}` }))
  const recent = await sink.readRecent(3)
  t.is(recent.length, 3)
  t.is(recent[0].name, 't4') // newest first
})

// recordEventAsync
test.serial('recordEventAsync > resolves and attaches the real user from the lincx session id', async t => {
  const session = {
    session_id: 'lincx-rec',
    user_id: 'u@x.com',
    email: 'u@x.com',
    auth_token: 't',
    networks: [{ id: 'n1', name: 'N' }],
    active_network: 'n1'
  }
  await (await getSessionStore()).set('lincx-rec', session)

  await recordEventAsync({
    type: 'tool',
    name: 'get_zone',
    status: 'ok',
    duration_ms: 3,
    response_chars: 50,
    params_keys: ['id'],
    lincx_session_id: 'lincx-rec'
  })

  const recent = await (await getEventSink()).readRecent(1)
  t.is(recent[0].name, 'get_zone')
  t.is(recent[0].user_id, 'u@x.com')
  t.is(recent[0].email, 'u@x.com')

  // The raw id is consumed to resolve the user and then dropped. It must not be
  // stored: usage:events has no TTL and lives on the same Redis instance as
  // lincx:session:<id>, which holds the JWT.
  t.is(recent[0].lincx_session_id, undefined, 'raw session id persisted into the event log')
  t.is(recent[0].session_key, sessionKey('lincx-rec'))

  // The line above is a TAUTOLOGY on its own — both sides move together under any
  // consistent change to sessionKey, so replacing the hash with the identity (or
  // with base64) passed the whole suite. This is the only non-tautological check
  // on the write surface, and the invariant it guards is the documented one:
  // usage:events has no TTL and sits on the same Redis instance as the record
  // holding the Lincx JWT.
  t.false(recent[0].session_key.includes('lincx-rec'),
    'the stored key must not contain the raw session id')
  t.false(sessionKey('lincx-rec').includes('lincx-rec'),
    'sessionKey must not contain the raw id')

  // "Does not contain the raw id" is not enough on its own: base64 satisfies it
  // and is trivially reversible (verified — that mutation passed the suite).
  // A hash has a FIXED width whatever it is given; every encoding grows with its
  // input, so this is what actually separates the two.
  t.is(sessionKey('a').length, sessionKey('a'.repeat(500)).length,
    'sessionKey must be a fixed-width digest, not a reversible encoding')
  t.regex(sessionKey('lincx-rec'), /^s:[0-9a-f]{12}$/)
  t.not(sessionKey('lincx-a'), sessionKey('lincx-b'), 'distinct sessions must not collide')
})

test.serial('recordEventAsync > never throws when the session can\'t be resolved', async t => {
  t.is(await recordEventAsync({
    type: 'tool',
    name: 'list_ads',
    status: 'ok',
    duration_ms: 1,
    response_chars: 10,
    params_keys: [],
    lincx_session_id: 'missing'
  }), undefined)
})

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

  // The transport went stateless, so new events carry session_key where old ones
  // carried mcp_session_id. Sequences must group on either, or /stats loses its
  // whole sequence section the moment the key changes.
  test.serial('computeStats > groups sequences on session_key, and still on the legacy mcp_session_id', t => {
    const s = computeStats([
      { ts: 100, type: 'tool', name: 'list_zones', status: 'ok', session_key: 'L1', ...base },
      { ts: 200, type: 'tool', name: 'get_zone', status: 'ok', session_key: 'L1', ...base },
      ...events
    ])
    t.is(s.sequences.transitions['list_zones>get_zone'], 2, 'one from each key')
  })

  // Every timestamp-derived field, in one test: these all read `event.ts`, and a
  // rename that missed one returned undefined/NaN here while every other
  // assertion above stayed green.
  test.serial('computeStats > reports real timestamps for the window, per-user span and session order', t => {
    const s = computeStats(events)

    t.is(s.window.oldest_ts, 100)
    t.is(s.window.newest_ts, 300)

    const a = s.users.find((u) => u.user_id === 'a')
    t.is(a.first_seen, 100)
    t.is(a.last_seen, 200)

    // s2's last event (300) is newer than s1's (200), so it sorts first.
    t.deepEqual(s.sequences.recent.map((r) => r.user_id), ['b', 'a'])

    // last_ts must be the row's NEWEST event. With only two events per session an
    // arr[0]/arr.at(-1) mix-up still sorts correctly, so assert the value, not
    // just the ordering it drives.
    t.is(s.sequences.recent.find((r) => r.user_id === 'a').last_ts, 200,
      'last_ts must be the latest event in the row, not the first')
    t.is(s.sequences.recent.find((r) => r.user_id === 'b').last_ts, 300)
  })

  // The /stats row shape, asserted by VALUE. Every field here was previously
  // unpinned: a fixture with two events per session cannot reach the tools cap,
  // cannot distinguish first-vs-last, and cannot see tools_total drift.
  test.serial('computeStats > row fields carry real values, and the tools list is capped', t => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      ts: 1000 + i,
      type: 'tool',
      name: `t${i}`,
      status: 'ok',
      user_id: 'heavy',
      email: 'heavy@x',
      session_key: 'L-heavy',
      ...base
    }))
    const stats = computeStats(many)
    const row = stats.sequences.recent.find((r) => r.user_id === 'heavy')

    t.is(row.tools_total, 250, 'tools_total must report the true count, not the capped one')
    t.is(row.tools.length, 200, 'the tools list must be capped')
    t.is(row.tools[0], 't50', 'the cap must keep the NEWEST calls')
    t.is(row.tools.at(-1), 't249')
    t.is(row.last_ts, 1249)

    // transitions are computed over the FULL list, not the capped one — 249
    // consecutive pairs across 250 calls.
    t.is(Object.keys(stats.sequences.transitions).length, 249)
  })

  test.serial('computeStats > never echoes a resolvable session id', t => {
    // computeStats groups on what recordEventAsync stored, which is already a
    // hash; legacy mcp_session_id events were stored RAW and must be hashed on
    // read. A row must stay distinguishable, never resolvable.
    const s = computeStats(events)
    const ids = s.sequences.recent.map((r) => r.session)
    t.false(ids.includes('s1') || ids.includes('s2'), 'raw session id leaked into /stats')
    t.is(new Set(ids).size, 2, 'distinct sessions must stay distinct rows')
  })
}
