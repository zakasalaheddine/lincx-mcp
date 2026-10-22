import test from 'ava'
import esmock from 'esmock'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sessionMock } from './helpers/mockWorkApi.js'

const NET = 'ybdob7'
const CAG = 'fc57y2'
const T0 = 'fbdmxz'
const T1 = '81bkz5'
const CHANNEL = { id: 'ch1', type: 'Web' }
const Z0 = { id: 'uz4dab', name: 'Z0', networkId: NET, publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' }, channelId: 'ch1' }
const Z1 = { id: 'by8tgq', name: 'Z1', networkId: NET, publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T1, channelId: 'ch1' }
// Segments on, and neither the zone nor its one segment passes its own allowlist:
// the ad server refuses every visit.
const ZR = { id: 'zrefus', name: 'ZR', networkId: NET, publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' }, channelId: 'ch1', segmentsStatus: 'on', allowlist: { zoneType: ['Other'] }, segments: [] }
// Lists fail only on the s1 default: a visit with s1=xyz is served.
const ZD = { ...ZR, id: 'zdefau', name: 'ZD', allowlist: { s1: ['xyz'] }, segments: [{ id: 'sd', templateId: T1, trafficAllocation: 100, allowlist: { s1: ['xyz'] } }] }
// No unpinned visit gets a segment, but a visit pinning segmentId 'sp' does.
const ZP = { ...ZR, id: 'zpinnd', name: 'ZP', segments: [{ id: 'sp', templateId: T1, trafficAllocation: 100, allowlist: { zoneType: ['Other'] } }] }
// The zone fails its own allowlist and its one segment covers 70%: 30% of unpinned
// visits get no ad.
const ZU = { ...ZR, id: 'zunsrv', name: 'ZU', segments: [{ id: 'su', templateId: T1, trafficAllocation: 70 }] }
const group = (id, extra = {}) => ({ id, name: id, networkId: NET, campaignId: 'c1', creativeAssetGroupId: CAG, enabled: true, ...extra })
const GROUPS = [
  group('G00'),
  group('G01', { params: { templateId: [T0] } }),
  group('G03', { params: { s1: ['abc'] } }),
  group('G04', { params: { s1: ['xyz'] } }),
  group('G05', { params: { device: ['mobile'] } }),
  group('G06', { exceptParams: { device: ['mobile'] } }),
  group('G09', { params: { zoneId: [Z0.id] }, exceptParams: { templateId: [T0] } }),
  group('G11', { geo: ['TX'] }),
  group('G13'),
  group('T1', { params: { zoneId: [Z0.id] } })
]
const ad = (id, adGroupId, extra = {}) => ({ id, networkId: NET, adGroupId, enabled: true, creativeId: 'cr1', ...extra })
const ADS = [
  ...GROUPS.filter((g) => g.id !== 'G13' && g.id !== 'T1').map((g) => ad(`${g.id}-ad0`, g.id)),
  ad('G00-ad1', 'G00', { params: { deviceOs: ['ios'] } }),
  ad('G13-ad0', 'G13'),
  ad('G13-ad1', 'G13', { exceptParams: { templateId: [T0] } }),
  ad('T1-ad0', 'T1', { exceptParams: { templateId: [T0] } })
]

// Ads whose liveness is what differs: L01's only live ad is geo-only, L02's ads are
// each dark for a different reason, and L03 sits under a switched-off campaign.
const LIVENESS = {
  groups: [group('L01'), group('L02'), group('L03', { campaignId: 'c2' }), group('L04')],
  ads: [
    ad('L01-tx', 'L01', { params: { geoState: ['TX'] } }),
    ad('L01-ca', 'L01', { params: { geoState: ['CA'] }, enabled: false }),
    ad('L02-off', 'L02', { enabled: false }),
    ad('L02-arch', 'L02', { creativeId: 'cr2' }),
    ad('L02-nocr', 'L02', { creativeId: 'crX' }),
    ad('L02-native', 'L02', { params: { zoneType: ['Native'] } }),
    ad('L02-adarch', 'L02', { archived: true }),
    ad('L03-ad0', 'L03'),
    ad('L04-plain', 'L04'),
    ad('L04-tx', 'L04', { params: { geoState: ['TX'] }, enabled: false })
  ]
}

async function setup ({ channel = true, channelError, hiddenFromList = false, withZU = false, liveness = false, forbidden } = {}) {
  const groups = liveness ? [...GROUPS, ...LIVENESS.groups] : GROUPS
  const ads = liveness ? [...ADS, ...LIVENESS.ads] : ADS
  const campaigns = [{ id: 'c1', enabled: true }, { id: 'c2', enabled: false }]
  const creatives = [{ id: 'cr1' }, { id: 'cr2', archived: true }]
  const calls = []
  const byPath = new Map([
    [`/api/zones/${Z0.id}`, Z0],
    [`/api/zones/${Z1.id}`, Z1],
    ...(channel ? [['/api/channels/ch1', CHANNEL], ['/api/channels', { data: hiddenFromList ? [] : [CHANNEL] }]] : []),
    [`/api/zones/${ZR.id}`, ZR],
    [`/api/zones/${ZD.id}`, ZD],
    [`/api/zones/${ZP.id}`, ZP],
    [`/api/zones/${ZU.id}`, ZU],
    ['/api/zones', { data: [Z0, Z1, ZR, ...(withZU ? [ZU] : [])] }],
    ['/api/ad-groups', { data: groups }],
    ['/api/campaigns', { data: liveness ? campaigns : campaigns.slice(0, 1) }],
    ['/api/ads', { data: ads }],
    ['/api/creatives', { data: liveness ? creatives : creatives.slice(0, 1) }],
    ...groups.map((g) => [`/api/ad-groups/${g.id}`, g]),
    ...ads.map((a) => [`/api/ads/${a.id}`, a]),
    ...campaigns.map((c) => [`/api/campaigns/${c.id}`, c]),
    ...creatives.map((c) => [`/api/creatives/${c.id}`, c])
  ])
  const mocks = {
    '../services/workApi.js': {
      workApiRequest: async (_s, method, path, opts) => {
        calls.push({ method, path, networkId: opts?.networkId })
        const status = (code) => Object.assign(new Error(`HTTP ${code}`), { status: code })
        if (channelError && path.startsWith('/api/channels/')) throw status(channelError)
        if (forbidden && path === forbidden) throw status(403)
        if (!byPath.has(path) && path.startsWith('/api/channels/')) throw status(404)
        return byPath.get(path) ?? { data: [] }
      },
      handleWorkApiError: (err) => `Error: ${err.message}`
    },
    '../services/sessionManager.js': sessionMock({
      validateSession: async () => ({ valid: true, session: { auth_token: 't', networks: [{ id: NET }] } })
    })
  }
  const { registerZoneInventoryTools } = await esmock('../tools/zoneInventoryTools.js', mocks)
  const { registerZoneEligibilityTools } = await esmock('../tools/zoneEligibilityTools.js', mocks)
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  const tools = server._registeredTools
  tools.calls = calls
  return tools
}

const call = (tool, args) => tool.handler({ network_id: NET, ...args }, { sessionId: 's' })
const parse = (res) => {
  const text = res.content[0].text
  const i = text.indexOf('\n\n')
  return { header: i < 0 ? text : text.slice(0, i), json: i < 0 ? undefined : JSON.parse(text.slice(i + 2)) }
}
const eligible = (args) => ({ zoneId: Z0.id, bucket: 'all', offset: 0, ...args })

test('get_zone_eligible_ad_groups > conditional rows counted apart, the visit keys named, no visit assumed', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  t.deepEqual(json.zone, { id: Z0.id, name: 'Z0', creativeAssetGroupId: CAG, templateId: T0, type: 'Display', channelType: 'Web' })
  t.is(json.request, undefined)
  t.like(json.summary, { freeRadicalHosts: 4, freeRadicalHostsConditional: 3, excludedByDefault: 1, directlyTargeted: 2, directlyTargetedIneligible: 1 })
  t.is(json.summary.excludedByRequest, undefined)
  t.deepEqual(json.summary.conditionKeys, {
    device: { requires: { values: ['mobile'] }, excludes: { values: ['mobile'] }, groups: 2 },
    deviceOs: { requires: { values: ['ios'] }, groups: 1 },
    geoState: { requires: { values: ['TX'] }, groups: 1 }
  })
  t.deepEqual(json.excludedByDefault.map((r) => r.id), ['G04'])
  t.true(header.includes('4 free-radical hosts (4 live) · 3 conditional (3 live)'))
  t.true(header.includes('1 excluded by a zone default (a visit overriding it would change this)'))
  t.true(header.includes('conditional on: device, deviceOs, geoState'))
})

test('get_zone_eligible_ad_groups > a row carries its own conditions and lists every ad', async t => {
  const tools = await setup()
  const { json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  const byId = new Map(json.freeRadicals.map((r) => [r.id, r]))
  t.deepEqual(byId.get('G05').conditions, [{ path: 'params.device', key: 'device', op: 'requires', values: ['mobile'], valuesTotal: 1, source: 'request' }])
  t.like(byId.get('G00').offers, { total: 2, inScope: 1, conditional: 1 })
  t.is(byId.get('G00').offers.conditionalAds, undefined)
  t.deepEqual(byId.get('G00').offers.ads, [
    { adId: 'G00-ad0', verdict: 'eligible', live: true },
    { adId: 'G00-ad1', verdict: 'conditional', live: true, conditions: [{ path: 'params.deviceOs', key: 'deviceOs', op: 'requires', values: ['ios'], valuesTotal: 1, source: 'request' }] }
  ])
})

test('get_zone_eligible_ad_groups > each dark ad says what is off', async t => {
  const tools = await setup({ liveness: true })
  const { json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  const byId = new Map(json.freeRadicals.map((r) => [r.id, r]))
  t.deepEqual(byId.get('L02').offers.ads.map((a) => [a.adId, a.verdict, a.live, a.off, a.reasons]), [
    ['L02-off', 'eligible', false, ['ad-disabled'], undefined],
    ['L02-arch', 'eligible', false, ['creative-archived'], undefined],
    ['L02-nocr', 'eligible', false, ['creative-missing'], undefined],
    ['L02-native', 'excluded', true, undefined, ['ad-param-mismatch']],
    ['L02-adarch', 'eligible', false, ['ad-archived'], undefined]
  ])
  const l03 = byId.get('L03')
  t.deepEqual(l03.off_reason, ['campaign'])
  t.deepEqual(l03.offers.ads, [{ adId: 'L03-ad0', verdict: 'eligible', live: false, off: ['campaign-or-ad-group'] }])
})

test('get_zone_eligible_ad_groups > filter liveOnlyOnConditionalAds returns the groups the summary only counts', async t => {
  const tools = await setup({ liveness: true })
  const { header, json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ filter: 'liveOnlyOnConditionalAds' })))
  t.deepEqual([...json.directlyTargeted, ...json.freeRadicals].map((r) => r.id), ['L01'])
  t.is(json.summary.freeRadicalHostsLiveOnConditionalAds + json.summary.directlyTargetedLiveOnConditionalAds, 1)
  t.like(json.page, { filter: 'liveOnlyOnConditionalAds', total: 1, returned: 1 })
  t.true(json.complete)
  t.true(header.includes("FILTERED: 1 rows matching filter 'liveOnlyOnConditionalAds'"))
  const l01 = json.freeRadicals[0]
  t.deepEqual(l01.offers.ads.map((a) => [a.adId, a.verdict, a.live]), [['L01-tx', 'conditional', true], ['L01-ca', 'conditional', false]])
})

