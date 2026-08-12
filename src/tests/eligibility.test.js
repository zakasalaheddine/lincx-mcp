import test from 'ava'
import {
  eligibility, adServesInZone, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  SCOPED_VIA

} from '../tools/eligibility.js'
import { rollupZoneTargeting, selectTargeting } from '../tools/zoneInventoryTools.js'
import { summarizeEligibility } from '../tools/zoneEligibilityTools.js'

const ZONE = '8z7wzb'
const CAG = '0bckt2'
const zone = { id: ZONE, creativeAssetGroupId: CAG }

// offerRollup's liveness predicate is injected (it needs campaign/creative rows this
// module never reads). LIVE/DARK pin the two ends so a count can't pass by default:
// the targeting-grain tests below use LIVE, and the live-axis tests use both.
const LIVE = () => true
const DARK = () => false

const input = (adGroup, ads = []) => ({
  adGroup: { id: 'ag1', creativeAssetGroupId: CAG, ...adGroup },
  zone,
  ads
})

{ // eligibility
  test('eligibility > free radical: targets zero zones + CAG match → eligible via zone-selection only', t => {
    const e = eligibility(input({ params: {} }))
    t.is(e.eligible, true)
    t.deepEqual(e.via, ['zone-selection'])
    t.is(e.excluded, false)
    t.deepEqual(e.reasons, [])
    t.deepEqual(e.conflicts, [])
  })

  test('eligibility > directly whitelisted + CAG match → eligible, via ad-group-whitelist + zone-selection', t => {
    const e = eligibility(input({ params: { zoneId: [ZONE] } }))
    t.is(e.eligible, true)
    t.deepEqual(e.via, ['ad-group-whitelist', 'zone-selection'])
  })

  test('eligibility > targets a DIFFERENT zone (same CAG) → not eligible, targets-other-zones', t => {
    const e = eligibility(input({ params: { zoneId: ['other1', 'other2'] } }))
    t.is(e.eligible, false)
    t.deepEqual(e.reasons, ['targets-other-zones'])
    t.deepEqual(e.via, ['zone-selection']) // CAG still matches, just not scoped in
  })

  test('eligibility > blacklist wins: zone in exceptParams → excluded even with a whitelist', t => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }))
    t.is(e.eligible, false)
    t.is(e.excluded, true)
    t.true(e.reasons.includes('blacklisted'))
    t.true(e.conflicts.includes('targets-and-excepts'))
  })

  test('eligibility > CAG mismatch with a whitelist → not eligible, cag-mismatch + whitelisted-cag-mismatch conflict', t => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, creativeAssetGroupId: 'other' }))
    t.is(e.eligible, false)
    t.true(e.reasons.includes('cag-mismatch'))
    t.deepEqual(e.conflicts, ['whitelisted-cag-mismatch'])
  })

  test('eligibility > ad-level params do NOT decide group eligibility (per-ad is a later check): an ad whitelisting the zone can\'t make a group that targets other zones eligible', t => {
    const e = eligibility(input({ params: { zoneId: ['other'] } }, [{ id: 'ad1', params: { zoneId: [ZONE] } }]))
    t.is(e.eligible, false)
    t.deepEqual(e.reasons, ['targets-other-zones'])
    t.deepEqual(e.via, ['zone-selection']) // no ad-level-whitelist in group via
  })

  test('eligibility > archived ad group is never eligible (out of service), even if whitelisted + CAG match', t => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, archived: true }))
    t.is(e.eligible, false)
    t.deepEqual(e.reasons, ['archived'])
  })

  test('eligibility > free radical only within its CAG: zero zones but CAG mismatch → not eligible', t => {
    const e = eligibility(input({ params: {}, creativeAssetGroupId: 'other' }))
    t.is(e.eligible, false)
    t.deepEqual(e.reasons, ['cag-mismatch'])
    t.deepEqual(e.via, [])
  })
}

