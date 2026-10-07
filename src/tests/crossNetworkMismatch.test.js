import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sessionMock } from './helpers/mockWorkApi.js'

async function setupServers () {
  const mockWorkApi = {
    workApiRequest: async (_session, _method, path) => {
      if (path === '/api/zones/z_wrong') {
        return { id: 'z_wrong', networkId: 'other_net' }
      }
      if (path === '/api/ad-groups/ag_wrong') {
        return { id: 'ag_wrong', networkId: 'other_net' }
      }
      if (path === '/api/ads/ad_wrong') {
        return { id: 'ad_wrong', networkId: 'other_net', adGroupId: 'ag_ok' }
      }
      if (path === '/api/ad-groups/ag_ok') {
        return { id: 'ag_ok', networkId: 'svce6t' }
      }
      if (path === '/api/zones/z_ok') {
        return { id: 'z_ok', networkId: 'svce6t', channelId: 'ch1' }
      }
      if (path === '/api/channels/ch1') return { id: 'ch1', type: 'Web' }
      return []
    },
    handleWorkApiError: (err) => `Error: ${err.message}`
  }

  const { registerZoneInventoryTools } = await esmock('../tools/zoneInventoryTools.js', {
    '../services/workApi.js': mockWorkApi,
    '../services/sessionManager.js': sessionMock({
      validateSession: async () => ({
        valid: true,
        session: { auth_token: 't', networks: [{ id: 'svce6t' }] }
      })
    })
  })

  const { registerZoneEligibilityTools } = await esmock('../tools/zoneEligibilityTools.js', {
    '../services/workApi.js': mockWorkApi,
    '../services/sessionManager.js': sessionMock({
      validateSession: async () => ({
        valid: true,
        session: { auth_token: 't', networks: [{ id: 'svce6t' }] }
      })
    })
  })

  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)

  return server._registeredTools
}

test('get_zone_targeting_inventory > rejects zone belonging to a different network', async t => {
  const tools = await setupServers()
  const res = await tools.get_zone_targeting_inventory.handler(
    { zoneId: 'z_wrong', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(res.content[0].text, "Error: Zone 'z_wrong' belongs to network 'other_net', not 'svce6t'.")
})

test('get_zone_eligible_ad_groups > rejects zone belonging to a different network', async t => {
  const tools = await setupServers()
  const res = await tools.get_zone_eligible_ad_groups.handler(
    { zoneId: 'z_wrong', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(res.content[0].text, "Error: Zone 'z_wrong' belongs to network 'other_net', not 'svce6t'.")
})

test('get_ad_group_zone_reach > rejects ad group belonging to a different network', async t => {
  const tools = await setupServers()
  const res = await tools.get_ad_group_zone_reach.handler(
    { adGroupId: 'ag_wrong', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(res.content[0].text, "Error: Ad group 'ag_wrong' belongs to network 'other_net', not 'svce6t'.")
})

test('explain_serve > rejects zone or ad group or ad belonging to a different network', async t => {
  const tools = await setupServers()

  // Zone mismatch
  const resZone = await tools.explain_serve.handler(
    { zoneId: 'z_wrong', adGroupId: 'ag_ok', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(resZone.content[0].text, "Error: Zone 'z_wrong' belongs to network 'other_net', not 'svce6t'.")

  // Ad group mismatch
  const resAg = await tools.explain_serve.handler(
    { zoneId: 'z_ok', adGroupId: 'ag_wrong', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(resAg.content[0].text, "Error: Ad group 'ag_wrong' belongs to network 'other_net', not 'svce6t'.")

  // Ad mismatch
  const resAd = await tools.explain_serve.handler(
    { zoneId: 'z_ok', adId: 'ad_wrong', network_id: 'svce6t' },
    { sessionId: 'test-session' }
  )
  t.is(resAd.content[0].text, "Error: Ad 'ad_wrong' belongs to network 'other_net', not 'svce6t'.")
})
