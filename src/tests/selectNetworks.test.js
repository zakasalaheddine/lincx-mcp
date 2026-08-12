import test from 'ava'
import { selectNetworks } from '../tools/networkTools.js'

const net = (id, archived) => ({
  id,
  name: `net-${id}`,
  owner: 'u',
  members: [],
  observers: [],
  dateCreated: '',
  dateUpdated: '',
  userUpdated: '',
  customDimensions: [],
  ...(archived === undefined ? {} : { archived })
})

// 2 active (one with archived:false, one with archived absent) + 3 archived.
const session = {
  networks: [net('a', false), net('b'), net('x1', true), net('x2', true), net('x3', true)],
  active_network: 'b'
}

// selectNetworks
test('selectNetworks > hides archived by default and reports how many were hidden', t => {
  const r = selectNetworks(session)
  t.is(r.total, 2)
  t.is(r.archived_hidden, 3)
  t.deepEqual(r.networks.map((n) => (n).id), ['a', 'b'])
  // absent archived flag reads as active, not archived
  t.is((r.networks[1]).archived, false)
})

test('selectNetworks > includeArchived surfaces every network with archived_hidden=0', t => {
  const r = selectNetworks(session, { includeArchived: true })
  t.is(r.total, 5)
  t.is(r.archived_hidden, 0)
})

test('selectNetworks > pages with limit/offset and emits next_offset until exhausted', t => {
  const all = selectNetworks(session, { includeArchived: true, limit: 2, offset: 0 })
  t.is(all.returned, 2)
  t.is(all.next_offset, 2)
  const last = selectNetworks(session, { includeArchived: true, limit: 2, offset: 4 })
  t.is(last.returned, 1)
  t.is(last.next_offset, null)
})

test('selectNetworks > marks the active network via is_active', t => {
  const r = selectNetworks(session)
  t.like(r.networks.find((n) => (n).is_active), { id: 'b' })
})