test('get_zone_eligible_ad_groups > filter hasLiveConditionalAd keeps every row with a live conditional offer, and pages over them', async t => {
  const tools = await setup({ liveness: true })
  const all = parse(await call(tools.get_zone_eligible_ad_groups, eligible())).json
  t.like(all.freeRadicals.find((r) => r.id === 'L04').offers, { conditional: 1, conditionalLive: 0 })
  const { json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ filter: 'hasLiveConditionalAd' })))
  const ids = [...json.directlyTargeted, ...json.freeRadicals, ...json.conflicting, ...json.inertWhitelists, ...json.excludedByDefault].map((r) => r.id)
  t.deepEqual([...ids].sort(), ['G00', 'G05', 'G06', 'G11', 'L01'])
  t.deepEqual(json.summary, all.summary)
  const tail = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ filter: 'hasLiveConditionalAd', offset: 1 }))).json
  t.like(tail.page, { offset: 1, total: 5, returned: 4 })
})

test('explain_serve > a campaign or creative it cannot read leaves liveness unknown and keeps the answer', async t => {
  for (const [forbidden, which] of [['/api/campaigns/c1', 'campaign'], ['/api/creatives/cr1', 'creative']]) {
    const tools = await setup({ forbidden })
    const { header, json } = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad0' }))
    t.true(header.includes('IS eligible'), which)
    t.true(header.endsWith(`; whether the ad is live is unknown (its ${which} could not be read)`), which)
    t.like(json.offer, { verdict: 'eligible', live: null, liveUnknown: `its ${which} could not be read`, adgroup_on: true })
    t.is(json.offer.off, undefined)
    t.is(json.offer.campaign_on, which === 'creative' ? true : undefined)
  }
})

