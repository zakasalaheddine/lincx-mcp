import test from 'ava'
import esmock from 'esmock'

import { RESPONSE_SIZE_LIMIT } from '../constants.js'

// The field failure: network_refresh dumped `session.networks` raw — 354 full
// network objects, 81974 chars against a 30k guard — and had an empty input
// schema, so the guard's "use pagination" hint named controls that did not
// exist. It now shares network_list's slim/paged shape via selectNetworks.

const net = (id, archived) => ({
  id,
  name: `Network ${id} — a name long enough to matter when 354 of them are dumped raw`,
  owner: 'owner@test.com',
  members: ['a@test.com', 'b@test.com'],
  observers: [],
  dateCreated: '2024-01-01T00:00:00.000Z',
  dateUpdated: '2025-06-01T00:00:00.000Z',
  userUpdated: 'someone@test.com',
  customDimensions: [{ key: 'k', label: 'Label' }],
  ...(archived === undefined ? {} : { archived })
})

// Adnet-shaped: a handful of live networks buried in archived test entries.
const bigNetworks = [
  ...Array.from({ length: 4 }, (_, i) => net(`live${i}`)),
  ...Array.from({ length: 350 }, (_, i) => net(`arch${i}`, true))
]

/** Register the tools onto a fake server and hand back the handlers by name. */
async function handlers ({ refreshResult }) {
  const mod = await esmock('../tools/networkTools.js', {
    '../services/sessionManager.js': {
      resolveLincxSession: async () => 'test-session',
      refreshNetworks: async () => refreshResult
    },
    '../services/sessionStore.js': { getSessionStore: async () => ({ get: async () => null }) }
  })
  const registered = {}
  mod.registerNetworkTools({
    registerTool: (name, config, handler) => { registered[name] = { config, handler } }
  })
  return registered
}

const callRefresh = async (registered, args = {}) => {
  const { config, handler } = registered.network_refresh
  return handler(config.inputSchema.parse(args), {})
}

test('network_refresh > fits the response guard on a 354-network account', async t => {
  const registered = await handlers({
    refreshResult: {
      session: { networks: bigNetworks }
    }
  })

  const res = await callRefresh(registered)
  const text = res.content[0].text
  t.true(text.length < RESPONSE_SIZE_LIMIT, `response was ${text.length} chars`)

  const body = JSON.parse(text)
  t.is(body.success, true)
  t.is(body.total, 4) // active only by default
  t.is(body.archived_hidden, 350)
  // slim rows, not the full upstream objects
  t.deepEqual(Object.keys(body.networks[0]).sort(), ['archived', 'id', 'name'])
})

test('network_refresh > pages with the same limit/offset contract as network_list', async t => {
  const registered = await handlers({
    refreshResult: {
      session: { networks: bigNetworks }
    }
  })

  const page = JSON.parse((await callRefresh(registered, { includeArchived: true, limit: 100, offset: 0 })).content[0].text)
  t.is(page.returned, 100)
  t.is(page.next_offset, 100)
  t.true(page.content === undefined)
})

test('network_refresh > returns the refreshed network list without server-side active-network fields', async t => {
  const registered = await handlers({
    refreshResult: {
      session: { networks: [net('live0')] }
    }
  })

  const body = JSON.parse((await callRefresh(registered)).content[0].text)
  t.is(body.success, true)
  t.is(body.total, 1)
  t.falsy(body.active_network)
  t.falsy(body.active_network_id)
})

test('network_refresh > an empty list says the fetch may have failed', async t => {
  const registered = await handlers({
    refreshResult: { session: { networks: [] } }
  })

  const body = JSON.parse((await callRefresh(registered)).content[0].text)
  t.is(body.total, 0)
  t.regex(body.note, /fetch failed/)
})

test('network_refresh > a dead session is an error, not an empty success', async t => {
  const registered = await handlers({ refreshResult: false })
  const res = await callRefresh(registered)
  t.regex(res.content[0].text, /Session may be invalid/)
})