{ // adServesInZone (per-ad last targeting check)
  test('adServesInZone (per-ad last targeting check) > ad with no params serves wherever its group is eligible', t => {
    t.is(adServesInZone({ id: 'a' }, ZONE), true)
  })
  test('adServesInZone (per-ad last targeting check) > ad blacklisting the zone does not serve there (its siblings still do)', t => {
    t.is(adServesInZone({ id: 'a', exceptParams: { zoneId: [ZONE] } }, ZONE), false)
  })
  test('adServesInZone (per-ad last targeting check) > ad whitelisting only other zones is confined there → does not serve here', t => {
    t.is(adServesInZone({ id: 'a', params: { zoneId: ['other'] } }, ZONE), false)
  })
  test('adServesInZone (per-ad last targeting check) > ad whitelisting this zone serves here', t => {
    t.is(adServesInZone({ id: 'a', params: { zoneId: [ZONE] } }, ZONE), true)
  })
}

{ // zoneEligibility (zone → groups, bucketed by scoping)
  const groups = [
    { id: 'direct', creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } }, // whitelisted, eligible
    { id: 'radical', creativeAssetGroupId: CAG, params: {} }, // free radical
    { id: 'other', creativeAssetGroupId: CAG, params: { zoneId: ['z9'] } }, // scoped out → dropped
    { id: 'wrongcag', creativeAssetGroupId: 'x', params: {} }, // not eligible → dropped
    { id: 'cagmiss', creativeAssetGroupId: 'x', params: { zoneId: [ZONE] } }, // whitelisted but CAG mismatch
    { id: 'both', creativeAssetGroupId: CAG, params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } } // targets+excepts
  ]

  test('zoneEligibility (zone → groups, bucketed by scoping) > directlyTargeted = ad-group-whitelisted & not blacklisted (reconciles to the inventory 83), incl. CAG-mismatch', t => {
    const r = zoneEligibility(groups, zone, {})
    t.deepEqual(r.directlyTargeted.map((e) => e.adGroupId).sort(), ['cagmiss', 'direct'])
  })
  test('zoneEligibility (zone → groups, bucketed by scoping) > keeps a whitelisted-but-ineligible group in directlyTargeted with its conflict surfaced (no silent drop)', t => {
    const r = zoneEligibility(groups, zone, {})
    const cm = r.directlyTargeted.find((e) => e.adGroupId === 'cagmiss')
    t.is(cm.eligible, false)
    t.deepEqual(cm.conflicts, ['whitelisted-cag-mismatch'])
  })
  test('zoneEligibility (zone → groups, bucketed by scoping) > freeRadicals = eligible but not ad-group-whitelisted', t => {
    const r = zoneEligibility(groups, zone, {})
    t.deepEqual(r.freeRadicals.map((e) => e.adGroupId), ['radical'])
  })
  test('zoneEligibility (zone → groups, bucketed by scoping) > targets-and-excepts goes to conflicting, not directlyTargeted', t => {
    const r = zoneEligibility(groups, zone, {})
    t.deepEqual(r.conflicting.map((e) => e.adGroupId), ['both'])
    t.true(r.conflicting[0].conflicts.includes('targets-and-excepts'))
    t.false(r.directlyTargeted.map((e) => e.adGroupId).includes('both'))
  })

  /**
   * The A1 reconciliation with `conflicting` NON-EMPTY — the case production data
   * cannot reach (an exhaustive 1150-group sweep of network 7jdz0n on 2026-08-04
   * found no ad group naming the same zone in params.zoneId and exceptParams.zoneId).
   *
   * Note the exact identity: the two tools bucket a conflicting group the SAME way,
   * so it is in NEITHER tool's targeted set. `directlyTargeted + conflicting ==
   * inventory groups[]` therefore only holds while conflicting is 0 — the honest
   * invariant is per-bucket set equality.
   */
  test('zoneEligibility (zone → groups, bucketed by scoping) > A1 — the two tools agree bucket-for-bucket when conflicting is non-empty', t => {
    const { targeted, conflicting } = selectTargeting(groups, ZONE)
    const r = zoneEligibility(groups, zone, {})

    const ids = (xs) =>
      xs.map((x) => x.id ?? x.adGroupId).sort()

    t.deepEqual(ids(r.directlyTargeted), ids(targeted)) // same targeted set
    t.deepEqual(ids(r.conflicting), ids(conflicting)) // same conflicting set
    t.true(r.conflicting.length > 0) // the case prod can't reach
    // Disjoint: a group is never in both buckets.
    t.deepEqual(ids(r.directlyTargeted).filter((id) => ids(r.conflicting).includes(id)), [])
    // And the sum identity as usually stated holds only because the inventory tool
    // reports conflicting separately from groups[] — assert both halves, not the sum.
    t.is(r.directlyTargeted.length + r.conflicting.length, targeted.length + conflicting.length)
  })
}