test('explain_serve > a failed lookup does not hide what was read showing the ad off', async t => {
  const tools = await setup({ liveness: true, forbidden: '/api/creatives/cr1' })
  const off = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L02-off' }))
  t.like(off.json.offer, { live: false, off: ['ad-disabled'], liveUnknown: 'its creative could not be read', campaign_on: true })
  t.true(off.header.endsWith('; the ad is NOT live (off: ad-disabled; its creative could not be read)'))
  const dormant = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L03-ad0' }))
  t.like(dormant.json.offer, { live: false, off: ['campaign-or-ad-group'], campaign_on: false })
  const hidden = await setup({ liveness: true, forbidden: '/api/campaigns/c2' })
  const unknown = parse(await call(hidden.explain_serve, { zoneId: Z0.id, adId: 'L03-ad0' }))
  t.like(unknown.json.offer, { live: null, liveUnknown: 'its campaign could not be read', adgroup_on: true })
  t.is(unknown.json.offer.off, undefined)
})

test('explain_serve > with an adId it says whether the ad is live, and what is off', async t => {
  const tools = await setup({ liveness: true })
  const live = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad0' }))
  t.true(live.header.includes('; the ad is live'))
  t.like(live.json.offer, { live: true, campaign_on: true, adgroup_on: true })
  t.is(live.json.offer.off, undefined)
  const arch = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L02-arch' }))
  t.true(arch.header.includes('IS eligible'))
  t.true(arch.header.includes('; the ad is NOT live (off: creative-archived)'))
  t.like(arch.json.offer, { verdict: 'eligible', live: false, off: ['creative-archived'] })
  const missing = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L02-nocr' }))
  t.deepEqual(missing.json.offer.off, ['creative-missing'])
  const dormant = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L03-ad0' }))
  t.like(dormant.json.offer, { live: false, off: ['campaign-or-ad-group'], campaign_on: false, adgroup_on: true })
  const native = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'L02-native' }))
  t.true(native.header.includes('is NOT eligible'))
  t.true(native.header.endsWith('; the ad is switched on, but not eligible here (see reasons)'))
  t.like(native.json.offer, { verdict: 'excluded', live: true })
  t.deepEqual(native.json.offer.reasons, ['ad-param-mismatch'])
  const group = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'L02' }))
  t.is(group.json.offer, undefined)
  t.false(group.header.includes('the ad is'))
})

