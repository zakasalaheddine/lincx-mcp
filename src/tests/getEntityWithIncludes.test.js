import test from 'ava'
import esmock from 'esmock'
import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'

// getEntityWithIncludes only passes the session through to the (mocked)
// workApiRequest, so a stub is sufficient here.
const session = {}

/** Fresh module graph per test — no shared handler registry to reset. */
function load (routes) {
  return esmock('../tools/_shared.js', {
    '../services/workApi.js': workApiMock(routes),
    '../services/sessionManager.js': sessionMock()
  })
}

test('getEntityWithIncludes > returns the bare entity (no extra call) when include is omitted', async t => {
  const { getEntityWithIncludes } = await load([
    ['GET', /\/api\/campaigns\/c1$/, () => ({ id: 'c1', name: 'Camp' })]
  ])
  const r = await getEntityWithIncludes(session, '/api/campaigns', 'c1', undefined)
  t.deepEqual(r, { id: 'c1', name: 'Camp' })
})

test("getEntityWithIncludes > wraps as { entity, parents } when include=['parents']", async t => {
  const { getEntityWithIncludes } = await load([
    ['GET', /\/api\/zones\/z1$/, () => ({ id: 'z1', name: 'Zone' })],
    ['GET', /\/api\/zones\/z1\/parents$/, () => [{ id: 'site1' }, { id: 'net1' }]]
  ])
  const r = await getEntityWithIncludes(session, '/api/zones', 'z1', ['parents'])
  t.deepEqual(r, {
    entity: { id: 'z1', name: 'Zone' },
    parents: [{ id: 'site1' }, { id: 'net1' }]
  })
})

test('getEntityWithIncludes > uses a stable wrap shape even when the entity comes back wrapped in { data }', async t => {
  const { getEntityWithIncludes } = await load([
    ['GET', /\/api\/templates\/t1$/, () => ({ data: { id: 't1', html: '<div/>' } })],
    ['GET', /\/api\/templates\/t1\/parents$/, () => [{ id: 'net1' }]]
  ])
  const r = await getEntityWithIncludes(session, '/api/templates', 't1', ['parents'])
  // Entity is nested under `entity` as-is; we never spread the unknown shape.
  t.deepEqual(r, {
    entity: { data: { id: 't1', html: '<div/>' } },
    parents: [{ id: 'net1' }]
  })
})
