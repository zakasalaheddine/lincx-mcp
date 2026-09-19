import test from 'ava'
import esmock from 'esmock'

import { filterByEntityId, toDateTime, resolveWindow, withEventId } from '../tools/auditTools.js'

/**
 * Four things can go quietly wrong here:
 *  - the network lands in the query param instead of the PATH (this endpoint is
 *    scoped by /api/networks/{id}/…, so the wrong scoping returns another
 *    network's log, or a 404),
 *  - the scope comes from somewhere other than the tool's network_id argument —
 *    there is no server-side active network any more,
 *  - the default list projection keeps { id, name } + status fields, none of
 *    which an action row has, so rows come back near-empty and look like "no
 *    data",
 *  - the "no field-level diff" caveat lives only in the tool description, where
 *    a model reading the RESPONSE never sees it.
 */

const auth = () => ({
  auth_token: 'jwt',
  user_id: 'u1',
  email: 'someone@lincx.com'
})

// The shape lincx-core actually stores: `entity` is _.camelCase(model.name),
// there is no `eventId` field, and `_id` is a pathkey carrying a raw \xff.
const row = (over = {}) => ({
  _id: 'networkId-eventId\xffsvce6t\xffcev1',
  type: 'update',
  timestamp: '2026-08-30T14:02:00Z',
  entity: 'adGroup',
  entityName: 'Mortgage — desktop',
  entityId: 'dr0xp2',
  user: 'someone@lincx.com',
  network: 'Interlincx',
  networkId: 'svce6t',
  ...over
})

async function load (rows) {
  const seen = []
  const validated = []
  const mod = await esmock('../tools/auditTools.js', {}, {
    '../services/workApi.js': {
      workApiRequest: async (_s, _m, path, opts) => {
        seen.push({ path, params: opts?.params, options: opts })
        return rows
      },
      handleWorkApiError: (e) => `Error: ${e.message}`
    },
    '../services/sessionManager.js': {
      resolveLincxSession: async () => auth(),
      validateSession: async (a) => {
        validated.push(a)
        return { valid: true, session: a }
      }
    }
  })
  const tools = {}
  const schemas = {}
  mod.registerAuditTools({ registerTool: (name, def, h) => { tools[name] = h; schemas[name] = def.inputSchema } })
  return { tools, schemas, seen, validated }
}

const call = async (tools, args = {}) =>
  JSON.parse((await tools.get_user_actions({ network_id: 'svce6t', limit: 25, offset: 0, ...args }, {})).content[0].text)

test('filterByEntityId narrows to one entity and leaves rows alone when omitted', t => {
  const rows = [row(), row({ entityId: 'other1' }), row({ entityId: 'dr0xp2', type: 'archive' })]
  t.is(filterByEntityId(rows, 'dr0xp2').length, 2)
  t.is(filterByEntityId(rows, undefined).length, 3)
  t.is(filterByEntityId(rows, 'nothing').length, 0)
})

test('the auth context — not a session id — is what gets validated', async t => {
  // validateSession checks auth?.auth_token; handing it the old session-id
  // string would fail closed with "Not authenticated" against the real module.
  const { tools, validated } = await load([row()])
  await call(tools)
  t.is(validated[0].auth_token, 'jwt')
})

test('the network scopes through the PATH, from the network_id argument', async t => {
  const { tools, seen } = await load([row()])
  await call(tools)
  await call(tools, { network_id: 'abc123' })

  t.is(seen[0].path, '/api/networks/svce6t/user-actions',
    'the argument network must be interpolated into the path — this endpoint is not scoped by ?networkId')
  t.is(seen[1].path, '/api/networks/abc123/user-actions',
    'a different network_id must produce a different path — scope comes from the argument, nothing else')
  t.is(seen[0].options.networkId, undefined,
    'options.networkId is a no-op on a non-list path; passing it would imply scoping that never happens')
  t.false('networkId' in (seen[0].params ?? {}), 'network_id must not leak into the query params')
})

test('the API-supported filters are passed through, and entityId is not', async t => {
  const { tools, seen } = await load([row(), row({ entityId: 'other1' })])
  const out = await call(tools, {
    entityId: 'dr0xp2',
    model: 'adGroup',
    type: 'update',
    user: 'someone@lincx.com',
    dateStart: '2026-08-01',
    dateEnd: '2026-08-31'
  })

  t.deepEqual(seen[0].params, {
    dateStart: '2026-08-01T00:00:00.000Z',
    // The upstream range is `$lt: dateEnd`, so a bare end date must be expanded
    // to the NEXT midnight or every event on Aug 31 silently drops out.
    dateEnd: '2026-09-01T00:00:00.000Z',
    model: 'adGroup',
    type: 'update',
    user: 'someone@lincx.com'
  }, 'entityId is not an upstream filter — sending it would be silently ignored upstream')
  t.is(out.total, 1, 'entityId must still narrow the result, server-side')
  t.is(out.items[0].entityId, 'dr0xp2')
})

test('bare dates are normalised, and the end bound covers its whole day', t => {
  // Upstream validates both with ajv `format: "date-time"`: a bare date is a 422
  // ('data.dateStart should match format "date-time"'), not a tolerated shorthand.
  t.is(toDateTime('2026-08-01'), '2026-08-01T00:00:00.000Z')
  t.is(toDateTime('2026-08-31', { end: true }), '2026-09-01T00:00:00.000Z')
  t.is(toDateTime('2026-08-01T06:30:00+02:00'), '2026-08-01T04:30:00.000Z',
    'upstream compares the two bounds as STRINGS, so offsets must be folded to Z')
  t.is(toDateTime('last tuesday'), 'last tuesday',
    'an unparseable bound passes through to upstream, which rejects it by name — guessing a date here would answer for a window nobody asked for')
})

