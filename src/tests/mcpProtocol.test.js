import test from 'ava'
import esmock from 'esmock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The one thing nothing else in the suite covers: the actual MCP protocol over the
// actual transport wiring. The contract suite deliberately excludes /mcp (it needs
// live transports), so before this file a break in Phase 3's transport plumbing
// would have gone unnoticed by 281 green tests.

/** A real server on an OS-assigned port, with only the auth seam stubbed. */
async function startServer () {
  const { start } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async (h) => (h ? 'lincx-test-session' : null),
      bindMcpToLincxSession: async () => {},
      resolveLincxSession: async () => 'lincx-test-session',
      validateSession: async () => ({
        valid: true,
        session: { session_id: 'lincx-test-session', email: 'a@b.c', active_network: 'svce6t', networks: [] }
      })
    }
  })
  return start({ port: 0 })
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
  t.truthy(transport.sessionId, 'the server must mint an mcp-session-id')

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

test.serial('MCP > a stale session id gets -32000, not a silent new session', async t => {
  const { server, port } = await startServer()
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      'mcp-session-id': 'does-not-exist'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  t.is(r.status, 400)
  const body = await r.json()
  t.is(body.error.code, -32000)
  await close(server)
})

test.serial('MCP > GET and DELETE do not hang waiting for a body', async t => {
  // Regression guard: blanket-wrapping every route in a body reader would make
  // these two never resolve — GET /mcp is the SSE stream and neither carries a
  // body. The bodyless methods must answer immediately.
  const { server, port } = await startServer()
  for (const method of ['GET', 'DELETE']) {
    const r = await Promise.race([
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: { authorization: 'Bearer test-token', 'mcp-session-id': 'nope' }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} hung`)), 3000))
    ])
    t.is(r.status, 404, `${method} with an unknown session should 404`)
  }
  await close(server)
})
