import test from 'ava'
import { selectTargeting, rollupZoneTargeting, fitZoneInventory } from '../tools/zoneInventoryTools.js'

const ZONE = '8z7wzb'
const CAG = '0bckt2'

const ag = (over = {}) => ({
  id: 'ag1',
  name: 'AG1',
  enabled: true,
  params: { zoneId: [ZONE] },
  campaignId: 'c1',
  creativeAssetGroupId: CAG,
  ...over
})

{ // selectTargeting
  test('selectTargeting > keeps groups whose params.zoneId includes the zone', t => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: 'a' }), ag({ id: 'b', params: { zoneId: ['other'] } })], ZONE)
    t.deepEqual(targeted.map((g) => g.id), ['a'])
    t.deepEqual(conflicting, [])
  })
  test('selectTargeting > ignores a group with the zone only in exceptParams', t => {
    const { targeted } = selectTargeting(
      [ag({ id: 'x', params: { zoneId: ['other'] }, exceptParams: { zoneId: [ZONE] } })], ZONE)
    t.deepEqual(targeted, [])
  })
  test('selectTargeting > flags zone-in-both as conflicting, not targeted', t => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: 'y', params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } })], ZONE)
    t.deepEqual(targeted, [])
    t.deepEqual(conflicting.map((g) => g.id), ['y'])
  })
}

const base = (over = {}) =>
  rollupZoneTargeting({
    zoneId: ZONE,
    zoneCag: CAG,
    targeted: [ag()],
    conflicting: [],
    campaigns: { c1: { enabled: true } },
    adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1' }] },
    creatives: { cr1: {} },
    mode: 'all',
    ...over
  })

{ // rollupZoneTargeting
  test('rollupZoneTargeting > fully_live when campaign, ad group, and a live+viable ad are all on', t => {
    const { groups, summary } = base()
    t.is(groups[0].fully_live, true)
    t.deepEqual(groups[0].off_reason, [])
    t.like(summary, { targeted: 1, live: 1, off: 0 })
  })
  test('rollupZoneTargeting > campaign off → off_reason names campaign', t => {
    const { groups } = base({ campaigns: { c1: { enabled: false } } })
    t.is(groups[0].campaign_on, false)
    t.is(groups[0].fully_live, false)
    t.deepEqual(groups[0].off_reason, ['campaign'])
  })
  test('rollupZoneTargeting > ad group enabled but archived → forced off, off_reason names archived', t => {
    const { groups, summary } = base({ targeted: [ag({ enabled: true, archived: true })] })
    t.is(groups[0].archived, true)
    t.is(groups[0].adgroup_on, false)
    t.deepEqual(groups[0].off_reason, ['archived'])
    t.is(summary.archived, 1)
  })
  test('rollupZoneTargeting > per-ad conjunction: enabled ad w/ dangling creative + disabled ad w/ valid creative → NOT live-viable', t => {
    const { groups } = base({
      adsByGroup: {
        ag1: [
          { id: 'ad1', enabled: true, creativeId: 'missing' },
          { id: 'ad2', enabled: false, creativeId: 'cr1' }
        ]
      },
      creatives: { cr1: {} }
    })
    t.is(groups[0].has_enabled_ad, true)
    t.is(groups[0].creative_resolves, true)
    t.is(groups[0].has_live_viable_ad, false)
    t.deepEqual(groups[0].off_reason, ['no_live_viable_ad'])
  })
  test('rollupZoneTargeting > archived creative does not count as viable', t => {
    const { groups } = base({ creatives: { cr1: { archived: true } } })
    t.is(groups[0].has_live_viable_ad, false)
  })
  test('rollupZoneTargeting > archived ad is not a live ad', t => {
    const { groups } = base({ adsByGroup: { ag1: [{ id: 'ad1', enabled: true, archived: true, creativeId: 'cr1' }] } })
    t.is(groups[0].has_live_viable_ad, false)
  })
  test('rollupZoneTargeting > mode \'off\' returns only not-fully-live rows', t => {
    const { groups } = base({
      targeted: [ag({ id: 'ag1' }), ag({ id: 'ag2', campaignId: 'c2' })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1' }],
        ag2: [{ id: 'ad2', enabled: true, creativeId: 'cr1' }]
      },
      mode: 'off'
    })
    t.deepEqual(groups.map((g) => g.id), ['ag2'])
  })
  test('rollupZoneTargeting > scoped_via: a plain whitelisted group (different CAG, no ad-level whitelist) is ad-group-whitelist only', t => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: 'other' })],
      adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1' }] }
    })
    t.deepEqual(groups[0].scoped_via, ['ad-group-whitelist'])
  })
  test('rollupZoneTargeting > scoped_via: an ad in the group also whitelisting the zone adds ad-level-whitelist', t => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: 'other' })],
      adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1', params: { zoneId: [ZONE] } }] }
    })
    t.deepEqual(groups[0].scoped_via, ['ad-group-whitelist', 'ad-level-whitelist'])
  })
  test('rollupZoneTargeting > scoped_via: a group sharing the zone\'s CAG adds zone-selection', t => {
    const { groups } = base({ targeted: [ag({ creativeAssetGroupId: CAG })] })
    t.deepEqual(groups[0].scoped_via, ['ad-group-whitelist', 'zone-selection'])
  })
  test('rollupZoneTargeting > scoped_via: all three when ad-level whitelist and CAG both apply', t => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: CAG })],
      adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1', params: { zoneId: [ZONE] } }] }
    })
    t.deepEqual(groups[0].scoped_via, ['ad-group-whitelist', 'ad-level-whitelist', 'zone-selection'])
  })
  test('rollupZoneTargeting > scoped_via: an ad excluding the zone adds ad-level-blacklist', t => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: 'other' })],
      adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1', exceptParams: { zoneId: [ZONE] } }] }
    })
    t.deepEqual(groups[0].scoped_via, ['ad-group-whitelist', 'ad-level-blacklist'])
  })

  test('rollupZoneTargeting > per-ad zone check: an enabled+viable ad blacklisted from the zone does NOT make the group live there', t => {
    const { groups } = base({
      adsByGroup: { ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1', exceptParams: { zoneId: [ZONE] } }] }
    })
    t.is(groups[0].has_live_viable_ad, false)
    t.true(groups[0].off_reason.includes('no_live_viable_ad'))
  })
  test('rollupZoneTargeting > per-ad zone check: a sibling ad that DOES serve keeps the group live', t => {
    const { groups } = base({
      adsByGroup: {
        ag1: [
          { id: 'ad1', enabled: true, creativeId: 'cr1', exceptParams: { zoneId: [ZONE] } }, // hidden here
          { id: 'ad2', enabled: true, creativeId: 'cr1' } // serves
        ]
      }
    })
    t.is(groups[0].has_live_viable_ad, true)
    t.is(groups[0].fully_live, true)
  })

  test('rollupZoneTargeting > summary counts are over the full targeted set regardless of mode filter', t => {
    const { summary } = base({
      targeted: [ag({ id: 'ag1' }), ag({ id: 'ag2', campaignId: 'c2' })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: 'ad1', enabled: true, creativeId: 'cr1' }],
        ag2: [{ id: 'ad2', enabled: true, creativeId: 'cr1' }]
      },
      mode: 'live'
    })
    t.like(summary, { targeted: 2, live: 1, off: 1 })
  })
}

