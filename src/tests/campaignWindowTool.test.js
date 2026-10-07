import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sessionMock } from './helpers/mockWorkApi.js'

// rollupZoneTargeting takes the clock as an argument, so the unit tests above pin the
// window with a fixed `now` and never touch the two real call sites that supply it.
// This drives the handlers instead: a dropped `now` in either tool would surface here
// rather than in production.

const DAY = 86400000
const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10)

const ZONE = { id: 'z1', name: 'Zone', networkId: 'net1', creativeAssetGroupId: 'cag', channelId: 'ch1' }
const GROUP_LIVE = { id: 'ag_live', name: 'Live', networkId: 'net1', campaignId: 'c_live', creativeAssetGroupId: 'cag', enabled: true, params: { zoneId: ['z1'] } }
const GROUP_EXPIRED = { id: 'ag_exp', name: 'Expired', networkId: 'net1', campaignId: 'c_exp', creativeAssetGroupId: 'cag', enabled: true, params: { zoneId: ['z1'] } }
const GROUP_FREE_EXPIRED = { id: 'ag_free_exp', name: 'Free radical, expired', networkId: 'net1', campaignId: 'c_exp', creativeAssetGroupId: 'cag', enabled: true, params: {} }
const CAMPAIGNS = [
  { id: 'c_live', enabled: true, dateStart: day(-5), dateEnd: day(5) },
  { id: 'c_exp', enabled: true, dateStart: day(-10), dateEnd: day(-1) }
]
const ADS = [
  { id: 'ad1', adGroupId: 'ag_live', enabled: true, creativeId: 'cr1' },
  { id: 'ad2', adGroupId: 'ag_exp', enabled: true, creativeId: 'cr1' },
  { id: 'ad3', adGroupId: 'ag_free_exp', enabled: true, creativeId: 'cr1' }
]

async function setup () {
  const mocks = {
    '../services/workApi.js': {
      workApiRequest: async (_s, _m, path) => {
        if (path === '/api/zones/z1') return ZONE
        if (path === '/api/zones') return { data: [ZONE] }
        if (path === '/api/channels/ch1') return { id: 'ch1', type: 'Web' }
        if (path === '/api/ad-groups') return { data: [GROUP_LIVE, GROUP_EXPIRED, GROUP_FREE_EXPIRED] }
        if (path === '/api/campaigns') return { data: CAMPAIGNS }
        if (path === '/api/ads') return { data: ADS }
        if (path === '/api/creatives') return { data: [{ id: 'cr1' }] }
        return { data: [] }
      },
      handleWorkApiError: (err) => `Error: ${err.message}`
    },
    '../services/sessionManager.js': sessionMock({
      validateSession: async () => ({ valid: true, session: { auth_token: 't', networks: [{ id: 'net1' }] } })
    })
  }
  const { registerZoneInventoryTools } = await esmock('../tools/zoneInventoryTools.js', mocks)
  const { registerZoneEligibilityTools } = await esmock('../tools/zoneEligibilityTools.js', mocks)
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  return server._registeredTools
}

const body = (res) => {
  const text = res.content[0].text
  return JSON.parse(text.slice(text.indexOf('\n\n') + 2))
}

test('campaign window at the tool call sites > get_zone_targeting_inventory supplies the clock and reports the expired campaign', async t => {
  const tools = await setup()
  const res = await tools.get_zone_targeting_inventory.handler(
    { network_id: 'net1', zoneId: 'z1', mode: 'all' },
    { sessionId: 's' }
  )
  const rows = body(res).groups
  const byId = new Map(rows.map((r) => [r.id, r]))
  t.is(byId.get('ag_live').campaign_on, true)
  t.is(byId.get('ag_live').fully_live, true)
  t.is(byId.get('ag_exp').campaign_on, false)
  t.deepEqual(byId.get('ag_exp').off_reason, ['campaign-window'])
})

test('campaign window at the tool call sites > get_zone_eligible_ad_groups supplies the clock through enrich', async t => {
  const tools = await setup()
  const res = await tools.get_zone_eligible_ad_groups.handler(
    { network_id: 'net1', zoneId: 'z1', bucket: 'all', offset: 0 },
    { sessionId: 's' }
  )
  const payload = body(res)
  const byId = new Map(payload.directlyTargeted.map((r) => [r.id, r]))
  t.is(byId.get('ag_live').fully_live, true)
  t.is(byId.get('ag_exp').fully_live, false)
  t.deepEqual(byId.get('ag_exp').off_reason, ['campaign-window'])
  t.is(payload.summary.directlyTargeted, 2)
  t.is(payload.summary.directlyTargetedLive, 1)
  t.is(byId.get('ag_live').offers.live, 1)
  t.is(byId.get('ag_exp').offers.live, 0)
})

test('campaign window at the tool call sites > an expired campaign reaches the offer-grain live counts', async t => {
  const tools = await setup()
  const res = await tools.get_zone_eligible_ad_groups.handler(
    { network_id: 'net1', zoneId: 'z1', bucket: 'all', offset: 0 },
    { sessionId: 's' }
  )
  const payload = body(res)
  const host = payload.freeRadicals.find((r) => r.id === 'ag_free_exp')
  t.is(host.offers.freeRadical, 1)
  t.is(host.offers.freeRadicalLive, 0)
  t.is(payload.summary.freeRadicalOffers, 1)
  t.is(payload.summary.freeRadicalOffersLive, 0)
})
