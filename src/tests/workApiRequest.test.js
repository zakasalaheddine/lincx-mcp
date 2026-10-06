import test from 'ava'

let workApiRequest

test.before(async () => {
  const mod = await import('../services/workApi.js')
  workApiRequest = mod.workApiRequest
})

test.beforeEach((t) => {
  t.context.calls = []
  t.context.originalFetch = global.fetch
  global.fetch = async (url, init) => {
    t.context.calls.push({ url: url.toString(), init })
    return { ok: true, status: 200, json: async () => ({}) }
  }
})

test.afterEach((t) => {
  global.fetch = t.context.originalFetch
})

function session () {
  return { auth_token: 't' }
}

test.serial('list GET receives networkId query param from explicit networkId', async t => {
  await workApiRequest(session(), 'GET', '/api/zones', { networkId: 'n1' })
  t.regex(t.context.calls[0].url, /\/api\/zones\?networkId=n1$/)
})

test.serial('list GET without session.active_network still requires explicit networkId', async t => {
  await t.throwsAsync(workApiRequest(session(), 'GET', '/api/zones'), { code: 'NO_NETWORK' })
  t.is(t.context.calls.length, 0)
})

test.serial('list GET without networkId fails before fetch', async t => {
  const err = await t.throwsAsync(workApiRequest(session(), 'GET', '/api/alerts'))
  t.is(err.code, 'NO_NETWORK')
  t.is(t.context.calls.length, 0)
})

test.serial('all list paths require networkId', async t => {
  for (const path of ['/api/campaigns', '/api/publishers', '/api/zones']) {
    await t.throwsAsync(workApiRequest(session(), 'GET', path), { code: 'NO_NETWORK' })
  }
  t.is(t.context.calls.length, 0)
})

test.serial('get-by-id omits networkId query param', async t => {
  await workApiRequest(session(), 'GET', '/api/zones/z1', { networkId: 'n1' })
  t.notRegex(t.context.calls[0].url, /networkId/)
})

test.serial('parents routes omit networkId query param', async t => {
  for (const base of ['/api/campaigns', '/api/ad-groups', '/api/ads', '/api/creatives', '/api/channels', '/api/sites', '/api/templates', '/api/zones']) {
    await workApiRequest(session(), 'GET', `${base}/id/parents`, { networkId: 'n1' })
    t.notRegex(t.context.calls[t.context.calls.length - 1].url, /networkId/)
  }
})

test.serial('report route omits networkId query param', async t => {
  await workApiRequest(session(), 'GET', '/api/zones/z1/report', { networkId: 'n1' })
  t.notRegex(t.context.calls[0].url, /networkId/)
})

test.serial('network endpoints omit networkId query param', async t => {
  await workApiRequest(session(), 'GET', '/api/networks', { networkId: 'n1' })
  t.notRegex(t.context.calls[0].url, /networkId/)
})

test.serial('workApiRequest serializes options.body on request', async t => {
  await workApiRequest(session(), 'POST', '/api/campaigns', { networkId: 'n1', body: { name: 'New Campaign' } })
  t.is(t.context.calls.length, 1)
  t.is(t.context.calls[0].init.method, 'POST')
  t.is(t.context.calls[0].init.body, JSON.stringify({ name: 'New Campaign' }))
})

test.serial('a create POST to a list path is not network-guarded and sends its body as-is', async t => {
  // /api/templates is a list path for GET; the old method-blind guard threw
  // NO_NETWORK on every create_template before fetch ran.
  const body = { networkId: 'n1', name: 'T', html: '<div/>' }
  await workApiRequest(session(), 'POST', '/api/templates', { body })
  const [call] = t.context.calls
  t.regex(call.url, /\/api\/templates$/)
  t.is(call.init.method, 'POST')
  t.deepEqual(JSON.parse(call.init.body), body)
})