{ // offerEligibility (ad group × ad grain)
  const untargeted = { id: 'ag', creativeAssetGroupId: CAG, params: {} }
  const verdict = (adGroup) => eligibility({ adGroup, zone, ads: [] })

  test('offerEligibility (ad group × ad grain) > untargeted ad under an untargeted group → free radical (serves via shared CAG only)', t => {
    const o = offerEligibility(verdict(untargeted), untargeted, { id: 'ad1' }, zone)
    t.is(o.serves, true)
    t.is(o.freeRadical, true)
    t.deepEqual(o.scoped_via, ['zone-selection'])
  })

  test('offerEligibility (ad group × ad grain) > zone-whitelisted ad under an untargeted group → ad-level-TARGETED, NOT a free radical', t => {
    const ad = { id: 'ad1', params: { zoneId: [ZONE] } }
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone)
    t.is(o.serves, true)
    t.is(o.freeRadical, false)
    t.deepEqual(o.scoped_via, ['ad-level-whitelist', 'zone-selection'])
  })

  test('offerEligibility (ad group × ad grain) > ad-level blacklist excludes the offer even under an eligible untargeted group', t => {
    const ad = { id: 'ad1', exceptParams: { zoneId: [ZONE] } }
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone)
    t.is(o.serves, false)
    t.is(o.freeRadical, false)
    t.true(o.scoped_via.includes('ad-level-blacklist'))
    t.true(o.reasons.includes('ad-blacklisted'))
  })

  test('offerEligibility (ad group × ad grain) > ad confined to other zones → does not serve, not a free radical', t => {
    const ad = { id: 'ad1', params: { zoneId: ['other'] } }
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone)
    t.is(o.serves, false)
    t.true(o.reasons.includes('ad-targets-other-zones'))
  })

  test('offerEligibility (ad group × ad grain) > group ineligible → no offer serves, even if the ad whitelists the zone (filterAdgroups runs first)', t => {
    const scopedOut = { id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: ['other'] } }
    const o = offerEligibility(verdict(scopedOut), scopedOut, { id: 'ad1', params: { zoneId: [ZONE] } }, zone)
    t.is(o.serves, false)
    t.deepEqual(o.reasons, ['targets-other-zones'])
  })

  test('offerEligibility (ad group × ad grain) > offer under a directly-targeted group is never a free radical', t => {
    const direct = { id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } }
    const o = offerEligibility(verdict(direct), direct, { id: 'ad1' }, zone)
    t.is(o.serves, true)
    t.is(o.freeRadical, false)
    t.deepEqual(o.scoped_via, ['ad-group-whitelist', 'zone-selection'])
  })
}

{ // offerRollup (the over-count the group grain hides)
  const untargeted = { id: 'ag', creativeAssetGroupId: CAG, params: {} }
  const v = eligibility({ adGroup: untargeted, zone, ads: [] })

  test('offerRollup (the over-count the group grain hides) > untargeted group whose ONLY ad is zone-whitelisted → free-radical GROUP but 0 free-radical offers', t => {
    const r = offerRollup(v, untargeted, [{ id: 'ad1', params: { zoneId: [ZONE] } }], zone, LIVE)
    t.is(v.eligible, true) // group grain still counts it
    t.is(r.freeRadical, 0)
    t.is(r.adLevelTargeted, 1)
    t.is(r.inScope, 1)
    t.deepEqual(r.freeRadicalAdIds, [])
  })

  test('offerRollup (the over-count the group grain hides) > mixed group: counts each offer at its own grain', t => {
    const ads = [
      { id: 'free1' }, // free radical
      { id: 'free2' }, // free radical
      { id: 'wl', params: { zoneId: [ZONE] } }, // ad-level targeted
      { id: 'bl', exceptParams: { zoneId: [ZONE] } }, // ad-level blacklisted
      { id: 'elsewhere', params: { zoneId: ['other'] } }// confined elsewhere
    ]
    const r = offerRollup(v, untargeted, ads, zone, LIVE)
    t.is(r.total, 5)
    t.is(r.inScope, 3)
    t.is(r.freeRadical, 2)
    t.deepEqual(r.freeRadicalAdIds, ['free1', 'free2'])
    t.is(r.adLevelTargeted, 1)
    t.is(r.adLevelBlacklisted, 1)
    t.is(r.confinedElsewhere, 1)
  })
}