// N off rows with realistic-length names.
const makeInventory = (n) => {
  const groups = Array.from({ length: n }, (_, i) => ({
    id: `adg${String(i).padStart(4, '0')}`,
    name: `Some Advertiser ${i} - Refinance - QL LRE Match [Exchange]`,
    archived: false,
    campaign_on: false,
    adgroup_on: true,
    has_enabled_ad: true,
    creative_resolves: true,
    has_live_viable_ad: true,
    fully_live: false,
    off_reason: ['campaign']
  }))
  return {
    zone: { id: '8z7wzb', name: 'Quicken Loans Refinance - Match', creativeAssetGroupId: '0bckt2', templateId: 'ayf1pr' },
    mode: 'all',
    summary: { targeted: n, live: 0, off: n, archived: 0, conflicting: 0 },
    groups,
    conflicting: [],
    scan: { adGroupsScanned: 1150, campaignsScanned: 664, adsScanned: 1331, creativesScanned: 1343 }
  }
}

// The rollup rides in content text: "<header>\n\n<compact JSON>". Parse the JSON
// the way the model must — this is the model-visible channel (structuredContent is
// not surfaced by MCP hosts).
const payload = (r

) => JSON.parse(r.content[0].text.split('\n\n').slice(1).join('\n\n'))

{ // fitZoneInventory (never drops ad groups, data in text)
  test('fitZoneInventory (never drops ad groups, data in text) > carries the rollup in content text, not structuredContent', t => {
    const r = fitZoneInventory(makeInventory(3), 30_000)
    t.is(r.structuredContent, undefined) // hosts don't surface it
    const s = payload(r)
    t.is(s.groups.length, 3)
  })

  test('fitZoneInventory (never drops ad groups, data in text) > returns every row with names when it fits, complete:true', t => {
    const r = fitZoneInventory(makeInventory(83), 30_000)
    const s = payload(r)
    t.is(s.complete, true)
    t.is(s.namesOmitted, undefined)
    t.is(s.groups.length, 83)
    t.truthy(s.groups[0].name)
    t.true(JSON.stringify(r).length <= 30_000)
  })

  test('fitZoneInventory (never drops ad groups, data in text) > 83 rows fit under the 30k guard — the reported truncation is gone', t => {
    const r = fitZoneInventory(makeInventory(83), 30_000)
    const s = payload(r)
    t.is(s.namesOmitted, undefined)
    t.is(s.groups.length, 83)
    t.true(JSON.stringify(r).length < 30_000)
  })

  test('fitZoneInventory (never drops ad groups, data in text) > sheds names (not rows) when the full form overflows but ids+flags still fit', t => {
    const inv = makeInventory(83)
    const full = JSON.stringify(fitZoneInventory(inv, 10_000_000)).length // uncapped size
    const limit = full - 1 // just below full → sheds names (stripped is smaller, fits)
    const r = fitZoneInventory(inv, limit)
    const s = payload(r)
    t.is(s.complete, true)
    t.is(s.namesOmitted, true)
    t.is(s.groups.length, 83) // every ad group still present
    t.is((s.groups[0]).name, undefined)
    t.truthy(s.groups[0].id)
    t.true(JSON.stringify(r).length <= limit)
  })

  test('fitZoneInventory (never drops ad groups, data in text) > only as a last resort returns ids-only with complete:false — never a silent partial', t => {
    const r = fitZoneInventory(makeInventory(2000), 5_000)
    const s = payload(r)
    t.is(s.complete, false)
    t.is(s.groups, undefined)
    t.is(s.groupIds.length, 2000) // every id accounted for
    t.regex(r.content[0].text, /INCOMPLETE/)
  })
}