test('get_zone_eligible_ad_groups > the ad excluded by template params is not an in-scope offer', async t => {
  const tools = await setup()
  const { json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  const g13 = json.freeRadicals.find((r) => r.id === 'G13')
  t.like(g13.offers, { total: 2, inScope: 1, freeRadical: 1 })
  const t1 = json.directlyTargeted.find((r) => r.id === 'T1')
  t.is(t1.has_live_viable_ad, false) // its only ad excludes the zone template
})

test('no visit input > the three tools refuse request / requestComplete', t => {
  return setup().then((tools) => {
    const parse = (tool, args) => tools[tool].inputSchema.safeParse({ network_id: NET, ...args }).success
    t.false(parse('get_zone_eligible_ad_groups', { zoneId: Z0.id, request: { device: 'mobile' } }))
    t.false(parse('explain_serve', { zoneId: Z0.id, adGroupId: 'G05', requestComplete: true }))
    t.false(parse('get_ad_group_zone_reach', { adGroupId: 'G01', request: {} }))
    t.true(parse('get_ad_group_zone_reach', { adGroupId: 'G01' }))
  })
})

test('explain_serve > a zone-default blacklist names the default and that a visit could change it', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G09' }))
  t.is(header, `ad group G09 (G09) is NOT eligible in zone Z0 (${Z0.id}) — param-blacklisted: templateId (zone default ${T0}; a visit overriding templateId would change this)`)
  t.is(json.verdict, 'excluded')
  t.is(json.eligible, false)
})