/**
 * D3 from the 2026-08-03 contract review: an untargeted ad group whose ads are ALL
 * zone-whitelisted yields 0 free-radical OFFERS while still appearing as a host row.
 * The live network had no such config, so the behaviour is pinned here instead.
 * Fixture recipe for a live run: untargeted group (params {}) on the zone's CAG,
 * holding ≥1 untargeted ad and ≥1 ad whose params.zoneId names the zone.
 */
{ // D3 — the host row survives, the offer count does not
  const untargeted = { id: 'host', name: 'host', creativeAssetGroupId: CAG, params: {} }
  const allWhitelisted = [
    { id: 'wl1', params: { zoneId: [ZONE] } },
    { id: 'wl2', params: { zoneId: [ZONE] } },
    { id: 'wl3', params: { zoneId: [ZONE, 'other'] } }
  ]

  test('D3 — the host row survives, the offer count does not > group stays in the freeRadicals bucket (host row is never dropped)', t => {
    const b = zoneEligibility([untargeted], zone, { host: allWhitelisted })
    t.deepEqual(b.freeRadicals.map((e) => e.adGroupId), ['host'])
    t.deepEqual(b.directlyTargeted, [])
  })

  test('D3 — the host row survives, the offer count does not > all three ads are ad-level-TARGETED, so zero free-radical offers', t => {
    const v = eligibility({ adGroup: untargeted, zone, ads: allWhitelisted })
    const r = offerRollup(v, untargeted, allWhitelisted, zone, LIVE)
    t.is(r.total, 3)
    t.is(r.inScope, 3)
    t.is(r.freeRadical, 0)
    t.is(r.adLevelTargeted, 3)
    t.deepEqual(r.freeRadicalAdIds, [])
  })

  test('D3 — the host row survives, the offer count does not > summary: 1 free-radical GROUP, 0 free-radical OFFERS, 3 ad-level-targeted', t => {
    const v = eligibility({ adGroup: untargeted, zone, ads: allWhitelisted })
    const host = {
      id: 'host',
      name: 'host',
      archived: false,
      campaign_on: true,
      adgroup_on: true,
      has_enabled_ad: true,
      creative_resolves: true,
      has_live_viable_ad: true,
      fully_live: true,
      off_reason: [],
      scoped_via: ['ad-level-whitelist', 'zone-selection'],
      eligible: true,
      via: v.via,
      reasons: v.reasons,
      conflicts: v.conflicts,
      offers: offerRollup(v, untargeted, allWhitelisted, zone, LIVE)
    }
    const s = summarizeEligibility([], [host], [])
    t.is(s.freeRadicalHosts, 1)
    t.is(s.freeRadicalOffers, 0)
    t.is(s.adLevelTargetedOffers, 3)
  })

  test('D3 — the host row survives, the offer count does not > D2/D4 invariants hold on a mixed group', t => {
    const ads = [
      { id: 'free1' }, { id: 'wl', params: { zoneId: [ZONE] } },
      { id: 'bl', exceptParams: { zoneId: [ZONE] } }, { id: 'away', params: { zoneId: ['other'] } }
    ]
    const v = eligibility({ adGroup: untargeted, zone, ads })
    const r = offerRollup(v, untargeted, ads, zone, LIVE)
    // D2: the disjoint-ish buckets never exceed the ad count
    t.true(r.freeRadical + r.adLevelTargeted + r.adLevelBlacklisted + r.confinedElsewhere <= r.total)
    // D4: the id list is the free-radical count, not a superset
    t.is(r.freeRadicalAdIds.length, r.freeRadical)
    // D5 (config side): every listed id is an untargeted, non-blacklisted ad
    for (const id of r.freeRadicalAdIds) {
      const ad = ads.find((a) => a.id === id)
      t.deepEqual(ad.params?.zoneId ?? [], [])
      t.false(ad.exceptParams?.zoneId ?? [].includes(ZONE))
    }
  })
}

