import test from 'ava'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { start } from '../server.js'
import { getKvStore, getSessionStore } from '../services/sessionStore.js'
import { getEventSink, sessionKey } from '../services/usageAnalytics.js'
import { resolveUserBucket } from '../services/sessionManager.js'

// The one path every other test stubs out.
//
// mcpProtocol.test.js and helpers/mockWorkApi.js both mock resolveLincxSession,
// so the whole suite can go green without ever reading a bearer token off the
// request. That read — `extra.requestInfo.headers.authorization` inside
// resolveLincxSession — is what the stateless transport rests on: if the SDK
// does not hand `requestInfo` to tool handlers, every tool answers
// "Not authenticated" in production and CI never notices.
//
// So nothing is mocked here. A real OAuth access token and a real Lincx session
// are seeded into the store, a real client connects over a real transport, and
// auth_status has to find its way back to the session from the bearer alone.

/** Seed a real OAuth access token + Lincx session, the way a real login would. */
async function seed (token, lincxSessionId) {
  await (await getKvStore()).set(
    `oauth:access:${token}`,
    JSON.stringify({ lincx_session_id: lincxSessionId, client_id: 'c1' }),
    3600
  )
  await (await getSessionStore()).set(lincxSessionId, {
    session_id: lincxSessionId,
    user_id: 'bearer@test.com',
    email: 'bearer@test.com',
    auth_token: 'not-a-real-jwt',
    networks: [{ id: 'svce6t', name: 'Test Network' }],
    active_network: 'svce6t'
  })
}

/** A connected client over the real transport, carrying a real bearer. */
async function connect (t, port, token) {
  const client = new Client({ name: 'bearer-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } }
  ))
  t.teardown(() => client.close())
  return client
}

/**
 * Poll until `read()` returns something truthy, or fail at the deadline.
 *
 * recordEvent is deliberately fire-and-forget, so the alternative is a fixed
 * sleep — which flaked under full-suite CPU load on the one test guarding the
 * whole attribution chain. Polling is faster in the normal case and honest about
 * the deadline.
 */
async function until (read, { deadlineMs = 3000, everyMs = 20 } = {}) {
  const stopAt = Date.now() + deadlineMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > stopAt) return null
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/** A server that is torn down even when an assertion throws. */
async function serve (t) {
  const { server, port } = await start({ port: 0 })
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return port
}

test.serial('a real bearer resolves to a session through the SDK, unmocked', async t => {
  const token = 'test-access-token-abcdef'
  const lincxSessionId = 'lincx-bearer-test'
  await seed(token, lincxSessionId)

  const client = await connect(t, await serve(t), token)

  const result = await client.callTool({ name: 'auth_status', arguments: {} })
  const status = JSON.parse(result.content[0].text)

  t.true(status.authenticated,
    'the bearer never reached the tool — check extra.requestInfo.headers in resolveLincxSession')
  t.is(status.email, 'bearer@test.com')
  t.is(status.active_network, 'svce6t')

  // Resources take a different SDK path to the same identity read
  // (mcp.js readCallback, not executeToolHandler) and resources.test.js mocks
  // sessionManager, so this is the only place that path runs for real.
  const res = await client.readResource({ uri: 'lincx://networks' })
  t.false((res.contents[0].text ?? '').startsWith('Error:'),
    `resource read lost the bearer: ${res.contents[0].text?.slice(0, 120)}`)
})

test.serial('a bogus bearer is challenged, not silently served', async t => {
  const port = await serve(t)
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer nope-not-a-token'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  t.is(r.status, 401)
  t.regex(r.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/)
})

test.serial('a tool call attributes its usage event to the real session', async t => {
  // The producer half of analytics, which nothing else covers: usageAnalytics's
  // own tests hand `lincx_session_id` straight to recordEventAsync, and
  // mcpProtocol stubs cachedLincxSession outright — so the chain
  //   bearer → resolveLincxSession memo → cachedLincxSession → recordEvent
  // could be severed anywhere along its length with the suite fully green.
  const token = 'test-access-token-attribution'
  const lincxSessionId = 'lincx-attribution-test'
  await seed(token, lincxSessionId)

  const client = await connect(t, await serve(t), token)
  await client.callTool({ name: 'auth_status', arguments: {} })

  const sink = await getEventSink()
  const event = await until(async () => {
    const [e] = await sink.readRecent(1)
    return e?.name === 'auth_status' ? e : null
  })

  t.truthy(event, 'no usage event was recorded for the tool call')
  t.is(event.session_key, sessionKey(lincxSessionId),
    'identity never reached the usage event — check the extra memo / cachedLincxSession')
  t.is(event.email, 'bearer@test.com', 'recordEventAsync failed to resolve the user')
  t.is(event.lincx_session_id, undefined, 'raw session id persisted into the event log')
})

