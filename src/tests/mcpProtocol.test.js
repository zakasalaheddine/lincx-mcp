import test from 'ava'
import esmock from 'esmock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The one thing nothing else in the suite covers: the actual MCP protocol over the
// actual transport wiring. The contract suite deliberately excludes /mcp (it needs
// live transports), so before this file a break in Phase 3's transport plumbing
// would have gone unnoticed by 281 green tests.

/** A real server on an OS-assigned port, with only the auth seam stubbed. */
async function startServer (port = 0) {
  const { start } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async (h) => (h ? 'lincx-test-session' : null),
      resolveLincxSession: async () => 'lincx-test-session',
      cachedLincxSession: () => 'lincx-test-session',
      validateSession: async () => ({
        valid: true,
        session: { session_id: 'lincx-test-session', email: 'a@b.c', active_network: 'svce6t', networks: [] }
      })
    }
  })
  return start({ port })
}

const close = (server) => new Promise((resolve) => server.close(resolve))

test.serial('esmock merges partial mocks with the original module', async t => {
  // startServer() mocks four sessionManager exports; routes/login.js imports a
  // fifth (createSession). If esmock replaced instead of merged, every test below
  // would fail deep inside the SDK with an unhelpful error — so assert the
  // assumption directly.
  const mod = await esmock('../services/sessionManager.js', {}, {
    '../services/networkService.js': { fetchUserNetworks: async () => [] }
  })
  t.is(typeof mod.createSession, 'function',
    'esmock replaced instead of merged — every mock must then define every export')
})

test.serial('MCP > initialize, tools/list, tools/call, DELETE', async t => {
  const { server, port } = await startServer()
  const url = new URL(`http://127.0.0.1:${port}/mcp`)

  const client = new Client({ name: 'contract-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: 'Bearer test-token' } }
  })

  await client.connect(transport)
  t.is(transport.sessionId, undefined,
    'stateless: the server must NOT mint an mcp-session-id — nothing to lose on restart')

  const { tools } = await client.listTools()
  t.true(tools.length > 30, `expected the full tool surface, got ${tools.length}`)

  const names = tools.map((x) => x.name)
  for (const required of ['auth_status', 'network_list', 'list_zones', 'report_query']) {
    t.true(names.includes(required), `missing tool ${required}`)
  }

  // Every tool schema must reject networkId — the multi-tenancy invariant. Network
  // context comes from session.active_network inside workApiRequest(), never from
  // the model.
  for (const tool of tools) {
    t.false(
      Object.keys(tool.inputSchema?.properties ?? {}).includes('networkId'),
      `${tool.name} must not accept networkId`
    )
  }

  const result = await client.callTool({ name: 'auth_status', arguments: {} })
  t.true(Array.isArray(result.content))
  t.is(result.content[0].type, 'text')

  await transport.terminateSession()
  await client.close()
  await close(server)
})

test.serial('MCP > POST without a bearer token is 401 with the RFC-9728 challenge', async t => {
  const { server, port } = await startServer()
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  })
  t.is(r.status, 401)
  t.regex(r.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/)
  await close(server)
})

test.serial('MCP > a stale session id is ignored, not rejected', async t => {
  // The whole point of going stateless: a client still holding an id from a
  // previous (stateful) connection, or from before a restart, is served normally
  // instead of being told to re-initialize.
  const { server, port } = await startServer()
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token',
      'mcp-session-id': 'does-not-exist'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  t.is(r.status, 200)
  const body = await r.json()
  t.falsy(body.error)
  t.true(body.result.tools.length > 30)
  t.is(r.headers.get('mcp-session-id'), null, 'no session id is ever handed out')
  await close(server)
})

test.serial('MCP > GET and DELETE are both 405, and neither hangs', async t => {
  // Neither method is registered, so the router answers 405 — the one status the
  // SDK client explicitly tolerates on both (client/streamableHttp.js).
  //
  // 405 on DELETE is also the honest answer: the spec's "server does not allow
  // clients to terminate sessions", which is now literally true. An earlier cut
  // of this branch answered 200, which was worse than either — a success status
  // on a security operation that revoked nothing while the OAuth token and Lincx
  // session both stayed valid. Logging out is auth_logout.
  //
  // The Promise.race is the original regression guard: blanket-wrapping every
  // route in a body reader would make these two never resolve.
  const { server, port } = await startServer()
  const call = (method) => Promise.race([
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: { authorization: 'Bearer test-token', 'mcp-session-id': 'nope' }
    }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${method} hung`)), 3000))
  ])

  t.is((await call('DELETE')).status, 405)
  t.is((await call('GET')).status, 405)
  await close(server)
})

test.serial('MCP > a client survives a full server restart mid-session', async t => {
  // The whole reason the transport went stateless, asserted end to end: the same
  // connected client keeps working after the process serving it is replaced.
  // Under the old stateful transport the second listTools() below failed with
  // -32000 "unknown or missing MCP session ID".
  const first = await startServer()
  const url = new URL(`http://127.0.0.1:${first.port}/mcp`)

  const client = new Client({ name: 'restart-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: 'Bearer test-token' } }
  }))
  t.true((await client.listTools()).tools.length > 30)

  // Redeploy: tear the server down and stand a fresh one up on the same port.
  await close(first.server)
  const second = await startServer(first.port)

  t.true((await client.listTools()).tools.length > 30, 'restart must be invisible to the client')

  await client.close()
  await close(second.server)
})