/**
 * The live axis at the OFFER grain. Field case (`dr0xp2` on zone `6wahzt`, review
 * 2026-08-05): untargeted group on the zone's CAG, group and ads enabled, creatives
 * resolve — eligible — held out ONLY by campaign `nq7o5x` being off. It leaks the
 * moment the campaign flips on, so counting its offers as current exposure is wrong
 * and dropping them is worse. freeRadicalLive separates the two; freeRadical > 0 &&
 * freeRadicalLive === 0 IS the standing trap.
 *
 * Grain note: on the live zone the "4 offers" figure is the ZONE total
 * (summary.freeRadicalOffers) spread one apiece across four hosts — the dr0xp2 ROW
 * reads freeRadical: 1. The 4 ads below are a fixture for the multi-ad case, not a
 * copy of that row; the shape under test is dormant-host-with-free-radical-offers.
 */
{ // free-radical offers have a live axis (the dr0xp2 shape)
  const untargeted = { id: 'dr0xp2', creativeAssetGroupId: CAG, params: {} }
  const v = eligibility({ adGroup: untargeted, zone, ads: [] })
  const ads = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }]

  test('free-radical offers have a live axis (the dr0xp2 shape) > campaign off → 4 free-radical offers, 0 of them live (standing trap, not exposure)', t => {
    const r = offerRollup(v, untargeted, ads, zone, DARK)
    t.is(r.freeRadical, 4)
    t.is(r.freeRadicalLive, 0)
    t.is(r.inScope, 4) // targeting passes at both levels…
    t.is(r.live, 0) // …and none of it renders
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > campaign on → the same 4 offers are live exposure', t => {
    const r = offerRollup(v, untargeted, ads, zone, LIVE)
    t.is(r.freeRadicalLive, 4)
    t.is(r.live, 4)
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > liveness is per ad, not per group', t => {
    const r = offerRollup(v, untargeted, ads, zone, (ad) => ad.id === 'a1' || ad.id === 'a3')
    t.is(r.freeRadical, 4)
    t.is(r.freeRadicalLive, 2)
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > live counts never exceed their targeting counts', t => {
    for (const isLive of [LIVE, DARK, (ad) => ad.id === 'a2']) {
      const r = offerRollup(v, untargeted, [...ads, { id: 'bl', exceptParams: { zoneId: [ZONE] } }], zone, isLive)
      t.true(r.freeRadicalLive <= r.freeRadical)
      t.true(r.live <= r.inScope)
    }
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > an ad-level-targeted ad is live but never a live FREE RADICAL', t => {
    const r = offerRollup(v, untargeted, [{ id: 'wl', params: { zoneId: [ZONE] } }], zone, LIVE)
    t.is(r.live, 1)
    t.is(r.freeRadicalLive, 0)
  })
}

