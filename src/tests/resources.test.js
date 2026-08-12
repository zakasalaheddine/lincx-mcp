import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'

const extra = { sessionId: 'test-session' }

/** Fresh module graph per test — routes are per-test state, not a shared registry. */
async function build (routes = []) {
  const { registerResources } = await esmock('../tools/resources.js', {
    '../services/workApi.js': workApiMock(routes),
    '../services/sessionManager.js': sessionMock()
  })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerResources(server)
  return server
}

test('resources (T1-3 / T4-6) > registers lincx://networks as a static (listable) resource', async t => {
  const server = await build()
  const res = server._registeredResources['lincx://networks']
  t.not(res, undefined)

  const out = await res.readCallback(new URL('lincx://networks'), extra)
  t.is(out.contents[0].mimeType, 'application/json')
  const body = JSON.parse(out.contents[0].text)
  t.is(Array.isArray(body.networks), true)
  // (active_network is present on a real Session; the test stub omits it, so
  // JSON.stringify drops the undefined key — not asserted here.)
})

test('resources (T1-3 / T4-6) > registers entity resource templates that fetch by id', async t => {
  const server = await build([
    ['GET', /^\/api\/campaigns\/c1$/, () => ({ id: 'c1', name: 'Camp' })]
  ])
  const tmpl = server._registeredResourceTemplates['campaign-by-id']
  t.not(tmpl, undefined)

  const out = await tmpl.readCallback(new URL('lincx://campaign/c1'), { id: 'c1' }, extra)
  t.deepEqual(JSON.parse(out.contents[0].text), { id: 'c1', name: 'Camp' })
})

test('resources (T1-3 / T4-6) > entity templates carry no list callback — zero per-request (resources/list) cost', async t => {
  const server = await build()
  // Static resource is listed; templates without a list callback are not.
  t.true(Object.keys(server._registeredResources).includes('lincx://networks'))
  t.is(server._registeredResourceTemplates['zone-by-id'].resourceTemplate.listCallback, undefined)
})

test('resources (T1-3 / T4-6) > a resource read surfaces a clean error (not a throw) on upstream failure', async t => {
  // No route registered for zones/zX → workApiMock throws → handleWorkApiError formats it.
  const server = await build()
  const tmpl = server._registeredResourceTemplates['zone-by-id']
  const out = await tmpl.readCallback(new URL('lincx://zone/zX'), { id: 'zX' }, extra)
  t.is(out.contents[0].mimeType, 'text/plain')
  t.regex(out.contents[0].text, /^Error:/)
})

test.serial('resources (T1-3 / T4-6) > records a usage event when a resource is read', async t => {
  const { getEventSink } = await import('../services/usageAnalytics.js')
  const server = await build([
    ['GET', /^\/api\/campaigns\/c9$/, () => ({ id: 'c9', name: 'C' })]
  ])
  const tmpl = server._registeredResourceTemplates['campaign-by-id']

  await tmpl.readCallback(new URL('lincx://campaign/c9'), { id: 'c9' }, extra)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const recent = await (await getEventSink()).readRecent(5)
  const rec = recent.find((e) => e.type === 'resource' && e.name === 'campaign-by-id')
  t.is(rec?.status, 'ok')
})

test('resources (T1-3 / T4-6) > e2e: a real client sees lincx://networks in resources/list and can read it', async t => {
  const server = await build()
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'c', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])

  try {
    const list = await client.listResources()
    t.true(list.resources.map((r) => r.uri).includes('lincx://networks'))

    const tmpls = await client.listResourceTemplates()
    t.true(tmpls.resourceTemplates.map((x) => x.uriTemplate).includes('lincx://campaign/{id}'))

    const read = await client.readResource({ uri: 'lincx://networks' })
    t.is(Array.isArray(JSON.parse(read.contents[0].text).networks), true)
  } finally {
    await client.close()
    await server.close()
  }
})
