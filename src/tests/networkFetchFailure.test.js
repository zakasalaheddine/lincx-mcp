import test from 'ava'
import esmock from 'esmock'

import { fetchUserNetworks } from '../services/networkService.js'

/**
 * fetchUserNetworks used to return [] on every failure — an upstream outage was
 * indistinguishable from an account with no networks. The contract now: the
 * service throws, and every surface turns that into an explicit error instead
 * of an empty success.
 */

const realFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = realFetch })

const stubFetch = (impl) => { globalThis.fetch = impl }

// ── the service itself ───────────────────────────────────────────────────────

test('fetchUserNetworks > throws on upstream HTTP error, not []', async t => {
  stubFetch(async () => new Response('oops', { status: 503 }))
  await t.throwsAsync(() => fetchUserNetworks('t'), { message: /HTTP 503/ })
})

test('fetchUserNetworks > throws on network failure (fetch rejects)', async t => {
  stubFetch(async () => { throw new Error('connect ECONNREFUSED') })
  await t.throwsAsync(() => fetchUserNetworks('t'), { message: /ECONNREFUSED/ })
})

test('fetchUserNetworks > abort surfaces as a timeout error', async t => {
  stubFetch(async () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    throw e
  })
  await t.throwsAsync(() => fetchUserNetworks('t'), { message: /timed out/ })
})

test('fetchUserNetworks > [] means a genuinely empty account', async t => {
  stubFetch(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }))
  t.deepEqual(await fetchUserNetworks('t'), [])
})

// ── propagation through the tools ────────────────────────────────────────────

const FAIL = 'GET /api/networks failed: HTTP 503'
const throwingFetch = async () => { throw new Error(FAIL) }

const fakeServer = () => {
  const registered = {}
  return {
    registerTool: (name, config, handler) => { registered[name] = { config, handler } },
    get: (name) => registered[name]
  }
}

const call = (server, name, args = {}) => {
  const { config, handler } = server.get(name)
  return handler(config.inputSchema.parse(args), {})
}

test('network_list > fetch failure is an error, not an empty success', async t => {
  const mod = await esmock('../tools/networkTools.js', {
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 't', email: 'u@x.com' }),
      refreshNetworks: async () => ({ session: { networks: [] } })
    },
    '../services/networkService.js': { fetchUserNetworks: throwingFetch }
  })
  const server = fakeServer()
  mod.registerNetworkTools(server)

  const res = await call(server, 'network_list')
  t.regex(res.content[0].text, /could not fetch networks.*503/)
  t.is(res.structuredContent, undefined)
})

test('network_refresh > fetch failure carries the upstream reason', async t => {
  const mod = await esmock('../tools/networkTools.js', {
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 't', email: 'u@x.com' }),
      refreshNetworks: async () => { throw new Error(FAIL) }
    },
    '../services/networkService.js': { fetchUserNetworks: throwingFetch }
  })
  const server = fakeServer()
  mod.registerNetworkTools(server)

  const res = await call(server, 'network_refresh')
  t.regex(res.content[0].text, /Could not refresh networks.*503/)
})

test('auth_status > fetch failure marks networks_error, auth stays valid', async t => {
  const mod = await esmock('../tools/authTools.js', {
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 't', email: 'u@x.com' })
    },
    '../services/networkService.js': { fetchUserNetworks: throwingFetch }
  })
  const server = fakeServer()
  mod.registerAuthTools(server)

  const res = await call(server, 'auth_status')
  const status = JSON.parse(res.content[0].text)
  t.true(status.authenticated)
  t.is(status.email, 'u@x.com')
  t.regex(status.networks_error, /503/)
  t.is(status.networks, undefined)
})