/**
 * Field-found on Adnet (`xvret6`) 2026-08-04: 18 ads across 8 groups whitelist a zone
 * their parent group cannot reach — e.g. group `p3a87b` (Roofing) targets six zones not
 * including `upd39v`, while four of its ads name `upd39v`. filterAdgroups() drops the
 * group before filterAds() is consulted, so the whitelist never fires. Six of the eight
 * groups are live, and the config reads as "this ad is targeted here" while doing nothing.
 *
 * Before this signal those groups were dropped from every bucket — the defect was
 * undiscoverable through the tools that exist to find exactly this.
 */
{ // inert ad-level whitelist (dead config, the Adnet shape)
  const roofing = {
    id: 'p3a87b',
    name: 'Roofing',
    creativeAssetGroupId: CAG,
    params: { zoneId: ['kbh7fx', 'hh4x9w', 'bietyv'] } // does NOT include the zone
  }
  const escaping = { id: 'vk5xdn', params: { zoneId: [ZONE] } } // names the zone anyway

  test('inert ad-level whitelist (dead config, the Adnet shape) > the offer carries the conflict and does not serve', t => {
    const v = eligibility({ adGroup: roofing, zone, ads: [escaping] })
    const o = offerEligibility(v, roofing, escaping, zone)
    t.is(v.eligible, false)
    t.is(o.serves, false)
    t.deepEqual(o.conflicts, ['inert-ad-level-whitelist'])
    t.true(o.scoped_via.includes('ad-level-whitelist'))
    t.true(o.reasons.includes('targets-other-zones'))
    t.is(o.freeRadical, false)
  })

  test('inert ad-level whitelist (dead config, the Adnet shape) > a whitelist under an ELIGIBLE group is not inert (narrowing, the common idiom)', t => {
    const targeted = { id: '1oby5f', creativeAssetGroupId: CAG, params: { zoneId: [ZONE, 'hh4x9w'] } }
    const narrowing = { id: 'sk868g', params: { zoneId: [ZONE] } }
    const v = eligibility({ adGroup: targeted, zone, ads: [narrowing] })
    const o = offerEligibility(v, targeted, narrowing, zone)
    t.is(o.serves, true)
    t.deepEqual(o.conflicts, [])
  })

  test('inert ad-level whitelist (dead config, the Adnet shape) > the group surfaces in its own bucket instead of being dropped', t => {
    const b = zoneEligibility([roofing], zone, { p3a87b: [escaping] })
    t.deepEqual(b.inertWhitelists.map((e) => e.adGroupId), ['p3a87b'])
    t.true(b.inertWhitelists[0].conflicts.includes('inert-ad-level-whitelist'))
    // …and stays out of every reconciliation bucket.
    t.deepEqual(b.directlyTargeted, [])
    t.deepEqual(b.conflicting, [])
    t.deepEqual(b.freeRadicals, [])
  })

  /**
   * The bucket keys on `!eligible`, NOT on CAG match — so every ineligibility cause can
   * land here, each distinguishable by `reasons[]`. Asked live on 2026-08-04: every inert
   * row on Adnet came back `via: ["zone-selection"]`, which raised the question of whether
   * cag-mismatch was structurally unreachable rather than merely absent. It is reachable;
   * Adnet has none.
   */
  test('inert ad-level whitelist (dead config, the Adnet shape) > admits every ineligibility cause, distinguishable by reasons[]', t => {
    const wrongCag = { id: 'othercag', creativeAssetGroupId: 'different', params: { zoneId: ['z9'] } }
    const archived = { id: 'gone', creativeAssetGroupId: CAG, params: { zoneId: ['z9'] }, archived: true }
    const wl = { id: 'a', params: { zoneId: [ZONE] } }

    const b = zoneEligibility([wrongCag, archived], zone, { othercag: [wl], gone: [wl] })
    t.deepEqual(b.inertWhitelists.map((e) => e.adGroupId).sort(), ['gone', 'othercag'])

    const byId = new Map(b.inertWhitelists.map((e) => [e.adGroupId, e]))
    t.deepEqual(byId.get('othercag').reasons, ['cag-mismatch'])
    t.deepEqual(byId.get('othercag').via, []) // no zone-selection — the tell
    t.deepEqual(byId.get('gone').reasons, ['archived'])
    for (const e of b.inertWhitelists) t.true(e.conflicts.includes('inert-ad-level-whitelist'))
  })

  test('inert ad-level whitelist (dead config, the Adnet shape) > an out-of-scope group with no whitelisted ad is still dropped (no noise)', t => {
    const plain = { id: 'ordinary' }
    const b = zoneEligibility([roofing], zone, { p3a87b: [plain] })
    t.deepEqual(b.inertWhitelists, [])
  })

  test('inert ad-level whitelist (dead config, the Adnet shape) > rolls up per group, counting only the dead ads', t => {
    const ads = [
      { id: 'vk5xdn', params: { zoneId: [ZONE] } }, // inert
      { id: '2j5j7q', params: { zoneId: [ZONE] } }, // inert
      { id: 'elsewhere', params: { zoneId: ['hh4x9w'] } }, // confined to a zone the group does target
      { id: 'plain' } // nothing
    ]
    const v = eligibility({ adGroup: roofing, zone, ads })
    const r = offerRollup(v, roofing, ads, zone, LIVE)
    t.is(r.total, 4)
    t.is(r.inScope, 0) // group can't reach the zone — nothing serves
    t.is(r.inertWhitelisted, 2)
    t.deepEqual(r.inertWhitelistedAdIds, ['vk5xdn', '2j5j7q'])
    t.is(r.freeRadical, 0)
  })
}