test.serial('a resource read is attributed too, not just a tool call', async t => {
  // Resources record through a separate path (resources.js `recorded()`) with its
  // own cachedLincxSession call sites. Both could be zeroed with the tool path
  // still green.
  const token = 'test-access-token-resource-attr'
  const lincxSessionId = 'lincx-resource-attr-test'
  await seed(token, lincxSessionId)

  const client = await connect(t, await serve(t), token)
  await client.readResource({ uri: 'lincx://networks' })

  const sink = await getEventSink()
  const event = await until(async () => {
    const [e] = await sink.readRecent(1)
    return e?.type === 'resource' ? e : null
  })

  t.truthy(event, 'no usage event was recorded for the resource read')
  t.is(event.session_key, sessionKey(lincxSessionId))
  t.is(event.email, 'bearer@test.com')
})

test.serial('every transport the server builds is disposed, aborts included', async t => {
  // The stateless design builds a fresh McpServer (40+ tool registrations) and a
  // fresh transport PER REQUEST, disposed via res.on('close') in mcpPost.
  // Deleting that block leaks both on every call and passes the whole suite.
  //
  // The invariant is CREATED === DISPOSED, not a fixed count. Counting disposals
  // alone cannot see the case that actually distinguishes 'close' from 'finish':
  // an aborted request, whose response never finishes. And an abort that never
  // reaches the server builds nothing, so a fixed expected count would fail for a
  // reason that is not a leak.
  //
  // This lives here, not in mcpProtocol.test.js: esmock gives that file an
  // isolated module graph, so patching McpServer.prototype there patches a
  // different class object than the one server.js actually constructs.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const originalConnect = McpServer.prototype.connect
  const originalClose = McpServer.prototype.close
  let created = 0
  let disposed = 0
  let stall = 0
  McpServer.prototype.connect = function (...args) {
    created++
    // `stall` opens the window the abort case needs. Without it the request
    // completes in a few ms and the abort lands before the server ever builds a
    // transport — nothing is created, so nothing can leak, and the test would
    // pass under BOTH 'close' and 'finish'. Delaying connect means the transport
    // exists while the client gives up, which is the real cancelled-tool-call
    // shape.
    if (stall === 0) return originalConnect.apply(this, args)
    const self = this
    return new Promise((resolve) => setTimeout(resolve, stall))
      .then(() => originalConnect.apply(self, args))
  }
  McpServer.prototype.close = function (...args) {
    disposed++
    return originalClose.apply(this, args)
  }
  t.teardown(() => {
    McpServer.prototype.connect = originalConnect
    McpServer.prototype.close = originalClose
  })

  const token = 'test-access-token-disposal'
  await seed(token, 'lincx-disposal-test')
  const port = await serve(t)

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

  for (let i = 0; i < 3; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body }).then((x) => x.json())
    t.falsy(r.error)
  }
  t.is(created, 3, 'each request must build its own transport + server')

  // Now abort one WHILE the server is holding a transport for it. The response
  // never finishes, so a res.on('finish') listener never fires and both the
  // transport and its 40-tool McpServer leak — the realistic shape of a
  // long-running MCP call the client cancels.
  stall = 300
  const abort = new AbortController()
  const inflight = fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers, body, signal: abort.signal
  }).catch(() => {})
  await until(() => created === 4 || null)
  abort.abort()
  await inflight
  stall = 0

  t.is(created, 4, 'the aborted request must have reached the server for this to prove anything')
  t.truthy(await until(() => disposed === created || null),
    `${created} transports built, ${disposed} disposed — an aborted request leaked its transport and McpServer`)

  // Second window, and the one that separates 'close' from 'finish'.
  //
  // The abort above is caught by mcpPost's `res.destroyed` check, because the
  // client gave up while createTransport() was still awaiting — so that case
  // passes under a 'finish' listener too. The listener itself only earns its
  // keep when the abort lands AFTER it is attached, i.e. during handleRequest:
  // a slow tool call the client cancels. Stall handleRequest to open it.
  const originalHandle = StreamableHTTPServerTransport.prototype.handleRequest
  let handleStall = 0
  StreamableHTTPServerTransport.prototype.handleRequest = function (...args) {
    if (handleStall === 0) return originalHandle.apply(this, args)
    const self = this
    return new Promise((resolve) => setTimeout(resolve, handleStall))
      .then(() => originalHandle.apply(self, args))
  }
  t.teardown(() => { StreamableHTTPServerTransport.prototype.handleRequest = originalHandle })

  handleStall = 300
  const abort2 = new AbortController()
  const inflight2 = fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers, body, signal: abort2.signal
  }).catch(() => {})
  await until(() => created === 5 || null)
  abort2.abort()
  await inflight2
  handleStall = 0

  t.is(created, 5, 'the second abort must also have built a transport')
  t.truthy(await until(() => disposed === created || null),
    `${created} built, ${disposed} disposed — a request aborted mid-handling leaked; res.on('close') is what covers this, 'finish' never fires`)
})

