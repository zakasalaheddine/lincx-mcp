import test from 'ava'
import esmock from 'esmock'

import { normalizeDimensions, unknownDimensions } from '../tools/dimensionSetTools.js'

const NET = 'svce6t'
const existing = [
  { id: 'aaa111', name: 'Daily zones', dimensions: ['date', 'networkId', 'network', 'zoneId', 'zone'] },
  { id: 'bbb222', name: 'Old', dimensions: ['date', 'networkId', 'network', 'siteId', 'site'], archived: true },
  { id: 'ccc333', name: 'Custom', dimensions: ['date', 'networkId', 'network', 'utm_source'] }
]

test('normalizeDimensions orders the base first, adds pairs, drops duplicates', t => {
  t.deepEqual(normalizeDimensions(['zone', 'hour', 'zone']), ['date', 'hour', 'networkId', 'zone', 'network', 'zoneId'])
  t.deepEqual(normalizeDimensions(['s1', 'networkId', 'date']), ['date', 'networkId', 's1', 'network'])
})

test('unknownDimensions knows core columns and what the network already uses', t => {
  t.deepEqual(unknownDimensions(['zone', 'device', 'utm_source'], existing), [])
  t.deepEqual(unknownDimensions(['utm_sorce'], existing), ['utm_sorce'])
})

async function load ({ sets = existing, post } = {}) {
  const calls = []
  const mod = await esmock('../tools/dimensionSetTools.js', {}, {
    '../services/workApi.js': {
      workApiRequest: async (_s, method, path, opts) => {
        calls.push({ method, path, opts })
        if (method === 'POST' || method === 'PUT') {
          if (post) return post(opts)
          return { data: { ...opts.body, id: 'n3wset' } }
        }
        if (path !== '/api/dimension-sets') return { data: sets.find(x => path.endsWith(x.id)) }
        return { data: sets }
      },
      handleWorkApiError: (e) => `Error: api ${e.status} ${JSON.stringify(e.data ?? {})}`
    },
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 'jwt' }),
      validateSession: async (a) => ({ valid: true, session: a })
    }
  })
  const tools = {}
  mod.registerDimensionSetWriteTools({ registerTool: (n, def, h) => { tools[n] = { h, schema: def.inputSchema } } })
  const { h, schema } = tools.create_dimension_set
  const run = async (over) => (await h({ network_id: NET, name: 'Hourly zones', dimensions: ['zone', 'hour'], ...over }, {})).content[0].text
  return { run, schema, calls, tools, posts: () => calls.filter(c => c.method === 'POST') }
}

test('the schema rejects malformed input', async t => {
  const { schema } = await load()
  const ok = { network_id: NET, name: 'x', dimensions: ['zone'] }
  t.true(schema.safeParse(ok).success)
  for (const bad of [{ dimensions: [] }, { name: ' ' }, { name: 'a'.repeat(51) }, { name: 'a\nb' }, { dimensions: ['a\u0000'] }, { network_id: 'BAD' }, { extra: 1 }]) {
    t.false(schema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad))
  }
})

test('creates with the normalised dimensions', async t => {
  const env = await load()
  const out = await env.run()
  t.deepEqual(env.posts()[0].opts.body, { networkId: NET, name: 'Hourly zones', dimensions: ['date', 'hour', 'networkId', 'zone', 'network', 'zoneId'] })
  t.true(out.startsWith('Created report n3wset'))
})

test('returns the existing active report instead of creating a duplicate', async t => {
  const env = await load()
  const out = await env.run({ dimensions: ['zoneId'] })
  t.regex(out, /already exists: aaa111/)
  t.is(env.posts().length, 0)
})

test('an archived report with the same dimensions does not block a create', async t => {
  const env = await load()
  await env.run({ dimensions: ['site'] })
  t.is(env.posts().length, 1)
})

test('an unseen dimension is refused unless allowed', async t => {
  const env = await load()
  t.regex(await env.run({ dimensions: ['utm_sorce'] }), /permanent custom dimension/)
  t.is(env.posts().length, 0)
  await env.run({ dimensions: ['utm_sorce'], allowNewDimensions: true })
  t.is(env.posts().length, 1)
})

