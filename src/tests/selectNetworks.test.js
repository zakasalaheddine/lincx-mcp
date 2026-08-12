import { describe, it, expect } from 'vitest'
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

describe('selectNetworks', () => {
  it('hides archived by default and reports how many were hidden', () => {
    const r = selectNetworks(session)
    expect(r.total).toBe(2)
    expect(r.archived_hidden).toBe(3)
    expect(r.networks.map((n) => (n).id)).toEqual(['a', 'b'])
    // absent archived flag reads as active, not archived
    expect((r.networks[1]).archived).toBe(false)
  })

  it('includeArchived surfaces every network with archived_hidden=0', () => {
    const r = selectNetworks(session, { includeArchived: true })
    expect(r.total).toBe(5)
    expect(r.archived_hidden).toBe(0)
  })

  it('pages with limit/offset and emits next_offset until exhausted', () => {
    const all = selectNetworks(session, { includeArchived: true, limit: 2, offset: 0 })
    expect(all.returned).toBe(2)
    expect(all.next_offset).toBe(2)
    const last = selectNetworks(session, { includeArchived: true, limit: 2, offset: 4 })
    expect(last.returned).toBe(1)
    expect(last.next_offset).toBeNull()
  })

  it('marks the active network via is_active', () => {
    const r = selectNetworks(session)
    expect(r.networks.find((n) => (n).is_active)).toMatchObject({ id: 'b' })
  })
})