test.serial('auth_logout actually destroys the session server-side', async t => {
  // auth_logout had no test at all: deleting destroySession(sessionId) from it
  // passes the whole suite, leaving a "Logged out" message over a session that is
  // still fully usable. This branch touched that handler (it dropped the
  // now-dead unbindMcpSession call), so pin the half that matters.
  const token = 'test-access-token-logout'
  const lincxSessionId = 'lincx-logout-test'
  await seed(token, lincxSessionId)

  const store = await getSessionStore()
  t.truthy(await store.get(lincxSessionId), 'seed failed')

  const client = await connect(t, await serve(t), token)
  const result = await client.callTool({ name: 'auth_logout', arguments: {} })

  t.regex(result.content[0].text, /Logged out/)
  t.falsy(await store.get(lincxSessionId),
    'auth_logout reported success but the session is still live in Redis')
})

test.serial('/dev/tools forwards the real bearer, and is gone in production', async t => {
  // The dev route builds `extra` by hand — `{ requestInfo: { headers: {...} } }` —
  // so it is the one identity shape nothing else exercises. Replacing it with `{}`
  // passed the whole suite. It also USED to run tools under a shared,
  // credential-free `{ sessionId: 'stdio' }` binding, which this branch removed;
  // that is worth keeping pinned.
  const token = 'test-access-token-dev'
  await seed(token, 'lincx-dev-test')
  const port = await serve(t)

  const call = (headers) => fetch(`http://127.0.0.1:${port}/dev/tools/auth_status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}'
  }).then((r) => r.json())

  const authed = await call({ authorization: `Bearer ${token}` })
  t.true(JSON.parse(authed.content[0].text).authenticated,
    'the dev route did not forward the bearer into extra')

  const anon = await call({})
  t.false(JSON.parse(anon.content[0].text).authenticated,
    'the dev route must not grant a session without a bearer')
})

test.serial('start() rejects on a bind failure instead of killing the process', async t => {
  // The reason start() stopped calling process.exit(1): a test that binds an
  // explicit port and loses the race to a concurrently-running file would take the
  // whole ava worker down with no assertion message. That justification had no
  // test, so `reject(err)` could become `resolve(null)` with the suite green.
  const squatter = await start({ port: 0 })
  t.teardown(() => new Promise((resolve) => squatter.server.close(resolve)))

  await t.throwsAsync(start({ port: squatter.port }), { code: 'EADDRINUSE' })
})

test.serial('the rate-limit bucket follows the ACCOUNT, not the session', async t => {
  // createSession mints a fresh UUID on every login and each lives 7 days, so
  // keying the per-user limiter on the session id let one account accumulate
  // budgets: N logins bought N x 120/min, with only the 10/min login limiter as a
  // brake (~100 logins over ten minutes ≈ 12 000 req/min for one account).
  await seed('tok-acct-1', 'lincx-login-one')
  await seed('tok-acct-2', 'lincx-login-two')

  const one = await resolveUserBucket('lincx-login-one')
  const two = await resolveUserBucket('lincx-login-two')

  t.is(one, 'bearer@test.com', 'the bucket must be the account, not the session id')
  t.is(one, two, 'two logins by the same account must share one budget')
  t.not(one, 'lincx-login-one')

  // A session that no longer resolves falls back to its own id rather than
  // throwing — that request is about to fail closed inside every tool anyway.
  t.is(await resolveUserBucket('lincx-does-not-exist'), 'lincx-does-not-exist')
})

test.serial('a JSON-RPC batch is capped and charged per message', async t => {
  // One POST can carry an array and the transport runs every message in it —
  // measured at 500 tool executions from a request the limiter counted as 1. With
  // the 100kb body cap that is ~1100 messages, each costing Redis GETs and a Work
  // API call, so an uncapped batch amplifies against Redis and the Work API, not
  // just this process.
  const token = 'test-access-token-batch'
  await seed(token, 'lincx-batch-test')
  const port = await serve(t)

  const post = (payload) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  })

  const one = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })

  const ok = await post(Array.from({ length: 10 }, (_, i) => one(i)))
  t.is(ok.status, 200, 'a batch within the cap must still work')

  const tooBig = await post(Array.from({ length: 500 }, (_, i) => one(i)))
  t.is(tooBig.status, 400, 'an oversized batch must be refused, not executed')
  t.regex((await tooBig.json()).error.message, /Batch too large/)
})