test('the window is defaulted, sent, and echoed — never left to upstream', async t => {
  // With no dates lincx-core defaults to the last 14 days. A group archived three
  // weeks ago then returns total: 0, which reads as "nobody touched it".
  const { tools, seen } = await load([row()])
  const out = await call(tools)

  t.is(typeof seen[0].params.dateStart, 'string', 'the window must be sent, not implied')
  t.is(typeof seen[0].params.dateEnd, 'string')
  t.is(out.window.dateStart, seen[0].params.dateStart, 'the echo must be what was actually sent')
  t.is(out.window.dateEnd, seen[0].params.dateEnd)
  t.true(out.window.defaulted, 'a defaulted window must say so — 14 days is not "all of history"')

  const days = (new Date(out.window.dateEnd) - new Date(out.window.dateStart)) / 86400000
  t.is(Math.round(days), 14)
})

test('a dateEnd older than two weeks does not 422 on the defaulted start', async t => {
  // Upstream anchors its default start at now, then rejects dateStart > dateEnd.
  // Anchoring on the END instead keeps "what happened that week" a valid question.
  const { tools, seen } = await load([row()])
  const out = await call(tools, { dateEnd: '2026-01-31' })
  t.true(seen[0].params.dateStart < seen[0].params.dateEnd)
  t.is(out.window.dateStart, '2026-01-18T00:00:00.000Z')
  t.is(out.window.dateEnd, '2026-02-01T00:00:00.000Z')
})

test('resolveWindow marks an explicit window as not defaulted', t => {
  t.is(resolveWindow('2026-08-01', '2026-08-31').defaulted, undefined)
  t.true(resolveWindow(undefined, '2026-08-31').defaulted)
})

test("Mongo's _id becomes the eventId the row shape advertises", async t => {
  // Upstream stores no eventId field and does not strip _id, a pathkey holding a
  // raw \xff plus a duplicate of networkId.
  const { tools } = await load([row()])
  const out = await call(tools)
  t.is(out.items[0].eventId, 'cev1')
  t.false('_id' in out.items[0], 'the raw pathkey must not reach the response')
  t.is(withEventId([{ entityId: 'a' }])[0].eventId, undefined, 'a row with no _id is left alone')
})

test('rows come back newest first', async t => {
  // Upstream streams ascending _id, i.e. oldest first, so "who just turned this
  // off" would sit on the LAST page of a busy network.
  const { tools } = await load([
    row({ timestamp: '2026-08-01T00:00:00Z', entityId: 'old' }),
    row({ timestamp: '2026-08-30T14:02:00Z', entityId: 'new' })
  ])
  const out = await call(tools)
  t.is(out.items[0].entityId, 'new')
  t.is(out.items[1].entityId, 'old')
})

test('rows come back whole — the default projection would empty them', async t => {
  // An action row has no id/name/status field, so the standard { id, name } +
  // status projection returns `{}` per row: the log looks empty when it is not.
  const { tools } = await load([row()])
  const out = await call(tools)
  t.is(out.items[0].user, 'someone@lincx.com')
  t.is(out.items[0].timestamp, '2026-08-30T14:02:00Z')
  t.is(out.items[0].type, 'update')
  t.is(out.unknown_fields, undefined,
    "the ['*'] default must not be reported back as a field path that matched no row")
})

test('the response itself says there is no field-level diff', async t => {
  // The caveat cannot live only in the tool description: the model reads the
  // response, and `type: update` next to a delivery drop is exactly the row it
  // will otherwise present as a cause.
  const { tools } = await load([row()])
  const out = await call(tools)
  t.regex(out.grain, /no field-level diff/i)
})

test('paging uses the standard envelope', async t => {
  const { tools } = await load(Array.from({ length: 30 }, (_, i) => row({ _id: `networkId-eventId\xffsvce6t\xffcev${i}` })))
  const first = await call(tools, { limit: 10, offset: 0 })
  t.is(first.items.length, 10)
  t.is(first.next_offset, 10)
  t.true(first.has_more)

  const last = await call(tools, { limit: 10, offset: 20 })
  t.is(last.has_more, false)
  t.is(last.next_offset, null)
})

test('an unsupported action type is rejected by the schema, not silently dropped', async t => {
  const { schemas } = await load([])
  const schema = schemas.get_user_actions
  const base = { network_id: 'svce6t' }
  t.false(schema.safeParse({ ...base, type: 'delete' }).success, 'the API knows seven action types; delete is not one')
  t.false(schema.safeParse({ ...base, user: 'not-an-email' }).success)
  t.false(schema.safeParse({ ...base, entity: 'adGroup' }).success, 'the filter is `model`; a near-miss must not pass .strict()')
  t.false(schema.safeParse({ ...base, model: 'AdGroup' }).success,
    "upstream stores _.camelCase(model.name) and matches it exactly — 'AdGroup' would return an empty log, not an error")
  t.true(schema.safeParse({ ...base, type: 'archive', model: 'adGroup' }).success)
})

test('network_id is required and shape-checked', async t => {
  const { schemas } = await load([])
  const schema = schemas.get_user_actions
  t.false(schema.safeParse({ type: 'archive' }).success, 'scope is required — there is no active network to fall back on')
  t.false(schema.safeParse({ network_id: 'SVCE6T' }).success)
  t.false(schema.safeParse({ network_id: 'toolong1' }).success)
})
