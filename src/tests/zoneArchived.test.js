import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sessionMock } from './helpers/mockWorkApi.js'

// The serving engine refuses an archived zone before any ad group is considered
// (throwIfZoneArchived), so every row a rollup could return for one is unreachable.
// These tests pin that the zone-keyed tools say so instead of answering normally.

const ZONE_ARCHIVED = { id: 'z_arch', name: 'Retired Zone', networkId: 'svce6t', creativeAssetGroupId: 'cag', archived: true }
const ZONE_LIVE = { id: 'z_live', name: 'Live Zone', networkId: 'svce6t', creativeAssetGroupId: 'cag' }
const AD_GROUP = { id: 'ag1', name: 'Group', networkId: 'svce6t', creativeAssetGroupId: 'cag', enabled: true, params: {} }
// Whitelists the archived zone and nothing else: reach is 0, and without
// archivedTargeted there is no way to tell WHICH stale whitelist caused it.
const AD_GROUP_STALE = { id: 'ag_stale', name: 'Stale', networkId: 'svce6t', creativeAssetGroupId: 'cag', enabled: true, params: { zoneId: ['z_arch'] } }

async function setup () {
  const mockWorkApi = {
    workApiRequest: async (_session, _method, path) => {
      if (path === `/api/zones/${ZONE_ARCHIVED.id}`) return ZONE_ARCHIVED
      if (path === `/api/zones/${ZONE_LIVE.id}`) return ZONE_LIVE
      if (path === `/api/ad-groups/${AD_GROUP.id}`) return AD_GROUP
      if (path === `/api/ad-groups/${AD_GROUP_STALE.id}`) return AD_GROUP_STALE
      if (path === '/api/zones') return { data: [ZONE_LIVE, ZONE_ARCHIVED] }
      if (path === '/api/ad-groups') return { data: [AD_GROUP, AD_GROUP_STALE] }
      return { data: [] }
    },
    handleWorkApiError: (err) => `Error: ${err.message}`
  }
  const mocks = {
    '../services/workApi.js': mockWorkApi,
    '../services/sessionManager.js': sessionMock({
      validateSession: async () => ({ valid: true, session: { auth_token: 't', networks: [{ id: 'svce6t' }] } })
    })
  }
  const { registerZoneInventoryTools } = await esmock('../tools/zoneInventoryTools.js', mocks)
  const { registerZoneEligibilityTools } = await esmock('../tools/zoneEligibilityTools.js', mocks)

  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  return server._registeredTools
}

const call = (tool, args) => tool.handler({ network_id: 'svce6t', ...args }, { sessionId: 'test-session' })

test('archived zone > get_zone_targeting_inventory reports the zone, not a targeting rollup', async t => {
  const tools = await setup()
  const res = await call(tools.get_zone_targeting_inventory, { zoneId: ZONE_ARCHIVED.id })
  t.true(res.content[0].text.includes('is ARCHIVED'))
  t.false(res.content[0].text.includes('"groups"'))
})

test('archived zone > get_zone_eligible_ad_groups reports the zone, not empty buckets', async t => {
  const tools = await setup()
  const res = await call(tools.get_zone_eligible_ad_groups, { zoneId: ZONE_ARCHIVED.id })
  t.true(res.content[0].text.includes('is ARCHIVED'))
  t.false(res.content[0].text.includes('freeRadicals'))
})

test('archived zone > explain_serve answers about the zone before the pair', async t => {
  const tools = await setup()
  const res = await call(tools.explain_serve, { zoneId: ZONE_ARCHIVED.id, adGroupId: AD_GROUP.id })
  t.true(res.content[0].text.includes('is ARCHIVED'))
  t.false(res.content[0].text.includes('IS eligible'))
})

test('archived zone > all three give the same verdict text', async t => {
  const tools = await setup()
  const texts = await Promise.all([
    call(tools.get_zone_targeting_inventory, { zoneId: ZONE_ARCHIVED.id }),
    call(tools.get_zone_eligible_ad_groups, { zoneId: ZONE_ARCHIVED.id }),
    call(tools.explain_serve, { zoneId: ZONE_ARCHIVED.id, adGroupId: AD_GROUP.id })
  ])
  const [a, b, c] = texts.map((r) => r.content[0].text)
  t.is(a, b)
  t.is(b, c)
  t.true(a.includes(ZONE_ARCHIVED.name))
})

test('archived zone > reach skips archived zones and counts what it skipped', async t => {
  const tools = await setup()
  const res = await call(tools.get_ad_group_zone_reach, { adGroupId: AD_GROUP.id })
  const text = res.content[0].text
  const payload = JSON.parse(text.slice(text.indexOf('\n\n') + 2))
  t.deepEqual(payload.zones.map((z) => z.zoneId), [ZONE_LIVE.id])
  t.is(payload.summary.reaches, 1)
  t.is(payload.scan.archivedZonesSkipped, 1)
})

test('archived zone > a live zone is unaffected', async t => {
  const tools = await setup()
  // bucket is defaulted by the input schema, which a direct handler call bypasses.
  const res = await call(tools.get_zone_eligible_ad_groups, { zoneId: ZONE_LIVE.id, bucket: 'all', offset: 0 })
  t.false(res.content[0].text.includes('ARCHIVED'))
  t.true(res.content[0].text.includes('freeRadicals'))
})

test('archived zone > reach names the archived zones a group still whitelists, not just a count', async t => {
  const tools = await setup()
  const res = await call(tools.get_ad_group_zone_reach, { adGroupId: AD_GROUP_STALE.id })
  const text = res.content[0].text
  const payload = JSON.parse(text.slice(text.indexOf('\n\n') + 2))
  t.deepEqual(payload.zones, []) // nothing reachable…
  t.deepEqual(payload.scan.archivedTargeted, [ZONE_ARCHIVED.id]) // …and this is why
  t.is(payload.scan.archivedZonesSkipped, 1)
})

test('archived zone > a group with no stale whitelist reports an empty archivedTargeted', async t => {
  const tools = await setup()
  const res = await call(tools.get_ad_group_zone_reach, { adGroupId: AD_GROUP.id })
  const text = res.content[0].text
  const payload = JSON.parse(text.slice(text.indexOf('\n\n') + 2))
  t.deepEqual(payload.scan.archivedTargeted, [])
})