/** C3 — scoped_via is ONE enum across the tools that emit it. */
{ // C3 — shared scoped_via domain
  const inventoryRow = (over, ads) => rollupZoneTargeting({
    zoneId: ZONE,
    zoneCag: CAG,
    targeted: [{ id: 'ag1', name: 'ag1', enabled: true, campaignId: 'c1', creativeAssetGroupId: CAG, ...over }],
    conflicting: [],
    campaigns: { c1: { enabled: true } },
    adsByGroup: { ag1: ads },
    creatives: { cr1: {} },
    mode: 'all'
  }).groups[0]

  test('C3 — shared scoped_via domain > the group-grain rollup emits ad-group-blacklist (the value that used to be missing)', t => {
    const r = inventoryRow({ params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, [])
    t.true(r.scoped_via.includes('ad-group-blacklist'))
  })

  test('C3 — shared scoped_via domain > group-grain values are all members of SCOPED_VIA', t => {
    const r = inventoryRow(
      { params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } },
      [{ id: 'a1', params: { zoneId: [ZONE] } }, { id: 'a2', exceptParams: { zoneId: [ZONE] } }]
    )
    t.is(r.scoped_via.length, 5)
    for (const v of r.scoped_via) t.true(SCOPED_VIA.includes(v))
  })

  test('C3 — shared scoped_via domain > offer-grain values are all members of the same SCOPED_VIA', t => {
    const ag = { id: 'ag1', creativeAssetGroupId: CAG, params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }
    const v = eligibility({ adGroup: ag, zone, ads: [] })
    const o = offerEligibility(v, ag, { id: 'a1', params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, zone)
    t.is(o.scoped_via.length, 5)
    for (const s of o.scoped_via) t.true(SCOPED_VIA.includes(s))
  })
}

{ // summarizeEligibility (bucket grain in the tool summary)
  const rollup = (o) => ({
    total: 0,
    inScope: 0,
    live: 0,
    freeRadicalLive: 0,
    freeRadical: 0,
    adLevelTargeted: 0,
    adLevelBlacklisted: 0,
    confinedElsewhere: 0,
    inertWhitelisted: 0,
    freeRadicalAdIds: [],
    inertWhitelistedAdIds: [],
    ...o
  })
  const row = (id, offers, over = {}) => ({
    id,
    name: id,
    archived: false,
    campaign_on: true,
    adgroup_on: true,
    has_enabled_ad: true,
    creative_resolves: true,
    has_live_viable_ad: true,
    fully_live: true,
    off_reason: [],
    scoped_via: [],
    eligible: true,
    via: [],
    reasons: [],
    conflicts: [],
    offers: rollup(offers),
    ...over
  })

  test('summarizeEligibility (bucket grain in the tool summary) > free-radical offers come from the free-radical bucket only; ad-level totals span both serving buckets', t => {
    const direct = [row('d1', { adLevelTargeted: 2, adLevelBlacklisted: 1, freeRadical: 99 })] // freeRadical impossible here
    const radicals = [row('r1', { freeRadical: 3, adLevelTargeted: 1 }), row('r2', { freeRadical: 0 })]
    const conflict = [row('c1', { adLevelTargeted: 7 }, { eligible: false, fully_live: false })]
    const s = summarizeEligibility(direct, radicals, conflict)
    t.is(s.freeRadicalOffers, 3)
    t.is(s.adLevelTargetedOffers, 3) // 2 direct + 1 radical, conflicting excluded
    t.is(s.adLevelBlacklistedOffers, 1)
    t.is(s.freeRadicalHosts, 2) // host grain still counts r2
    t.is(s.directlyTargeted, 1)
    t.is(s.conflicting, 1)
  })

  /** D1 at the live grain: the summary is the exact Σ over the free-radical rows,
   * and a dormant host contributes offers to freeRadicalOffers but none to Live. */
  test('summarizeEligibility (bucket grain in the tool summary) > freeRadicalOffersLive sums only the live free-radical offers', t => {
    const radicals = [
      row('live', { freeRadical: 3, freeRadicalLive: 3 }),
      row('dormant', { freeRadical: 5, freeRadicalLive: 0 }, { fully_live: false, campaign_on: false, off_reason: ['campaign'] }),
      row('partial', { freeRadical: 4, freeRadicalLive: 1 })
    ]
    const s = summarizeEligibility([], radicals, [])
    t.is(s.freeRadicalOffers, 12)
    t.is(s.freeRadicalOffersLive, 4)
    t.true(s.freeRadicalOffersLive <= s.freeRadicalOffers)
    t.is(s.freeRadicalHosts, 3)
    t.is(s.freeRadicalHostsLive, 2)
    // the standing traps the reviewer wants derivable per row, no headline counter
    t.deepEqual(radicals.filter((r) => r.offers.freeRadical > 0 && r.offers.freeRadicalLive === 0).map((r) => r.id), ['dormant'])
  })

  test('summarizeEligibility (bucket grain in the tool summary) > config-broken targeted groups stay counted in directlyTargeted and are flagged ineligible', t => {
    const direct = [row('ok', {}), row('broken', {}, { eligible: false, fully_live: false })]
    const s = summarizeEligibility(direct, [], [])
    t.is(s.directlyTargeted, 2)
    t.is(s.directlyTargetedIneligible, 1)
    t.is(s.directlyTargetedLive, 1)
  })
}

{ // adGroupReach (group → zones it can serve/leak into)
  const zones = [
    { id: 'za', creativeAssetGroupId: CAG },
    { id: 'zb', creativeAssetGroupId: CAG },
    { id: 'zc', creativeAssetGroupId: 'other' }
  ]

  test('adGroupReach (group → zones it can serve/leak into) > a free-radical group reaches every zone sharing its CAG', t => {
    const r = adGroupReach({ id: 'ag', creativeAssetGroupId: CAG, params: {} }, zones, [])
    t.deepEqual(r.map((e) => e.zoneId), ['za', 'zb'])
    t.is(r.every((e) => e.via.includes('zone-selection')), true)
  })

  // E1 as literally worded ("reach(X) ∋ Z ⟺ eligible(Z) ∋ X") does NOT hold on
  // response membership: a whitelisted-but-ineligible group is deliberately RETAINED
  // in directlyTargeted[] (so config breakage surfaces instead of vanishing) while
  // reach() filters to eligible only. The symmetry is over the ELIGIBLE set.
  test('adGroupReach (group → zones it can serve/leak into) > E1 — symmetry holds on eligibility, not on response membership', t => {
    const broken = { id: 'mismatch', creativeAssetGroupId: 'other', params: { zoneId: ['za'] } }
    const zoneA = { id: 'za', creativeAssetGroupId: CAG }
    const b = zoneEligibility([broken], zoneA, {})
    t.deepEqual(b.directlyTargeted.map((e) => e.adGroupId), ['mismatch']) // retained…
    t.is(b.directlyTargeted[0].eligible, false) // …but ineligible
    t.deepEqual(adGroupReach(broken, [zoneA], []).map((e) => e.zoneId), []) // so not reachable
  })

  test('adGroupReach (group → zones it can serve/leak into) > a whitelisted group reaches only the zone it targets', t => {
    const r = adGroupReach({ id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: ['zb'] } }, zones, [])
    t.deepEqual(r.map((e) => e.zoneId), ['zb'])
  })
}