test('explain_serve > a visitor whitelist and a visitor blacklist read as CONDITIONAL', async t => {
  const tools = await setup()
  const only = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G05' }))
  t.is(only.header, `ad group G05 (G05) is CONDITIONAL in zone Z0 (${Z0.id}) — only for visits where device ∈ [mobile]`)
  t.is(only.json.verdict, 'conditional')
  const except = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G06' }))
  t.true(except.header.endsWith('serves except for visits where device ∈ [mobile]'))
})

test('explain_serve > at the offer grain, the blocked G13 ad is excluded and its sibling is a free radical', async t => {
  const tools = await setup()
  const blocked = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad1' }))
  t.true(blocked.header.startsWith('ad G13-ad1 is NOT eligible in zone Z0'))
  t.true(blocked.header.includes('param-blacklisted: templateId'))
  t.like(blocked.json.offer, { verdict: 'excluded', freeRadical: false })
  t.deepEqual(blocked.json.reasons, ['ad-param-blacklisted'])
  const plain = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad0' }))
  t.true(plain.header.includes('IS eligible'))
  t.true(plain.json.offer.freeRadical)
})

test('get_ad_group_zone_reach > G01 serves in Z0 only; Z1 is out on its template default', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.get_ad_group_zone_reach, { adGroupId: 'G01' }))
  t.deepEqual(json.zones.map((z) => z.zoneId), [Z0.id])
  t.deepEqual(json.excludedByDefault.map((z) => z.zoneId), [Z1.id])
  t.deepEqual(json.summary, { reaches: 1, targeted: 0, freeRadical: 1, conditional: 0, excludedByDefault: 1 })
  t.true(header.includes('1 excluded by a zone default'))
})

test('get_ad_group_zone_reach > a conditional group reaches zones on some traffic, counted apart from reaches', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.get_ad_group_zone_reach, { adGroupId: 'G05' }))
  t.like(json.summary, { reaches: 0, conditional: 2 })
  t.deepEqual(json.zones.map((z) => [z.zoneId, z.verdict]), [[Z0.id, 'conditional'], [Z1.id, 'conditional']])
  t.is(json.request, undefined)
  t.true(header.includes('2 conditional'))
})

test('get_zone_targeting_inventory > the row set is unchanged; has_live_viable_ad honours ad-level params', async t => {
  const tools = await setup()
  const { json } = parse(await call(tools.get_zone_targeting_inventory, { zoneId: Z0.id, mode: 'all' }))
  t.deepEqual(json.groups.map((g) => g.id).sort(), ['G09', 'T1'])
  const byId = new Map(json.groups.map((g) => [g.id, g]))
  t.is(byId.get('G09').fully_live, true) // a group-level params block is the eligibility tool's to report
  t.is(byId.get('T1').has_live_viable_ad, false)
  t.deepEqual(byId.get('T1').off_reason, ['no_live_viable_ad'])
})

test('channel fetches > each tool asks for the zone channel, and reach lists the network channels', async t => {
  const tools = await setup()
  await call(tools.get_zone_eligible_ad_groups, eligible())
  await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G00' })
  await call(tools.get_zone_targeting_inventory, { zoneId: Z0.id, mode: 'all' })
  await call(tools.get_ad_group_zone_reach, { adGroupId: 'G01' })
  t.is(tools.calls.filter((c) => c.path === '/api/channels/ch1').length, 3)
  t.deepEqual(tools.calls.filter((c) => c.path === '/api/channels'), [{ method: 'GET', path: '/api/channels', networkId: NET }])
})

