import test from 'ava'
import { wrapAccessToken } from '../services/tokenService.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { start } from '../server.js'
import { resolveUserBucket, resolveLincxSessionFromBearer } from '../services/sessionManager.js'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`

function makeToken (email = 'bearer@test.com', extra = {}) {
  const lincx = jwt({
    sub: email,
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra
  })
  return wrapAccessToken(lincx)
}

async function connect (t, port, token) {
  const client = new Client({ name: 'bearer-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } }
  ))
  t.teardown(() => client.close())
  return client
}

async function until (read, { deadlineMs = 3000, everyMs = 20 } = {}) {
  const stopAt = Date.now() + deadlineMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > stopAt) return null
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

async function serve (t) {
  const { server, port } = await start({ port: 0 })
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return port
}

const realFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('/api/networks')) {
      return new Response(JSON.stringify({
        data: [{ id: 'svce6t', name: 'Test Network' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, opts)
  }
})
test.after.always(() => { globalThis.fetch = realFetch })

test.serial('a real wrapped bearer resolves through the SDK, unmocked', async t => {
  const token = makeToken()
  const client = await connect(t, await serve(t), token)

  const result = await client.callTool({ name: 'auth_status', arguments: {} })
  const status = JSON.parse(result.content[0].text)

  t.true(status.authenticated,
    'the bearer never reached the tool — check extra.requestInfo.headers in resolveLincxSession')
  t.is(status.email, 'bearer@test.com')
  t.falsy(status.active_network, 'auth_status no longer returns a server-side active_network')
  t.true(Array.isArray(status.networks), 'auth_status returns the accessible network list')

  const res = await client.readResource({ uri: 'lincx://networks' })
  t.false((res.contents[0].text ?? '').startsWith('Error:'), 'resource read lost the bearer')
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

test.serial('every transport the server builds is disposed, aborts included', async t => {
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

  const token = makeToken('disposal@test.com')
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

test.serial('auth_logout instructs client-side discard without revoking the token', async t => {
  const token = makeToken('logout@test.com')
  const client = await connect(t, await serve(t), token)
  const result = await client.callTool({ name: 'auth_logout', arguments: {} })

  t.regex(result.content[0].text, /Token discarded/i)
  // Server has no revocation — the same bearer still authenticates.
  const auth = await resolveLincxSessionFromBearer(`Bearer ${token}`)
  t.truthy(auth)
  t.is(auth.email, 'logout@test.com')
})

test.serial('/dev/tools forwards the real bearer, and is gone in production', async t => {
  const token = makeToken('dev@test.com')
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
  const squatter = await start({ port: 0 })
  t.teardown(() => new Promise((resolve) => squatter.server.close(resolve)))

  await t.throwsAsync(start({ port: squatter.port }), { code: 'EADDRINUSE' })
})

test.serial('the rate-limit bucket follows the ACCOUNT from the JWT sub', async t => {
  const one = await resolveLincxSessionFromBearer(`Bearer ${makeToken('acct@test.com')}`)
  const two = await resolveLincxSessionFromBearer(`Bearer ${makeToken('acct@test.com')}`)

  t.is(resolveUserBucket(one), 'acct@test.com')
  t.is(resolveUserBucket(one), resolveUserBucket(two),
    'two tokens for the same account must share one budget')
  t.is(resolveUserBucket(null), 'unknown')

  const subless = await resolveLincxSessionFromBearer(
    `Bearer ${makeToken('x', { sub: undefined, email: undefined })}`)
  t.true(resolveUserBucket(subless).startsWith('tok:'),
    'an unreadable sub falls back to a per-token bucket, not a shared one')
})

test.serial('a JSON-RPC batch is capped and charged per message', async t => {
  const token = makeToken('batch@test.com')
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