test('upstream 422 and 403 surface, a 5xx warns the report may exist', async t => {
  const fail = (status, data) => () => { throw Object.assign(new Error('x'), { status, data }) }
  t.regex(await (await load({ post: fail(422, { details: 'no more than 50 dimension sets per network allowed' }) })).run(), /no more than 50/)
  t.regex(await (await load({ post: fail(403) })).run(), /^Error: Forbidden/)
  t.regex(await (await load({ post: fail(502) })).run(), /MAY have been created/)
})

// ── add_dimensions_to_set ───────────────────────────────────────────────────

const add = async (env, over) => (await env.tools.add_dimensions_to_set.h({ network_id: NET, id: 'aaa111', dimensions: ['hour'], ...over }, {})).content[0].text
const puts = (env) => env.calls.filter(c => c.method === 'PUT')

test('add_dimensions_to_set: schema rejects a path-injection id and empty dimensions', async t => {
  const { tools } = await load()
  const s = tools.add_dimensions_to_set.schema
  t.true(s.safeParse({ network_id: NET, id: 'aaa111', dimensions: ['hour'] }).success)
  t.false(s.safeParse({ network_id: NET, id: '../zones/abcdef', dimensions: ['hour'] }).success)
  t.false(s.safeParse({ network_id: NET, id: 'abc123/../x', dimensions: ['hour'] }).success)
  t.false(s.safeParse({ network_id: NET, id: 'abc123-def45', dimensions: ['hour'] }).success)
  t.true(s.safeParse({ network_id: NET, id: '336xd5-f530uy', dimensions: ['hour'] }).success, 'older dashed report id')
  t.false(s.safeParse({ network_id: NET, id: 'aaa111', dimensions: [] }).success)
})

test('add_dimensions_to_set: adds hour, keeping name and putting hour in its required slot', async t => {
  const env = await load({ sets: [{ ...existing[0], networkId: NET }, ...existing.slice(1)] })
  const out = await add(env)
  t.deepEqual(puts(env)[0].opts.body, { networkId: NET, name: 'Daily zones', dimensions: ['date', 'hour', 'networkId', 'network', 'zoneId', 'zone'] })
  t.regex(out, /^Updated report \w+ "Daily zones" — added hour/)
})

test('add_dimensions_to_set: edits a report with an older dashed id', async t => {
  const env = await load({ sets: [{ ...existing[0], id: '336xd5-f530uy', networkId: NET }] })
  await add(env, { id: '336xd5-f530uy' })
  t.is(puts(env)[0].path, '/api/dimension-sets/336xd5-f530uy')
})

test('add_dimensions_to_set: nothing to add writes nothing', async t => {
  const env = await load({ sets: [{ ...existing[0], networkId: NET }] })
  t.regex(await add(env, { dimensions: ['zone'] }), /already has these dimensions/)
  t.is(puts(env).length, 0)
})

test('add_dimensions_to_set: refuses another network, an archived set, and an unseen dimension — without a PUT', async t => {
  const env = await load({ sets: [{ ...existing[0], networkId: 'other1' }, { ...existing[1], networkId: NET }] })
  t.regex(await add(env), /belongs to network other1/)
  t.regex(await add(env, { id: 'bbb222' }), /archived/)
  const env2 = await load({ sets: [{ ...existing[0], networkId: NET }] })
  t.regex(await add(env2, { dimensions: ['utm_sorce'] }), /permanent custom dimension/)
  t.is(puts(env).length + puts(env2).length, 0)
})

test('add_dimensions_to_set: upstream 422 (would duplicate another report) passes through', async t => {
  const env = await load({ sets: [{ ...existing[0], networkId: NET }], post: () => { throw Object.assign(new Error('x'), { status: 422, data: { details: 'Duplicated dimension set exist: "Hourly"(zzz999)' } }) } })
  t.regex(await add(env), /Duplicated dimension set exist/)
})