test('network scope > every list GET carries the network id, and no get-by-id does', async t => {
  const tools = await setup()
  await call(tools.get_zone_eligible_ad_groups, eligible())
  await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad1' })
  await call(tools.get_zone_targeting_inventory, { zoneId: Z0.id, mode: 'all' })
  await call(tools.get_ad_group_zone_reach, { adGroupId: 'G01' })
  const lists = new Set(['/api/zones', '/api/ad-groups', '/api/campaigns', '/api/ads', '/api/creatives', '/api/channels'])
  const listCalls = tools.calls.filter((c) => lists.has(c.path))
  t.true(listCalls.length >= 6)
  for (const c of listCalls) t.is(c.networkId, NET, c.path)
  for (const c of tools.calls.filter((c) => !lists.has(c.path))) t.is(c.networkId, undefined, c.path)
})

test('refused zone > all four zone tools answer that the ad server refuses every visit', async t => {
  const tools = await setup()
  const texts = await Promise.all([
    call(tools.get_zone_eligible_ad_groups, eligible({ zoneId: ZR.id })),
    call(tools.explain_serve, { zoneId: ZR.id, adGroupId: 'G00' }),
    call(tools.get_zone_targeting_inventory, { zoneId: ZR.id, mode: 'all' })
  ]).then((rs) => rs.map((r) => r.content[0].text))
  for (const text of texts) t.true(text.includes("Zone or segments don't match allowlist/blocklist criteria"))
  t.is(texts[0], texts[1])
  t.is(texts[1], texts[2])
})

test('refused zone > reach skips it and names it', async t => {
  const tools = await setup()
  const { json } = parse(await call(tools.get_ad_group_zone_reach, { adGroupId: 'G00' }))
  t.false(json.zones.some((z) => z.zoneId === ZR.id))
  t.deepEqual(json.scan.refusedZonesSkipped, [ZR.id])
})

test('explain_serve > a pair whose rules never hold together names the key', async t => {
  const { explainHeader } = await import('../tools/zoneEligibilityTools.js')
  const header = explainHeader('ad a1', { id: Z0.id, name: 'Z0' }, { verdict: 'excluded', reasons: ['conditions-contradict'], contradiction: 'device', conditions: [], paramBlocks: [] })
  t.is(header, `ad a1 is NOT eligible in zone Z0 (${Z0.id}) — conditions-contradict: device (no single visit meets every rule on it)`)
})

test('channel fetches > a missing channel refuses the zone in every zone tool, as lincx-core does', async t => {
  const tools = await setup({ channel: false })
  const texts = await Promise.all([
    call(tools.get_zone_eligible_ad_groups, eligible()),
    call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G00' }),
    call(tools.get_zone_targeting_inventory, { zoneId: Z0.id, mode: 'all' })
  ]).then((rs) => rs.map((r) => r.content[0].text))
  for (const text of texts) t.true(text.includes('points at channel ch1, which does not exist'))
  t.is(texts[0], texts[1])
  t.is(texts[1], texts[2])
  const { json } = parse(await call(tools.get_ad_group_zone_reach, { adGroupId: 'G00' }))
  t.deepEqual(json.zones, [])
  t.deepEqual(json.scan.missingChannelZonesSkipped.sort(), [Z0.id, Z1.id, ZR.id].sort())
})

test('channel fetches > a channel lookup failing for any other reason is an error, not a guess', async t => {
  const tools = await setup({ channelError: 503 })
  for (const r of [
    await call(tools.get_zone_eligible_ad_groups, eligible()),
    await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G00' }),
    await call(tools.get_zone_targeting_inventory, { zoneId: Z0.id, mode: 'all' })
  ]) t.is(r.content[0].text, 'Error: HTTP 503')
})

test('explain_serve > a group that cannot reach the zone gets no params blocks', async t => {
  const tools = await setup()
  const { header } = parse(await call(tools.explain_serve, { zoneId: Z1.id, adGroupId: 'T1' }))
  t.is(header, `ad group T1 (T1) is NOT eligible in zone Z1 (${Z1.id}) — targets-other-zones`)
})

test('explain_serve > reports blacklisted, never a bare excluded beside verdict', async t => {
  const tools = await setup()
  const { json } = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G09' }))
  t.is(json.excluded, undefined)
  t.is(json.blacklisted, false)
  t.is(json.verdict, 'excluded')
})

test('explain_serve > an eligible row that rests on a zone default says so', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G03' }))
  t.is(header, `ad group G03 (G03) IS eligible in zone Z0 (${Z0.id}) — via zone-selection; holds only while the visit leaves s1 at its zone default abc`)
  t.is(json.contradiction, undefined)
  const plain = parse(await call(tools.explain_serve, { zoneId: Z0.id, adGroupId: 'G00' }))
  t.false(plain.header.includes('holds only'))
})

test('refused default visits > the zone tools answer with rows and say the default visit is refused', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ zoneId: ZD.id })))
  t.true(header.includes("refuses every visit that keeps this zone's defaults"))
  t.true(header.includes('only visits overriding s1 are served, so s1 is judged as a visit key'))
  t.is(json.zone.refusesDefaultVisits, true)
  t.deepEqual(json.zone.overriddenOnServedVisits, ['s1'])
  t.is(json.freeRadicals.find((r) => r.id === 'G03').verdict, 'conditional')
  t.true(json.freeRadicals.length > 0)
  const ex = parse(await call(tools.explain_serve, { zoneId: ZD.id, adGroupId: 'G00' }))
  t.true(ex.header.includes("refuses every visit that keeps this zone's defaults"))
  const inv = parse(await call(tools.get_zone_targeting_inventory, { zoneId: ZD.id, mode: 'all' }))
  t.true(inv.header.includes("refuses every visit that keeps this zone's defaults"))
  const plain = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  t.is(plain.json.zone.refusesDefaultVisits, undefined)
})

test('explain_serve > a segment-sourced match names the segment pick, not a default', async t => {
  const { explainHeader } = await import('../tools/zoneEligibilityTools.js')
  const header = explainHeader('ad group g', { id: 'z', name: 'Z' }, { verdict: 'eligible', path: 'zone-selection', matchedKeys: [{ path: 'params.templateId', key: 'templateId', value: [T1], source: 'segment' }] })
  t.is(header, `ad group g IS eligible in zone Z (z) — via zone-selection; holds only while the visit lands on a segment with template ${T1} (a visit naming another templateId, or pinning a segmentId with another template, changes it)`)
})

test('pinned-only zone > the zone tools return rows and say only pinned visits are served', async t => {
  const tools = await setup()
  const { header, json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ zoneId: ZP.id })))
  t.true(header.includes('only a visit pinning a segmentId'))
  t.is(json.zone.servesOnlyPinnedVisits, true)
  t.true(json.freeRadicals.length > 0)
  for (const r of [
    await call(tools.explain_serve, { zoneId: ZP.id, adGroupId: 'G00' }),
    await call(tools.get_zone_targeting_inventory, { zoneId: ZP.id, mode: 'all' })
  ]) t.true(r.content[0].text.includes('only a visit pinning a segmentId'))
})

test('unserved share (#92) > the zone tools return rows, flag the share and say it in the header', async t => {
  const tools = await setup({ withZU: true })
  const { header, json } = parse(await call(tools.get_zone_eligible_ad_groups, eligible({ zoneId: ZU.id })))
  t.like(json.zone.unservedShare, { min: 30, max: 30, atDefaults: 30, zoneRules: [{ key: 'zoneType', op: 'requires', values: ['Other'], source: 'zone', actual: 'Display' }] })
  t.true(header.includes('NOTE: 30% of the visits that do not pin a segmentId get no ad at all. It happens only on visits where zoneType is Display (the zone sets it, and its allowlist needs Other — so every visit): on those the zone fails its own allowlist/blocklist'))
  t.true(header.endsWith('the rows below describe only the served visits'))
  t.true(json.freeRadicals.length > 0)
  for (const r of [
    await call(tools.explain_serve, { zoneId: ZU.id, adGroupId: 'G00' }),
    await call(tools.get_zone_targeting_inventory, { zoneId: ZU.id, mode: 'all' })
  ]) t.true(r.content[0].text.includes('30% of the visits that do not pin a segmentId get no ad at all'))
  const explained = parse(await call(tools.explain_serve, { zoneId: ZU.id, adGroupId: 'G00' })).header
  t.true(explained.endsWith('this answer describes only the served visits'))
  const plain = parse(await call(tools.get_zone_eligible_ad_groups, eligible()))
  t.is(plain.json.zone.unservedShare, undefined)
  t.false(plain.header.includes('get no ad at all'))
  const reach = parse(await call(tools.get_ad_group_zone_reach, { adGroupId: 'G00' })).json
  t.like(reach.zones.find((z) => z.zoneId === ZU.id).unservedShare, { min: 30, max: 30, atDefaults: 30 })
  t.is(reach.zones.find((z) => z.zoneId === Z0.id).unservedShare, undefined)
})

test('channel fetches > reach looks up a channel the list hides before calling it missing', async t => {
  const visible = parse(await call((await setup({ hiddenFromList: true })).get_ad_group_zone_reach, { adGroupId: 'G00' })).json
  t.true(visible.zones.some((z) => z.zoneId === Z0.id))
  t.deepEqual(visible.scan.missingChannelZonesSkipped, [])
  const forbidden = parse(await call((await setup({ hiddenFromList: true, channelError: 403 })).get_ad_group_zone_reach, { adGroupId: 'G00' })).json
  t.deepEqual(forbidden.scan.unreadableChannelZonesSkipped.sort(), [Z0.id, Z1.id, ZR.id].sort())
  t.deepEqual(forbidden.scan.missingChannelZonesSkipped, [])
})

test('explain_serve > with an adId the top level carries the pair\'s rules, group and ad together', async t => {
  const tools = await setup()
  const cond = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G00-ad1' }))
  t.is(cond.json.verdict, 'conditional')
  t.deepEqual(cond.json.conditions.map((c) => c.key), ['deviceOs'])
  t.deepEqual(cond.json.offer.conditions.map((c) => c.key), ['deviceOs'])
  t.true(cond.header.includes('only for visits where deviceOs ∈ [ios]'))
  const blocked = parse(await call(tools.explain_serve, { zoneId: Z0.id, adId: 'G13-ad1' }))
  t.is(blocked.json.verdict, 'excluded')
  t.deepEqual(blocked.json.paramBlocks.map((b) => b.key), ['templateId'])
  t.is(blocked.json.contradiction, undefined)
  t.true(blocked.json.excludedByDefault) // the ad's block is on the zone's default template
})

test('explain_serve > the pair is excluded by default only when every cause could be lifted by a visit', async t => {
  const { pairExcludedByDefault } = await import('../tools/zoneEligibilityTools.js')
  const E = await import('../tools/eligibility.js')
  const request = E.zoneRequest(Z0, CHANNEL)
  const groupOf = (params) => E.eligibility({ adGroup: { id: 'g', creativeAssetGroupId: CAG, params }, zone: Z0, request })
  const judge = (group, ad) => pairExcludedByDefault({ group, ad: E.adVerdict(ad, Z0.id, request), request })
  const inScope = groupOf({})
  const byDefault = groupOf({ s1: ['xyz'] }) // blocked only by the s1 default
  const hard = groupOf({ zoneType: ['Other'] }) // blocked on a zone-fixed key
  // ad blocked only on the zone's default template → a visit could lift it
  t.true(judge(inScope, { id: 'a', exceptParams: { templateId: [T0] } }))
  t.true(judge(byDefault, { id: 'a' }))
  // the ad itself can never serve here, whatever the group
  for (const ad of [
    { id: 'bl', exceptParams: { zoneId: [Z0.id] } },
    { id: 'away', params: { zoneId: ['OTHER'] } },
    { id: 'clash', params: { device: ['mobile'] }, exceptParams: { device: ['mobile'] } },
    { id: 'fixed', params: { zoneType: ['Other'] } }
  ]) {
    t.false(judge(inScope, ad), ad.id)
    t.false(judge(byDefault, ad), `default group + ${ad.id}`)
  }
  t.false(judge(hard, { id: 'a' }))
  // group and ad rules that never hold together
  t.false(judge(groupOf({ device: ['mobile'], s1: ['xyz'] }), { id: 'never', exceptParams: { device: ['mobile'] } }))
})
