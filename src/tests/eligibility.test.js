import test from 'ava'
import {
  eligibility, adServesInZone, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  SCOPED_VIA, zoneRequest, paramsVerdict, refusesEveryVisit, refusesDefaultVisits, segmentPickFlags, contradiction, adVerdict

} from '../tools/eligibility.js'
import { rollupZoneTargeting, selectTargeting } from '../tools/zoneInventoryTools.js'
import { summarizeEligibility, conditionKeysOf, eligibilityHeader, enrich } from '../tools/zoneEligibilityTools.js'
import { visitRequest } from './helpers/visitRequest.js'

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

// eligibility
test('eligibility > free radical: targets zero zones + CAG match → eligible via zone-selection only', t => {
  const e = eligibility(input({ params: {} }))
  t.is(e.eligible, true)
  t.deepEqual(e.via, ['zone-selection'])
  t.is(e.blacklisted, false)
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
  t.is(e.blacklisted, true)
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

// adServesInZone (per-ad last targeting check)
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
    const o = offerEligibility({ group: verdict(untargeted), adGroup: untargeted, ad: { id: 'ad1' }, zone })
    t.is(o.serves, true)
    t.is(o.freeRadical, true)
    t.deepEqual(o.scoped_via, ['zone-selection'])
  })

  test('offerEligibility (ad group × ad grain) > zone-whitelisted ad under an untargeted group → ad-level-TARGETED, NOT a free radical', t => {
    const ad = { id: 'ad1', params: { zoneId: [ZONE] } }
    const o = offerEligibility({ group: verdict(untargeted), adGroup: untargeted, ad, zone })
    t.is(o.serves, true)
    t.is(o.freeRadical, false)
    t.deepEqual(o.scoped_via, ['ad-level-whitelist', 'zone-selection'])
  })

  test('offerEligibility (ad group × ad grain) > ad-level blacklist excludes the offer even under an eligible untargeted group', t => {
    const ad = { id: 'ad1', exceptParams: { zoneId: [ZONE] } }
    const o = offerEligibility({ group: verdict(untargeted), adGroup: untargeted, ad, zone })
    t.is(o.serves, false)
    t.is(o.freeRadical, false)
    t.true(o.scoped_via.includes('ad-level-blacklist'))
    t.true(o.reasons.includes('ad-blacklisted'))
  })

  test('offerEligibility (ad group × ad grain) > ad confined to other zones → does not serve, not a free radical', t => {
    const ad = { id: 'ad1', params: { zoneId: ['other'] } }
    const o = offerEligibility({ group: verdict(untargeted), adGroup: untargeted, ad, zone })
    t.is(o.serves, false)
    t.true(o.reasons.includes('ad-targets-other-zones'))
  })

  test('offerEligibility (ad group × ad grain) > group ineligible → no offer serves, even if the ad whitelists the zone (filterAdgroups runs first)', t => {
    const scopedOut = { id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: ['other'] } }
    const o = offerEligibility({ group: verdict(scopedOut), adGroup: scopedOut, ad: { id: 'ad1', params: { zoneId: [ZONE] } }, zone })
    t.is(o.serves, false)
    t.deepEqual(o.reasons, ['targets-other-zones'])
  })

  test('offerEligibility (ad group × ad grain) > offer under a directly-targeted group is never a free radical', t => {
    const direct = { id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } }
    const o = offerEligibility({ group: verdict(direct), adGroup: direct, ad: { id: 'ad1' }, zone })
    t.is(o.serves, true)
    t.is(o.freeRadical, false)
    t.deepEqual(o.scoped_via, ['ad-group-whitelist', 'zone-selection'])
  })
}

{ // offerRollup (the over-count the group grain hides)
  const untargeted = { id: 'ag', creativeAssetGroupId: CAG, params: {} }
  const v = eligibility({ adGroup: untargeted, zone, ads: [] })

  test('offerRollup (the over-count the group grain hides) > untargeted group whose ONLY ad is zone-whitelisted → free-radical GROUP but 0 free-radical offers', t => {
    const r = offerRollup({ group: v, adGroup: untargeted, ads: [{ id: 'ad1', params: { zoneId: [ZONE] } }], zone, isLive: LIVE })
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
    const r = offerRollup({ group: v, adGroup: untargeted, ads, zone, isLive: LIVE })
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
    const r = offerRollup({ group: v, adGroup: untargeted, ads: allWhitelisted, zone, isLive: LIVE })
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
      verdict: v.verdict,
      via: v.via,
      reasons: v.reasons,
      conflicts: v.conflicts,
      offers: offerRollup({ group: v, adGroup: untargeted, ads: allWhitelisted, zone, isLive: LIVE })
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
    const r = offerRollup({ group: v, adGroup: untargeted, ads, zone, isLive: LIVE })
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
    const r = offerRollup({ group: v, adGroup: untargeted, ads, zone, isLive: DARK })
    t.is(r.freeRadical, 4)
    t.is(r.freeRadicalLive, 0)
    t.is(r.inScope, 4) // targeting passes at both levels…
    t.is(r.live, 0) // …and none of it renders
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > campaign on → the same 4 offers are live exposure', t => {
    const r = offerRollup({ group: v, adGroup: untargeted, ads, zone, isLive: LIVE })
    t.is(r.freeRadicalLive, 4)
    t.is(r.live, 4)
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > liveness is per ad, not per group', t => {
    const r = offerRollup({ group: v, adGroup: untargeted, ads, zone, isLive: (ad) => ad.id === 'a1' || ad.id === 'a3' })
    t.is(r.freeRadical, 4)
    t.is(r.freeRadicalLive, 2)
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > live counts never exceed their targeting counts', t => {
    for (const isLive of [LIVE, DARK, (ad) => ad.id === 'a2']) {
      const r = offerRollup({ group: v, adGroup: untargeted, ads: [...ads, { id: 'bl', exceptParams: { zoneId: [ZONE] } }], zone, isLive })
      t.true(r.freeRadicalLive <= r.freeRadical)
      t.true(r.live <= r.inScope)
    }
  })

  test('free-radical offers have a live axis (the dr0xp2 shape) > an ad-level-targeted ad is live but never a live FREE RADICAL', t => {
    const r = offerRollup({ group: v, adGroup: untargeted, ads: [{ id: 'wl', params: { zoneId: [ZONE] } }], zone, isLive: LIVE })
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
    const o = offerEligibility({ group: v, adGroup: roofing, ad: escaping, zone })
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
    const o = offerEligibility({ group: v, adGroup: targeted, ad: narrowing, zone })
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
   * Adnet has none. It IS unreachable on a zone with no CAG, where no CAG filter applies —
   * see the "zone without a CAG" block at the end of this file.
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
    const r = offerRollup({ group: v, adGroup: roofing, ads, zone, isLive: LIVE })
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
    mode: 'all',
    now: Date.parse('2026-06-15T12:00:00.000Z')
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
    const o = offerEligibility({ group: v, adGroup: ag, ad: { id: 'a1', params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, zone })
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
    verdict: 'eligible',
    via: [],
    reasons: [],
    conflicts: [],
    offers: rollup(offers),
    ...over
  })

  test('summarizeEligibility (bucket grain in the tool summary) > free-radical offers come from the free-radical bucket only; ad-level totals span both serving buckets', t => {
    const direct = [row('d1', { adLevelTargeted: 2, adLevelBlacklisted: 1, freeRadical: 99 })] // freeRadical impossible here
    const radicals = [row('r1', { freeRadical: 3, adLevelTargeted: 1 }), row('r2', { freeRadical: 0 })]
    const conflict = [row('c1', { adLevelTargeted: 7 }, { eligible: false, verdict: 'excluded', fully_live: false })]
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
      row('live', { freeRadical: 3, freeRadicalLive: 3, live: 3 }),
      row('dormant', { freeRadical: 5, freeRadicalLive: 0 }, { fully_live: false, campaign_on: false, off_reason: ['campaign'] }),
      row('partial', { freeRadical: 4, freeRadicalLive: 1, live: 1 })
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
    const direct = [row('ok', { live: 1 }), row('broken', {}, { eligible: false, verdict: 'excluded', fully_live: false })]
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
    const r = adGroupReach({ id: 'ag', creativeAssetGroupId: CAG, params: {} }, zones)
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
    t.deepEqual(adGroupReach(broken, [zoneA]).map((e) => e.zoneId), []) // so not reachable
  })

  test('adGroupReach (group → zones it can serve/leak into) > a whitelisted group reaches only the zone it targets', t => {
    const r = adGroupReach({ id: 'ag', creativeAssetGroupId: CAG, params: { zoneId: ['zb'] } }, zones)
    t.deepEqual(r.map((e) => e.zoneId), ['zb'])
  })
}

{ // zone without a CAG (the serving engine skips the filter entirely)
  const openZone = { id: 'zopen' }
  const nullCagZone = { id: 'znull', creativeAssetGroupId: null }
  const otherCag = { id: 'ag-other', creativeAssetGroupId: 'different' }

  test('zone without a CAG (the serving engine skips the filter entirely) > an untargeted group of any CAG is eligible', t => {
    const e = eligibility({ adGroup: { ...otherCag, params: {} }, zone: openZone })
    t.is(e.eligible, true)
    t.deepEqual(e.reasons, [])
    t.deepEqual(e.via, []) // no shared CAG to be selected by
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > a null CAG counts as absent, like upstream', t => {
    const e = eligibility({ adGroup: { ...otherCag, params: {} }, zone: nullCagZone })
    t.is(e.eligible, true)
    t.deepEqual(e.reasons, [])
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > the other rules still apply: blacklist, archived, other zones', t => {
    const black = eligibility({ adGroup: { ...otherCag, exceptParams: { zoneId: ['zopen'] } }, zone: openZone })
    t.is(black.eligible, false)
    t.deepEqual(black.reasons, ['blacklisted'])

    const gone = eligibility({ adGroup: { ...otherCag, archived: true, params: {} }, zone: openZone })
    t.deepEqual(gone.reasons, ['archived'])

    const elsewhere = eligibility({ adGroup: { ...otherCag, params: { zoneId: ['zb'] } }, zone: openZone })
    t.is(elsewhere.eligible, false)
    t.deepEqual(elsewhere.reasons, ['targets-other-zones'])
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > a whitelisted group is eligible with no cag-mismatch conflict', t => {
    const e = eligibility({ adGroup: { ...otherCag, params: { zoneId: ['zopen'] } }, zone: openZone })
    t.is(e.eligible, true)
    t.deepEqual(e.via, ['ad-group-whitelist'])
    t.deepEqual(e.conflicts, [])
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > no group is bucketed as a cag-mismatch, and untargeted ones host free radicals', t => {
    const groups = [
      { id: 'wl', creativeAssetGroupId: 'different', params: { zoneId: ['zopen'] } },
      { id: 'open', creativeAssetGroupId: 'different', params: {} }
    ]
    const b = zoneEligibility(groups, openZone, {})
    t.deepEqual(b.directlyTargeted.map((e) => e.adGroupId), ['wl'])
    t.deepEqual(b.freeRadicals.map((e) => e.adGroupId), ['open'])
    t.deepEqual(b.inertWhitelists, [])
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > zone-selection is not claimed at either grain', t => {
    const adGroup = { id: 'open', creativeAssetGroupId: 'different', params: {} }
    const group = eligibility({ adGroup, zone: openZone })
    const o = offerEligibility({ group, adGroup, ad: { id: 'ad1' }, zone: openZone })
    t.is(o.serves, true)
    t.false(o.scoped_via.includes('zone-selection'))
    t.is(o.freeRadical, true)

    const { groups } = rollupZoneTargeting({
      zoneId: openZone.id,
      zoneCag: undefined,
      targeted: [adGroup],
      conflicting: [],
      campaigns: {},
      adsByGroup: {},
      creatives: {},
      mode: 'all',
      // Harmless here; keeps the call valid once #76 makes the clock required.
      now: Date.parse('2026-06-15T12:00:00.000Z')
    })
    t.false(groups[0].scoped_via.includes('zone-selection'))
  })

  test('zone without a CAG (the serving engine skips the filter entirely) > reach counts CAG-less zones, not just zones sharing the CAG', t => {
    const zones = [{ id: 'za', creativeAssetGroupId: CAG }, openZone, { id: 'zc', creativeAssetGroupId: 'other' }]
    const r = adGroupReach({ id: 'ag', creativeAssetGroupId: CAG, params: {} }, zones)
    t.deepEqual(r.map((e) => e.zoneId), ['za', 'zopen'])
  })
}

/**
 * #81 — every targeting rule, not just zoneId. The fixture mirrors the seeded local
 * network ybdob7 (docs kit, seed-d2.js): zone Z0 on template T0 with the default
 * s1=abc, channel type Web, zone type Display, and groups G00–G13. On lincx-core
 * `cabd9a0d`, a bare desktop request to Z0 served G00 G01 G03 G06 G07 G13.
 */
{ // targeting rules beyond zoneId (#81)
  const T0 = 'fbdmxz'
  const T1 = '81bkz5'
  const Z0 = { id: 'uz4dab', networkId: 'ybdob7', publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' }, channelId: 'ch1' }
  const Z1 = { ...Z0, id: 'by8tgq', templateId: T1, dataAttributesDefault: undefined }
  const WEB = { id: 'ch1', type: 'Web' }
  const g = (id, extra = {}) => ({ id, creativeAssetGroupId: CAG, ...extra })
  const G = {
    G00: g('G00'),
    G01: g('G01', { params: { templateId: [T0] } }),
    G02: g('G02', { exceptParams: { templateId: [T0] } }),
    G03: g('G03', { params: { s1: ['abc'] } }),
    G04: g('G04', { params: { s1: ['xyz'] } }),
    G05: g('G05', { params: { device: ['mobile'] } }),
    G06: g('G06', { exceptParams: { device: ['mobile'] } }),
    G07: g('G07', { params: { channelType: ['Web'] } }),
    G08: g('G08', { params: { zoneType: ['Other'] } }),
    G09: g('G09', { params: { zoneId: [Z0.id] }, exceptParams: { templateId: [T0] } }),
    G10: g('G10', { params: { zoneId: [Z1.id] } }),
    G11: g('G11', { geo: ['TX'] }),
    G12: g('G12', { devices: ['mobile'] }),
    G13: g('G13')
  }
  const groups = Object.values(G)
  const adsByGroup = Object.fromEntries(groups.map((x) => [x.id, [{ id: `${x.id}-ad0` }]]))
  adsByGroup.G13.push({ id: 'G13-ad1', exceptParams: { templateId: [T0] } })
  const ids = (rows) => rows.map((e) => e.adGroupId).sort()
  const verdicts = (rows) => Object.fromEntries(rows.map((e) => [e.adGroupId, e.verdict]))
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const fullWeek = days.flatMap((d) => Array.from({ length: 24 }, (_, h) => d + h))

  test('targeting rules beyond zoneId (#81) > zoneRequest: fixed keys from the zone and channel, defaults from the zone', t => {
    const r = zoneRequest(Z0, WEB)
    t.is(r.resolved.channelType.value, 'Web')
    t.is(r.resolved.zoneType.value, 'Display')
    t.is(r.resolved.zoneType.source, 'zone')
    t.deepEqual(r.resolved.s1, { value: 'abc', source: 'zone-default' })
    t.deepEqual(r.resolved.templateId, { value: T0, source: 'zone-default' })
    t.is(r.resolved.device, undefined) // a visit key: nothing assumed
  })

  test('targeting rules beyond zoneId (#81) > zoneRequest: a supplied visit key overrides a default', t => {
    const r = visitRequest(Z0, WEB, { s1: 'xyz', device: 'mobile' })
    t.deepEqual(r.resolved.s1, { value: 'xyz', source: 'request' })
    t.deepEqual(r.resolved.device, { value: 'mobile', source: 'request' })
  })

  test('targeting rules beyond zoneId (#81) > zoneRequest: a zone default never supplies a key the request path always sets', t => {
    const r = zoneRequest({ ...Z0, dataAttributesDefault: { device: 'mobile', geoState: 'TX', dateTimeUTC: 'mon1', s1: 'abc' } }, WEB)
    t.is(r.resolved.device, undefined)
    t.is(r.resolved.geoState, undefined)
    t.is(r.resolved.dateTimeUTC, undefined)
    t.is(r.resolved.s1.value, 'abc')
  })

  test('targeting rules beyond zoneId (#81) > a full-week dateTime whitelist is no rule; 167 hours is conditional', t => {
    const req = zoneRequest(Z0, WEB)
    const full = paramsVerdict({ params: { 'dateTimeUS/Eastern': fullWeek } }, req)
    t.true(full.allowed)
    t.false(full.conditional)
    const partial = paramsVerdict({ params: { 'dateTimeUS/Eastern': fullWeek.slice(1) } }, req)
    t.true(partial.conditional)
    t.is(partial.conditions[0].valuesTotal, 167)
    t.is(partial.conditions[0].values.length, 20)
  })

  test('targeting rules beyond zoneId (#81) > a full-week dateTime blacklist excludes every request', t => {
    const v = paramsVerdict({ exceptParams: { dateTimeUTC: fullWeek } }, zoneRequest(Z0, WEB))
    t.false(v.allowed)
    t.is(v.blocks[0].path, 'exceptParams.dateTimeUTC')
    t.is(v.blocks[0].overridable, false)
  })

  test('targeting rules beyond zoneId (#81) > empty lists are no rule; values compare as strings', t => {
    const req = zoneRequest({ ...Z0, dataAttributesDefault: { n: 5 } }, WEB)
    t.deepEqual(paramsVerdict({ params: { device: [], s1: [] }, exceptParams: { templateId: [] } }, req).blocks, [])
    t.true(paramsVerdict({ params: { n: ['5'] } }, req).allowed)
  })

  test('targeting rules beyond zoneId (#81) > no request: Z0 buckets match the plan (5 eligible + 4 conditional free radicals)', t => {
    const b = zoneEligibility(groups, Z0, adsByGroup, zoneRequest(Z0, WEB))
    t.deepEqual(verdicts(b.freeRadicals), {
      G00: 'eligible',
      G01: 'eligible',
      G03: 'eligible',
      G05: 'conditional',
      G06: 'conditional',
      G07: 'eligible',
      G11: 'conditional',
      G12: 'conditional',
      G13: 'eligible'
    })
    t.deepEqual(ids(b.excludedByDefault), ['G02', 'G04'])
    t.deepEqual(ids(b.directlyTargeted), ['G09'])
    t.is(b.directlyTargeted[0].verdict, 'excluded')
    t.deepEqual(b.directlyTargeted[0].reasons, ['param-blacklisted'])
    const all = [...b.directlyTargeted, ...b.freeRadicals, ...b.conflicting, ...b.inertWhitelists, ...b.excludedByDefault]
    t.false(ids(all).includes('G08')) // zoneType is fixed by the zone: dropped
    t.false(ids(all).includes('G10')) // targets Z1
  })

  test('targeting rules beyond zoneId (#81) > a free radical keeps its bucket and records the key it matched', t => {
    const b = zoneEligibility(groups, Z0, adsByGroup, zoneRequest(Z0, WEB))
    const byId = new Map(b.freeRadicals.map((e) => [e.adGroupId, e]))
    t.deepEqual(byId.get('G01').matchedKeys, [{ path: 'params.templateId', key: 'templateId', value: T0, source: 'zone-default' }])
    t.deepEqual(byId.get('G03').matchedKeys, [{ path: 'params.s1', key: 's1', value: 'abc', source: 'zone-default' }])
    t.deepEqual(byId.get('G07').matchedKeys, [{ path: 'params.channelType', key: 'channelType', value: 'Web', source: 'zone' }])
  })

  test('targeting rules beyond zoneId (#81) > conditions name the key, the op and the source; geo / devices map to geoState / device', t => {
    const b = zoneEligibility(groups, Z0, adsByGroup, zoneRequest(Z0, WEB))
    const byId = new Map(b.freeRadicals.map((e) => [e.adGroupId, e]))
    t.deepEqual(byId.get('G05').conditions, [{ path: 'params.device', key: 'device', op: 'requires', values: ['mobile'], valuesTotal: 1, source: 'request' }])
    t.is(byId.get('G06').conditions[0].op, 'excludes')
    t.like(byId.get('G11').conditions[0], { path: 'geo', key: 'geoState', op: 'requires', values: ['TX'] })
    t.like(byId.get('G12').conditions[0], { path: 'devices', key: 'device', op: 'requires', values: ['mobile'] })
    for (const id of ['G05', 'G06', 'G11', 'G12']) {
      t.is(byId.get(id).eligible, false)
      t.is(byId.get(id).conditional, true)
    }
  })

  test('targeting rules beyond zoneId (#81) > a zone-default block names what the zone sent and that a request could change it', t => {
    const b = zoneEligibility(groups, Z0, adsByGroup, zoneRequest(Z0, WEB))
    const g04 = b.excludedByDefault.find((e) => e.adGroupId === 'G04')
    t.deepEqual(g04.paramBlocks, [{ path: 'params.s1', key: 's1', op: 'requires', values: ['xyz'], valuesTotal: 1, source: 'zone-default', actual: 'abc', overridable: true }])
    t.true(g04.excludedByDefault)
  })

  test('targeting rules beyond zoneId (#81) > request { device: mobile, s1: xyz }: G04 and G05 serve, G03 and G06 are out, G11 stays conditional', t => {
    const req = visitRequest(Z0, WEB, { device: 'mobile', s1: 'xyz' })
    const b = zoneEligibility(groups, Z0, adsByGroup, req)
    const v = verdicts(b.freeRadicals)
    t.is(v.G04, 'eligible')
    t.is(v.G05, 'eligible')
    t.is(v.G12, 'eligible')
    t.is(v.G11, 'conditional')
    t.is(v.G03, undefined) // s1 is xyz now: dropped, not bucketed
    t.is(v.G06, undefined)
    t.deepEqual(ids(b.excludedByDefault), ['G02'])
  })

  test('targeting rules beyond zoneId (#81) > a complete desktop visit: the eligible set is exactly what lincx-core served, nothing conditional', t => {
    const b = zoneEligibility(groups, Z0, adsByGroup, visitRequest(Z0, WEB, { device: 'desktop' }, { complete: true }))
    t.deepEqual(ids(b.freeRadicals), ['G00', 'G01', 'G03', 'G06', 'G07', 'G13'])
    t.true(b.freeRadicals.every((e) => e.verdict === 'eligible'))
    t.deepEqual(ids(b.excludedByDefault), ['G02', 'G04'])
  })

  test('targeting rules beyond zoneId (#81) > a block wins over a condition', t => {
    const both = g('both', { params: { device: ['mobile'] }, exceptParams: { templateId: [T0] } })
    const e = eligibility({ adGroup: both, zone: Z0, request: zoneRequest(Z0, WEB) })
    t.is(e.verdict, 'excluded')
    t.is(e.conditional, false)
    t.is(e.conditions.length, 1)
  })

  test('targeting rules beyond zoneId (#81) > a zoneId-targeted conditional group stays in directlyTargeted (reconciliation holds)', t => {
    const mobileOnly = g('mob', { params: { zoneId: [Z0.id], device: ['mobile'] } })
    const b = zoneEligibility([mobileOnly], Z0, {}, zoneRequest(Z0, WEB))
    t.deepEqual(ids(b.directlyTargeted), ['mob'])
    t.is(b.directlyTargeted[0].verdict, 'conditional')
    t.deepEqual(selectTargeting([mobileOnly], Z0.id).targeted.map((x) => x.id), ['mob'])
  })

  { // segments: the candidates are what selectNextSegment can pick
    const seg = (id, templateId, trafficAllocation, extra = {}) => ({ id, templateId, trafficAllocation, ...extra })
    const segZone = (segments, extra = {}) => ({ ...Z0, id: 'z2', segmentsStatus: 'on', segments, ...extra })
    const on = (zone, adGroup, supplied) => eligibility({ adGroup, zone, request: visitRequest(zone, WEB, supplied) })
    const templates = (zone, supplied) => visitRequest(zone, WEB, supplied).segments?.map((c) => c.templateId) ?? null

    test('targeting rules beyond zoneId (#81) > segments: two segments filling the allocation shut the zone template out and disagree → conditional', t => {
      const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
      t.deepEqual(templates(z), [T0, T1])
      t.is(on(z, G.G01).verdict, 'conditional')
      t.like(on(z, G.G01).conditions[0], { source: 'segment', key: 'templateId', op: 'requires' })
      t.deepEqual(on(z, G.G01).conditions[0].candidates.map(({ segmentId, templateId, passes }) => ({ segmentId, templateId, passes })), [
        { segmentId: 'a', templateId: T0, passes: true },
        { segmentId: 'b', templateId: T1, passes: false }
      ])
      t.is(on(z, G.G02).verdict, 'conditional')
      t.deepEqual(on(z, G.G02).conditions[0].candidates.map((c) => c.passes), [false, true])
    })

    test('targeting rules beyond zoneId (#81) > segments: one segment at 100% decides — the zone template never competes', t => {
      const z = segZone([seg('b', T1, 100)])
      t.deepEqual(templates(z), [T1])
      const g01 = on(z, G.G01)
      t.is(g01.verdict, 'excluded')
      t.like(g01.paramBlocks[0], { source: 'segment', overridable: true })
      t.true(g01.excludedByDefault)
      t.is(on(z, g('x', { exceptParams: { templateId: [T1] } })).verdict, 'excluded')
      t.is(on(z, G.G02).verdict, 'eligible')
    })

    test('targeting rules beyond zoneId (#81) > segments: allocation left over lets the zone template compete', t => {
      const z = segZone([seg('b', T1, 60)])
      t.deepEqual(templates(z), [T1, T0])
      t.is(on(z, G.G01).verdict, 'conditional')
    })

    test('targeting rules beyond zoneId (#81) > segments: a segment with no allocation is never picked', t => {
      const z = segZone([seg('b', T1, 0)])
      t.deepEqual(templates(z), [T0])
      t.is(on(z, G.G01).verdict, 'eligible')
    })

    test('targeting rules beyond zoneId (#81) > segments: a segment list on a visit key makes it possible, a matching request makes it certain', t => {
      const z = segZone([seg('m', T1, 100, { allowlist: { device: ['mobile'] } })])
      t.deepEqual(templates(z), [T1, T0])
      t.deepEqual(templates(z, { device: 'mobile' }), [T1])
      t.deepEqual(templates(z, { device: 'desktop' }), [T0])
      const blocked = segZone([seg('b', T1, 100, { blocklist: { s1: ['abc'] } })])
      t.deepEqual(templates(blocked), [T0])
    })

    test('targeting rules beyond zoneId (#81) > segments: a supplied templateId beats every segment', t => {
      const z = segZone([seg('b', T1, 100)])
      t.deepEqual(templates(z, { templateId: T0 }), [T1]) // the pick still happens…
      t.is(on(z, G.G01, { templateId: T0 }).verdict, 'eligible') // …but the visit's template wins
      t.deepEqual(templates(z, { segmentId: 'b' }), [T1]) // a named segment is pinned
      t.deepEqual(templates(z, { segmentId: 'nope' }), [T1]) // an unknown one falls back to the pick
    })
  }

  test('targeting rules beyond zoneId (#81) > geo: params.geoState is case-sensitive, the legacy geo field is not', t => {
    const h04 = g('H04', { params: { geoState: ['TX'] } })
    const at = (adGroup, geoState) => eligibility({ adGroup, zone: Z0, request: visitRequest(Z0, WEB, { geoState }) }).verdict
    t.is(at(h04, 'TX'), 'eligible')
    t.is(at(h04, 'tx'), 'excluded')
    t.is(at(G.G11, 'TX'), 'eligible')
    t.is(at(G.G11, 'tx'), 'eligible')
  })

  test('targeting rules beyond zoneId (#81) > a complete visit: an absent key excludes a whitelist and never fires a blacklist', t => {
    const req = visitRequest(Z0, WEB, {}, { complete: true })
    t.is(eligibility({ adGroup: g('pc', { params: { geoPostal: ['78701'] } }), zone: Z0, request: req }).verdict, 'excluded')
    t.is(eligibility({ adGroup: g('nx', { exceptParams: { geoPostal: ['78701'] } }), zone: Z0, request: req }).verdict, 'eligible')
    t.is(eligibility({ adGroup: G.G11, zone: Z0, request: req }).verdict, 'excluded')
  })

  test('targeting rules beyond zoneId (#81) > ad level: the ad excluding the zone template does not serve, its sibling does', t => {
    const req = zoneRequest(Z0, WEB)
    const v = eligibility({ adGroup: G.G13, zone: Z0, request: req })
    const [plain, blocked] = adsByGroup.G13
    t.true(adServesInZone(plain, Z0.id, req))
    t.false(adServesInZone(blocked, Z0.id, req))
    const o = offerEligibility({ group: v, adGroup: G.G13, ad: blocked, zone: Z0, request: req })
    t.is(o.verdict, 'excluded')
    t.deepEqual(o.reasons, ['ad-param-blacklisted'])
    const r = offerRollup({ group: v, adGroup: G.G13, ads: adsByGroup.G13, zone: Z0, isLive: LIVE, request: req })
    t.like(r, { total: 2, inScope: 1, freeRadical: 1, conditional: 0 })
    t.deepEqual(r.freeRadicalAdIds, ['G13-ad0'])
  })

  test('targeting rules beyond zoneId (#81) > adServesInZone without a request checks zoneId only, as before', t => {
    t.true(adServesInZone({ id: 'a', exceptParams: { templateId: [T0] } }, Z0.id))
  })

  test('targeting rules beyond zoneId (#81) > offers: a conditional group makes its offers conditional, counted in their own twins', t => {
    const req = zoneRequest(Z0, WEB)
    const v = eligibility({ adGroup: G.G05, zone: Z0, request: req })
    const r = offerRollup({ group: v, adGroup: G.G05, ads: [{ id: 'a1' }, { id: 'a2' }], zone: Z0, isLive: (ad) => ad.id === 'a1', request: req })
    t.like(r, { inScope: 0, live: 0, freeRadical: 0, conditional: 2, conditionalLive: 1, freeRadicalConditional: 2, freeRadicalConditionalLive: 1 })
  })

  test('targeting rules beyond zoneId (#81) > offers: a conditional ad under an eligible group is conditional', t => {
    const req = zoneRequest(Z0, WEB)
    const v = eligibility({ adGroup: G.G00, zone: Z0, request: req })
    const o = offerEligibility({ group: v, adGroup: G.G00, ad: { id: 'a', params: { deviceOs: ['ios'] } }, zone: Z0, request: req })
    t.is(o.verdict, 'conditional')
    t.true(o.freeRadical)
    t.false(o.serves)
  })

  { // live counts read from the offers (#91), through enrich() as the tool runs it
    const req = zoneRequest(Z0, WEB)
    const NOW = Date.parse('2026-06-15T12:00:00.000Z')
    const targeted = { ...G.G00, params: { zoneId: [Z0.id] } }
    const ad = (id, rules = {}) => ({ id, enabled: true, creativeId: 'cr1', ...rules })
    const geoOnly = [ad('a1', { params: { geoPostal: ['90210'] } }), ad('a2', { params: { geoState: ['TX'] } })]
    const complementary = [ad('b1', { params: { device: ['mobile'] } }), ad('b2', { exceptParams: { device: ['mobile'] } })]
    const mixed = [ad('c1', { params: { geoState: ['TX'] } }), ad('c2')]
    const rows = (specs) => {
      const adGroups = specs.map(([id, base, , campaignId = 'on']) => ({ ...base, id, enabled: true, campaignId }))
      const idx = {
        adGroups,
        campaigns: { on: { enabled: true }, off: { enabled: false } },
        adsByGroup: Object.fromEntries(specs.map(([id, , ads]) => [id, ads.map((a) => ({ ...a, adGroupId: id }))])),
        creatives: { cr1: {} }
      }
      const elig = adGroups.map((adGroup) => eligibility({ adGroup, zone: Z0, request: req }))
      return new Map(enrich(elig, idx, Z0, req, NOW).map((r) => [r.id, r]))
    }

    test('targeting rules beyond zoneId (#81) > live counts (#91): a targeted group whose live ads all depend on the visit is not counted live', t => {
      const byId = rows([['geoOnly', targeted, geoOnly], ['complementary', targeted, complementary], ['mixed', targeted, mixed], ['dormant', targeted, geoOnly, 'off']])
      const direct = [...byId.values()]
      t.true(direct.every((r) => r.verdict === 'eligible'))
      t.deepEqual(direct.map((r) => [r.id, r.fully_live]), [['geoOnly', true], ['complementary', true], ['mixed', true], ['dormant', false]])
      const s = summarizeEligibility(direct, [], [])
      t.like(s, { directlyTargeted: 4, directlyTargetedLive: 1, directlyTargetedLiveOnConditionalAds: 2, directlyTargetedConditional: 0 })
      t.true(eligibilityHeader(Z0, s).includes('4 targeted (1 live, 2 live only on conditional ads,'))
    })

    test('targeting rules beyond zoneId (#81) > live counts (#91): the same holds for free-radical hosts', t => {
      const s = summarizeEligibility([], [...rows([['geoOnly', G.G00, geoOnly], ['mixed', G.G00, mixed]]).values()], [])
      t.like(s, { freeRadicalHosts: 2, freeRadicalHostsLive: 1, freeRadicalHostsLiveOnConditionalAds: 1 })
      t.true(eligibilityHeader(Z0, s).includes('2 free-radical hosts (1 live, 1 live only on conditional ads)'))
    })

    test('targeting rules beyond zoneId (#81) > live counts (#91): a conditional group is live only through an ad that can serve with it', t => {
      const byId = rows([['clash', G.G05, [ad('d1', { exceptParams: { device: ['mobile'] } })]], ['fine', G.G05, [ad('d2')]], ['dormant', G.G05, [ad('d3')], 'off']])
      t.true(byId.get('clash').fully_live)
      t.is(byId.get('clash').verdict, 'conditional')
      t.is(byId.get('dormant').verdict, 'conditional')
      const s = summarizeEligibility([], [...byId.values()], [])
      t.like(s, { freeRadicalHostsConditional: 3, freeRadicalHostsConditionalLive: 1 })
      t.like(summarizeEligibility([...byId.values()], [], []), { directlyTargetedConditional: 3, directlyTargetedConditionalLive: 1 })
    })
  }

  test('targeting rules beyond zoneId (#81) > summary: conditional rows sit outside the eligible counts, with their own live twins', t => {
    const req = zoneRequest(Z0, WEB)
    const b = zoneEligibility(groups, Z0, adsByGroup, req)
    const enrich = (rows) => rows.map((e) => {
      const adGroup = G[e.adGroupId]
      return { id: e.adGroupId, verdict: e.verdict, eligible: e.eligible, conditions: e.conditions, offers: offerRollup({ group: e, adGroup, ads: adsByGroup[e.adGroupId], zone: Z0, isLive: LIVE, request: req }) }
    })
    const radicals = enrich(b.freeRadicals)
    const s = summarizeEligibility(enrich(b.directlyTargeted), radicals, [], [], {
      excludedByDefault: b.excludedByDefault,
      conditionKeys: conditionKeysOf(radicals, adsByGroup, Z0.id, req)
    })
    t.like(s, {
      directlyTargeted: 1,
      directlyTargetedIneligible: 1,
      directlyTargetedLive: 0,
      freeRadicalHosts: 5,
      freeRadicalHostsLive: 5,
      freeRadicalHostsConditional: 4,
      freeRadicalHostsConditionalLive: 4,
      freeRadicalOffers: 5,
      freeRadicalOffersConditional: 4,
      excludedByDefault: 2
    })
    t.deepEqual(s.conditionKeys, {
      device: { requires: { values: ['mobile'] }, excludes: { values: ['mobile'] }, groups: 3 },
      geoState: { requires: { values: ['TX'] }, groups: 1 }
    })
  })

  test('targeting rules beyond zoneId (#81) > reach: G01 serves in Z0 only, and Z1 is excluded by its template default', t => {
    const zones = [Z0, Z1]
    const r = adGroupReach(G.G01, zones, (z) => zoneRequest(z, WEB))
    t.deepEqual(r.map((e) => [e.zoneId, e.verdict]), [[Z0.id, 'eligible'], [Z1.id, 'excluded']])
    t.true(r[1].excludedByDefault)
    t.deepEqual(adGroupReach(G.G08, zones, (z) => zoneRequest(z, WEB)), [])
  })
}

{ // review fixes on #81
  const T0 = 'fbdmxz'
  const Z0 = { id: 'uz4dab', networkId: 'ybdob7', publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' } }
  const WEB = { id: 'ch1', type: 'Web' }
  const g = (id, extra = {}) => ({ id, creativeAssetGroupId: CAG, ...extra })
  const verdictOf = (adGroup, supplied, complete) => eligibility({ adGroup, zone: Z0, request: visitRequest(Z0, WEB, supplied, { complete }) })

  test('review fixes on #81 > a whitelist naming every device or deviceOs value is no rule', t => {
    t.is(verdictOf(g('d', { params: { device: ['desktop', 'mobile', 'tablet', 'smarttv', 'console', 'wearable', 'embedded'] } })).verdict, 'eligible')
    t.is(verdictOf(g('l', { devices: ['desktop', 'mobile', 'tablet', 'smarttv', 'console', 'wearable', 'embedded'] })).verdict, 'eligible')
    t.is(verdictOf(g('o', { params: { deviceOs: ['ios', 'android', 'other'] } })).verdict, 'eligible')
    t.is(verdictOf(g('six', { params: { device: ['desktop', 'mobile', 'tablet', 'smarttv', 'console', 'wearable'] } })).verdict, 'conditional')
  })

  test('review fixes on #81 > a blacklist naming every value excludes on every visit, with source always', t => {
    const e = verdictOf(g('x', { exceptParams: { deviceOs: ['ios', 'android', 'other'] } }))
    t.is(e.verdict, 'excluded')
    t.like(e.paramBlocks[0], { key: 'deviceOs', source: 'always', overridable: false })
    t.false(e.excludedByDefault)
  })

  test('review fixes on #81 > rules beyond zoneId are not evaluated for a group that cannot reach the zone', t => {
    const e = verdictOf(g('away', { params: { zoneId: ['other'], device: ['mobile'] } }), { device: 'desktop' })
    t.deepEqual(e.reasons, ['targets-other-zones'])
    t.deepEqual(e.paramBlocks, [])
    t.deepEqual(e.conditions, [])
  })

  test('review fixes on #81 > a complete visit always carries device, deviceOs and geoState', t => {
    t.is(verdictOf(g('a', { exceptParams: { device: ['desktop'] } }), {}, true).verdict, 'excluded')
    t.is(verdictOf(g('b', { params: { deviceOs: ['other'] } }), {}, true).verdict, 'eligible')
    t.is(verdictOf(g('c', { devices: ['desktop'] }), {}, true).verdict, 'eligible')
    t.is(verdictOf(g('d', { exceptParams: { geoState: [''] } }), {}, true).verdict, 'excluded')
    t.is(verdictOf(g('e', { exceptParams: { geoState: [''] } })).verdict, 'conditional')
  })

  test('review fixes on #81 > dateTime keys stay conditional on a complete visit unless supplied', t => {
    const daypart = g('t', { params: { dateTimeUTC: ['mon2'] } })
    t.is(verdictOf(daypart, { device: 'desktop' }, true).verdict, 'conditional')
    t.is(verdictOf(daypart, { dateTimeUTC: 'mon2' }, true).verdict, 'eligible')
    t.is(verdictOf(daypart, { dateTimeUTC: 'tue2' }, true).verdict, 'excluded')
    t.is(verdictOf(g('u', { exceptParams: { dateTimeUTC: ['mon2'] } }), {}, true).verdict, 'conditional')
  })

  test('review fixes on #81 > offers name the ads whose own rules depend on the visit', t => {
    const req = zoneRequest(Z0, WEB)
    const host = g('host')
    const ads = [{ id: 'plain' }, { id: 'ios', params: { deviceOs: ['ios'] } }, { id: 'noMobile', exceptParams: { device: ['mobile'] } }]
    const r = offerRollup({ group: eligibility({ adGroup: host, zone: Z0, request: req }), adGroup: host, ads, zone: Z0, isLive: LIVE, request: req })
    t.like(r, { inScope: 1, conditional: 2 })
    t.deepEqual(r.conditionalAds.map((a) => [a.adId, a.conditions[0].key, a.conditions[0].op]), [['ios', 'deviceOs', 'requires'], ['noMobile', 'device', 'excludes']])
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, params: { device: ['mobile'] } }))
    const capped = offerRollup({ group: eligibility({ adGroup: host, zone: Z0, request: req }), adGroup: host, ads: many, zone: Z0, isLive: LIVE, request: req })
    t.is(capped.conditional, 12)
    t.is(capped.conditionalAds.length, 10)
  })

  test('review fixes on #81 > an ad whitelisting the zone under a default-blocked group is not flagged inert', t => {
    const req = zoneRequest(Z0, WEB)
    const blockedByDefault = g('def', { params: { s1: ['xyz'] } })
    const ad = { id: 'wl', params: { zoneId: [Z0.id] } }
    const v = eligibility({ adGroup: blockedByDefault, zone: Z0, request: req })
    t.true(v.excludedByDefault)
    t.deepEqual(offerEligibility({ group: v, adGroup: blockedByDefault, ad, zone: Z0, request: req }).conflicts, [])
    const r = offerRollup({ group: v, adGroup: blockedByDefault, ads: [ad], zone: Z0, isLive: LIVE, request: req })
    t.is(r.inertWhitelisted, 0)
    const fixedBlock = g('fix', { params: { zoneType: ['Other'] } })
    const fv = eligibility({ adGroup: fixedBlock, zone: Z0, request: req })
    t.deepEqual(offerEligibility({ group: fv, adGroup: fixedBlock, ad, zone: Z0, request: req }).conflicts, ['inert-ad-level-whitelist'])
  })

  test('review fixes on #81 > the zone blacklist is reported as blacklisted, not as excluded', t => {
    const e = verdictOf(g('bl', { exceptParams: { zoneId: [Z0.id] } }))
    t.is(e.blacklisted, true)
    t.is(e.excluded, undefined)
    t.is(e.verdict, 'excluded')
  })
}

{ // re-review fixes on #81
  const T0 = 'fbdmxz'
  const T1 = '81bkz5'
  const Z0 = { id: 'uz4dab', networkId: 'ybdob7', publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc', n: 5 } }
  const WEB = { id: 'ch1', type: 'Web' }
  const g = (id, extra = {}) => ({ id, creativeAssetGroupId: CAG, ...extra })
  const seg = (id, templateId, trafficAllocation, extra = {}) => ({ id, templateId, trafficAllocation, ...extra })
  const segZone = (segments, extra = {}) => ({ ...Z0, id: 'zs', segmentsStatus: 'on', segments, ...extra })
  const templates = (zone, supplied) => visitRequest(zone, WEB, supplied).segments?.map((c) => c.templateId) ?? null
  const offer = (zone, adGroup, ad) => {
    const req = zoneRequest(zone, WEB)
    return offerEligibility({ group: eligibility({ adGroup, zone, request: req }), adGroup, ad, zone, request: req })
  }

  test('re-review fixes on #81 > a group rule and an ad rule that never hold together exclude the offer', t => {
    const o = offer(Z0, g('mob', { params: { device: ['mobile'] } }), { id: 'a', exceptParams: { device: ['mobile'] } })
    t.is(o.verdict, 'excluded')
    t.is(o.contradiction, 'device')
    t.true(o.reasons.includes('conditions-contradict'))
    const req = zoneRequest(Z0, WEB)
    const host = g('mob', { params: { device: ['mobile'] } })
    const r = offerRollup({ group: eligibility({ adGroup: host, zone: Z0, request: req }), adGroup: host, ads: [{ id: 'a', exceptParams: { device: ['mobile'] } }, { id: 'b' }], zone: Z0, isLive: LIVE, request: req })
    t.like(r, { conditional: 1, freeRadicalConditional: 1 })
  })

  test('re-review fixes on #81 > rules that can hold together stay conditional', t => {
    t.is(offer(Z0, g('mob', { params: { device: ['mobile'] } }), { id: 'a', params: { deviceOs: ['ios'] } }).verdict, 'conditional')
    t.is(offer(Z0, g('mt', { params: { device: ['mobile', 'tablet'] } }), { id: 'a', exceptParams: { device: ['mobile'] } }).verdict, 'conditional')
    t.is(offer(Z0, g('geo', { geo: ['TX'] }), { id: 'a', params: { geoState: ['tx'] } }).verdict, 'conditional') // mixed legacy/params: not judged
  })

  test('re-review fixes on #81 > a single entity whose own rules contradict is excluded', t => {
    const e = eligibility({ adGroup: g('self', { params: { device: ['mobile'] }, exceptParams: { device: ['mobile'] } }), zone: Z0, request: zoneRequest(Z0, WEB) })
    t.is(e.verdict, 'excluded')
    t.is(e.contradiction, 'device')
    t.false(e.excludedByDefault)
    const o = offer(Z0, g('ok'), { id: 'a', params: { s9: ['x'] }, exceptParams: { s9: ['x'] } })
    t.deepEqual(o.reasons, ['ad-conditions-contradict'])
    t.is(o.contradiction, 's9')
  })

  test('re-review fixes on #81 > blacklists that together name every value of a key never hold', t => {
    const o = offer(Z0, g('noApple', { exceptParams: { deviceOs: ['ios', 'android'] } }), { id: 'a', exceptParams: { deviceOs: ['other'] } })
    t.is(o.verdict, 'excluded')
    t.is(o.contradiction, 'deviceOs')
  })

  test('re-review fixes on #81 > on a segments zone, a group and an ad needing different templates never serve', t => {
    const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const o = offer(z, g('t0', { params: { templateId: [T0] } }), { id: 'a', params: { templateId: [T1] } })
    t.is(o.verdict, 'excluded')
    t.is(o.contradiction, 'templateId')
    t.is(offer(z, g('t0', { params: { templateId: [T0] } }), { id: 'a', exceptParams: { templateId: [T1] } }).verdict, 'conditional')
  })

  test('re-review fixes on #81 > contradiction ignores capped lists rather than guess', t => {
    const many = Array.from({ length: 25 }, (_, i) => `v${i}`)
    const conds = [
      { path: 'params.k', key: 'k', op: 'requires', values: many.slice(0, 20), valuesTotal: 25, source: 'request' },
      { path: 'exceptParams.k', key: 'k', op: 'excludes', values: many.slice(0, 20), valuesTotal: 20, source: 'request' }
    ]
    t.is(contradiction(conds), null)
  })

  test('re-review fixes on #81 > segment lists compare strictly, as lincx-core does', t => {
    t.deepEqual(templates(segZone([seg('s', T1, 100, { allowlist: { n: ['5'] } })])), [T0])
    t.deepEqual(templates(segZone([seg('s', T1, 100, { allowlist: { n: [5] } })])), [T1])
  })

  test('re-review fixes on #81 > the zone\'s own lists decide whether its template competes', t => {
    t.deepEqual(templates(segZone([seg('s', T1, 50)], { blocklist: { s1: ['abc'] } })), [T1])
    t.deepEqual(templates(segZone([seg('s', T1, 50)], { allowlist: { s1: ['abc'] } })), [T1, T0])
    t.deepEqual(templates(segZone([seg('s', T1, 50)], { allowlist: { device: ['mobile'] } })), [T1, T0])
  })

  test('re-review fixes on #81 > personaTrafficAllocation scales a segment\'s share', t => {
    t.deepEqual(templates(segZone([seg('s', T1, 100, { personaTrafficAllocation: 50 })])), [T1, T0])
    t.deepEqual(templates(segZone([seg('s', T1, 100)])), [T1])
  })

  test('re-review fixes on #81 > only a zone with no segment to pin and failing lists is refused on every visit', t => {
    const dead = segZone([], { allowlist: { zoneType: ['Other'] } })
    t.true(refusesEveryVisit(zoneRequest(dead, WEB)))
    t.is(zoneRequest(dead, WEB).segments, null)
    t.false(refusesEveryVisit(zoneRequest(segZone([]), WEB)))
    const maybe = segZone([seg('s', T1, 100, { allowlist: { device: ['mobile'] } })], { allowlist: { zoneType: ['Other'] } })
    t.false(refusesEveryVisit(zoneRequest(maybe, WEB)))
    t.false(refusesEveryVisit(zoneRequest(Z0, WEB)))
  })

  test('review round 4 on #81 > a zone whose segments no unpinned visit reaches still serves pinned visits', t => {
    for (const z of [
      segZone([seg('s', T1, 100, { allowlist: { zoneType: ['Other'] } })], { allowlist: { zoneType: ['Other'] } }),
      segZone([seg('s', T1, 0)], { allowlist: { zoneType: ['Other'] } })
    ]) {
      const req = zoneRequest(z, WEB)
      t.false(refusesEveryVisit(req))
      t.deepEqual(segmentPickFlags(req), { servesOnlyPinnedVisits: true })
      t.deepEqual(req.segments.map((c) => c.segmentId), ['s'])
    }
  })

  test('review round 4 on #81 > a list on templateId that only a visit template passes is not a refusal (F1)', t => {
    const z = segZone([seg('s', T1, 100, { allowlist: { templateId: [T1] } })], { allowlist: { templateId: [T1] } })
    const req = zoneRequest(z, WEB)
    t.false(refusesEveryVisit(req))
    t.true(refusesDefaultVisits(req))
    t.deepEqual(req.overriddenOnServedVisits, ['templateId'])
    t.is(req.segments, null) // every served visit names its own template, which wins
  })

  test('review round 5 on #81 > when only a templateId override is served, template rules read as visit conditions, not the default (G1)', t => {
    const z = segZone([], { allowlist: { templateId: [T1] } })
    const req = zoneRequest(z, WEB)
    t.deepEqual(segmentPickFlags(req), { refusesDefaultVisits: true, overriddenOnServedVisits: ['templateId'] })
    const needs = (tpl) => eligibility({ adGroup: g(tpl, { params: { templateId: [tpl] } }), zone: z, request: req })
    t.is(needs(T0).verdict, 'conditional') // was 'eligible' on the default T0, which is never served
    t.is(needs(T1).verdict, 'conditional') // was excludedByDefault, though only T1 visits are served
    t.like(needs(T1).conditions[0], { key: 'templateId', source: 'request' })
    t.false(needs(T1).excludedByDefault)
  })

  test('review round 4 on #81 > a named templateId still goes through the segment pick, and its refusal (F1)', t => {
    const dead = segZone([], { allowlist: { zoneType: ['Other'] } })
    t.true(refusesEveryVisit(visitRequest(dead, WEB, { templateId: T1 }, { complete: true })))
    // The pick still sets segmentId even when the visit names its own template.
    const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const visit = visitRequest(z, WEB, { templateId: 'T9', segmentId: 'a' }, { complete: true })
    t.is(eligibility({ adGroup: { id: 'g', creativeAssetGroupId: CAG, params: { segmentId: ['a'], templateId: ['T9'] } }, zone: z, request: visit }).verdict, 'eligible')
  })

  test('review round 4 on #81 > rows of a zone refusing default visits read the rejected defaults as visit keys (F2)', t => {
    const z = segZone([seg('s', T1, 100, { allowlist: { s1: ['xyz'] } })], { allowlist: { s1: ['xyz'] } })
    const req = zoneRequest(z, WEB)
    t.deepEqual(segmentPickFlags(req), { refusesDefaultVisits: true, overriddenOnServedVisits: ['s1'] })
    const e = eligibility({ adGroup: g('abc', { params: { s1: ['abc'] } }), zone: z, request: req })
    t.is(e.verdict, 'conditional')
    t.like(e.conditions[0], { key: 's1', op: 'requires', source: 'request' })
    t.is(eligibility({ adGroup: g('n'), zone: z, request: req }).verdict, 'eligible')
  })

  test('review round 4 on #81 > a hard contradiction on a visit key is reported before an overridable template clash (F4)', t => {
    const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const e = eligibility({ adGroup: g('both', { params: { templateId: [T0, 'T2'], device: ['mobile'] }, exceptParams: { templateId: [T0], device: ['mobile'] } }), zone: z, request: zoneRequest(z, WEB) })
    t.is(e.contradiction, 'device')
    t.is(e.contradictionOverridable, undefined)
    t.false(e.excludedByDefault)
  })

  test('re-review fixes on #81 > lists failing only on a zone default refuse the default visit, not every visit', t => {
    const z = segZone([seg('s', T1, 100, { allowlist: { s1: ['xyz'] } })], { allowlist: { s1: ['xyz'] } })
    const req = zoneRequest(z, WEB)
    t.false(refusesEveryVisit(req))
    t.true(refusesDefaultVisits(req))
    t.deepEqual(req.segments.map((c) => c.templateId), [T1, T0])
    const visit = visitRequest(z, WEB, { s1: 'xyz' })
    t.false(refusesDefaultVisits(visit))
    t.deepEqual(visit.segments.map((c) => c.templateId), [T1])
    t.false(refusesDefaultVisits(zoneRequest(segZone([seg('s', T1, 100)]), WEB)))
  })

  test('re-review fixes on #81 > a segment past a cumulative 100% is never picked', t => {
    t.deepEqual(templates(segZone([seg('a', T0, 100), seg('b', T1, 50)])), [T0])
    t.deepEqual(templates(segZone([seg('a', T0, 60), seg('b', T1, 60)])), [T0, T1])
    t.deepEqual(templates(segZone([seg('a', T0, 100, { allowlist: { device: ['mobile'] } }), seg('b', T1, 50)])), [T0, T1, T0])
  })

  test('re-review fixes on #81 > a template contradiction a visit templateId can satisfy is overridable', t => {
    const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const req = zoneRequest(z, WEB)
    const e = eligibility({ adGroup: g('t02', { params: { templateId: [T0, 'T2'] }, exceptParams: { templateId: [T0] } }), zone: z, request: req })
    t.is(e.verdict, 'excluded')
    t.is(e.contradiction, 'templateId')
    t.true(e.contradictionOverridable)
    t.true(e.excludedByDefault)
    t.is(eligibility({ adGroup: g('t02'), zone: z, request: visitRequest(z, WEB, { templateId: 'T2' }) }).verdict, 'eligible')
    const b = zoneEligibility([g('t02', { params: { templateId: [T0, 'T2'] }, exceptParams: { templateId: [T0] } })], z, {}, req)
    t.deepEqual(b.excludedByDefault.map((x) => x.adGroupId), ['t02'])
    const never = eligibility({ adGroup: g('nv', { params: { templateId: [T0] }, exceptParams: { templateId: [T0] } }), zone: z, request: req })
    t.is(never.contradiction, 'templateId')
    t.is(never.contradictionOverridable, undefined)
    t.false(never.excludedByDefault)
    const o = offer(z, g('t0', { params: { templateId: [T0, 'T2'] } }), { id: 'a', params: { templateId: [T1, 'T2'] } })
    t.is(o.verdict, 'excluded')
    t.true(o.contradictionOverridable)
  })

  test('re-review fixes on #81 > conditionKeys ignores an ad that contradicts its group', t => {
    const req = zoneRequest(Z0, WEB)
    const host = g('mob', { params: { device: ['mobile'] } })
    const rows = [{ id: host.id, ...eligibility({ adGroup: host, zone: Z0, request: req }) }]
    const keys = conditionKeysOf(rows, { mob: [{ id: 'a', exceptParams: { device: ['mobile'] }, params: { deviceOs: ['ios'] } }] }, Z0.id, req)
    t.deepEqual(keys, { device: { requires: { values: ['mobile'] }, groups: 1 } })
  })

  test('re-review fixes on #81 > conditionKeys keeps requires and excludes apart and marks segment keys', t => {
    const z = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const req = zoneRequest(z, WEB)
    const rows = [g('t0', { params: { templateId: [T0] } }), g('mob', { params: { device: ['mobile'] } }), g('never', { exceptParams: { device: ['tablet'] } })]
      .map((adGroup) => ({ id: adGroup.id, ...eligibility({ adGroup, zone: z, request: req }) }))
    t.deepEqual(conditionKeysOf(rows, {}, z.id, req), {
      device: { requires: { values: ['mobile'] }, excludes: { values: ['tablet'] }, groups: 2 },
      templateId: { requires: { values: [T0] }, groups: 1, segment: true }
    })
  })
}

{ // review of #85
  const T0 = 'fbdmxz'
  const T1 = '81bkz5'
  const Z0 = { id: 'uz4dab', networkId: 'ybdob7', publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' } }
  const WEB = { id: 'ch1', type: 'Web' }
  const g = (id, extra = {}) => ({ id, creativeAssetGroupId: CAG, ...extra })
  const seg = (id, templateId, trafficAllocation, extra = {}) => ({ id, templateId, trafficAllocation, ...extra })
  const segZone = (segments, extra = {}) => ({ ...Z0, id: 'zs', segmentsStatus: 'on', segments, ...extra })
  const verdictOf = (adGroup, zone = Z0) => eligibility({ adGroup, zone, request: zoneRequest(zone, WEB) })

  test('review of #85 > slot blocks (position keys) are applied after selection, so they are no rule here', t => {
    for (const key of ['position', 'zoneId-position', 'templateId-position']) {
      const e = verdictOf(g(key, { exceptParams: { [key]: ['1', `${Z0.id}-2`, `${T0}-3`] } }))
      t.is(e.verdict, 'eligible', key)
      t.deepEqual(e.conditions, [])
    }
    t.is(offerEligibility({ group: verdictOf(g('host')), adGroup: g('host'), ad: { id: 'a', exceptParams: { position: ['0'] } }, zone: Z0, request: zoneRequest(Z0, WEB) }).verdict, 'eligible')
  })

  test('review of #85 > a hard contradiction keeps a default-blocked group out of excludedByDefault', t => {
    const e = verdictOf(g('both', { params: { s1: ['xyz'], device: ['mobile'] }, exceptParams: { device: ['mobile'] } }))
    t.is(e.verdict, 'excluded')
    t.is(e.contradiction, 'device')
    t.false(e.excludedByDefault)
    t.true(verdictOf(g('only', { params: { s1: ['xyz'] } })).excludedByDefault)
    const ad = adVerdict({ id: 'a', params: { s9: ['x'], templateId: [T1] }, exceptParams: { s9: ['x'] } }, Z0.id, zoneRequest(Z0, WEB))
    t.is(ad.verdict, 'excluded')
    t.is(ad.clash.key, 's9')
  })

  test('review of #85 > segmentId is set by the segment pick, like templateId', t => {
    const one = segZone([seg('s1', T1, 100)])
    const e = verdictOf(g('pinned', { params: { segmentId: ['s1'] } }), one)
    t.is(e.verdict, 'eligible')
    t.deepEqual(e.matchedKeys, [{ path: 'params.segmentId', key: 'segmentId', value: ['s1'], source: 'segment' }])
    const two = segZone([seg('a', T0, 50), seg('b', T1, 50)])
    const c = verdictOf(g('onA', { params: { segmentId: ['a'] } }), two)
    t.is(c.verdict, 'conditional')
    t.deepEqual(c.conditions[0].candidates.map((x) => [x.segmentId, x.passes]), [['a', true], ['b', false]])
    const zoneItself = segZone([seg('a', T1, 50)])
    t.deepEqual(verdictOf(g('z', { params: { segmentId: [zoneItself.id] } }), zoneItself).conditions[0].candidates.map((x) => x.passes), [false, true])
    t.is(verdictOf(g('never', { params: { segmentId: ['nope'] } }), one).verdict, 'excluded')
    t.is(verdictOf(g('off', { params: { segmentId: ['s1'] } })).conditions[0].source, 'request') // segments off: a visit key
  })

  test('review of #85 > a key carrying a legacy geo rule is never judged a contradiction', t => {
    t.is(contradiction([
      { path: 'geo', key: 'geoState', op: 'requires', values: ['TX'], valuesTotal: 1, source: 'request' },
      { path: 'exceptParams.geoState', key: 'geoState', op: 'excludes', values: ['TX'], valuesTotal: 1, source: 'request' }
    ]), null)
  })

  /**
   * The no-visit answer must agree with every complete visit built from the fixture's
   * own conditions: eligible → eligible on all of them; conditional → served on one
   * and refused on another; excluded → refused on all. This checks the join against
   * itself, not against lincx-core: a key lincx-core ignores but this module treats
   * as a visit key (the position keys were one) passes here and only shows up in the
   * live parity run against /api/ads/ad.
   */
  test('review of #85 > the no-visit verdict agrees with every complete visit', t => {
    const zones = [Z0, segZone([seg('a', T0, 50), seg('b', T1, 50)])]
    const groups = [
      g('plain'), g('t0', { params: { templateId: [T0] } }), g('notT0', { exceptParams: { templateId: [T0] } }),
      g('s1abc', { params: { s1: ['abc'] } }), g('s1xyz', { params: { s1: ['xyz'] } }),
      g('mobile', { params: { device: ['mobile'] } }), g('notMobile', { exceptParams: { device: ['mobile'] } }),
      g('tx', { geo: ['TX'] }), g('ios', { params: { deviceOs: ['ios'] } }), g('postal', { params: { geoPostal: ['78701'] } }),
      g('mon2', { params: { dateTimeUTC: ['mon2'] } }), g('clash', { params: { device: ['mobile'] }, exceptParams: { device: ['mobile'] } }),
      g('slot', { exceptParams: { position: ['1'] } }), g('onA', { params: { segmentId: ['a'] } })
    ]
    const visits = []
    for (const device of ['desktop', 'mobile']) {
      for (const deviceOs of ['other', 'ios']) {
        for (const geoState of ['', 'TX']) {
          for (const extra of [{}, { geoPostal: '78701' }, { dateTimeUTC: 'mon2' }, { dateTimeUTC: 'tue3' }]) {
            visits.push({ device, deviceOs, geoState, dateTimeUTC: 'sun0', ...extra })
          }
        }
      }
    }
    for (const zone of zones) {
      // On a segments zone the pick sets segmentId; elsewhere a visit may send one.
      const segIds = zone.segmentsStatus === 'on' ? [undefined, ...zone.segments.map((x) => x.id)] : [undefined, 'a']
      for (const adGroup of groups) {
        const none = eligibility({ adGroup, zone, request: zoneRequest(zone, WEB) })
        if (none.excludedByDefault) continue // a visit overriding the default changes it; not varied here
        const outcomes = visits.flatMap((visit) => segIds.map((segmentId) =>
          eligibility({ adGroup, zone, request: visitRequest(zone, WEB, { ...visit, ...(segmentId ? { segmentId } : {}) }, { complete: true }) }).verdict))
        const label = `${zone.id} ${adGroup.id}: ${none.verdict}`
        if (none.verdict === 'eligible') t.true(outcomes.every((v) => v === 'eligible'), label)
        if (none.verdict === 'excluded') t.true(outcomes.every((v) => v === 'excluded'), label)
        if (none.verdict === 'conditional') t.true(outcomes.includes('eligible') && outcomes.includes('excluded'), label)
      }
    }
  })
}

{ // verification of the #85 fixes
  const T0 = 'fbdmxz'
  const T1 = '81bkz5'
  const Z0 = { id: 'uz4dab', networkId: 'ybdob7', publisherId: 'pub1', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, dataAttributesDefault: { s1: 'abc' } }
  const WEB = { id: 'ch1', type: 'Web' }
  const g = (id, extra = {}) => ({ id, creativeAssetGroupId: CAG, ...extra })
  const seg = (id, templateId, trafficAllocation, extra = {}) => ({ id, templateId, trafficAllocation, ...extra })
  const two = { ...Z0, id: 'zs', segmentsStatus: 'on', segments: [seg('a', T0, 50), seg('b', T1, 50)] }
  const verdictOf = (adGroup, zone = two) => eligibility({ adGroup, zone, request: zoneRequest(zone, WEB) })
  const templateClash = { params: { templateId: [T0, 'T2'] }, exceptParams: { templateId: [T0] } }

  test('verification of the #85 fixes > a block no visit can lift keeps an overridable clash out of excludedByDefault', t => {
    const fixed = verdictOf(g('fixed', { params: { ...templateClash.params, zoneType: ['Other'] }, exceptParams: templateClash.exceptParams }))
    t.is(fixed.verdict, 'excluded')
    t.true(fixed.contradictionOverridable)
    t.false(fixed.excludedByDefault)
    const always = verdictOf(g('always', { params: templateClash.params, exceptParams: { ...templateClash.exceptParams, device: DEVICES_ALL } }))
    t.false(always.excludedByDefault)
    t.true(verdictOf(g('clashOnly', templateClash)).excludedByDefault)
  })

  test('verification of the #85 fixes > a segmentId rule is overridable only if it names a segment the zone has', t => {
    const nope = verdictOf(g('nope', { params: { segmentId: ['nope'] } }), { ...two, segments: [seg('a', T0, 100)] })
    t.is(nope.verdict, 'excluded')
    t.false(nope.excludedByDefault)
    t.false(nope.paramBlocks[0].overridable)
    const unreachable = { ...two, segments: [seg('a', T0, 100), seg('b', T1, 50)] } // b is past 100%: never picked, but pinnable
    const pinB = verdictOf(g('pinB', { params: { segmentId: ['b'] } }), unreachable)
    t.true(pinB.paramBlocks[0].overridable)
    t.true(pinB.excludedByDefault)
  })

  test('verification of the #85 fixes > a segmentId clash is "never" unless some existing segment satisfies it', t => {
    const req = zoneRequest(two, WEB)
    const hard = offerEligibility({ group: verdictOf(g('onA', { params: { segmentId: ['a'] } })), adGroup: g('onA', { params: { segmentId: ['a'] } }), ad: { id: 'x', params: { segmentId: ['b'] } }, zone: two, request: req })
    t.is(hard.verdict, 'excluded')
    t.is(hard.contradiction, 'segmentId')
    t.is(hard.contradictionOverridable, undefined)
    const three = { ...two, segments: [seg('a', T0, 50), seg('b', T1, 50), seg('c', T1, 10)] } // c never picked, but pinnable
    const req3 = zoneRequest(three, WEB)
    const host = g('ac', { params: { segmentId: ['a', 'c'] } })
    const soft = offerEligibility({ group: eligibility({ adGroup: host, zone: three, request: req3 }), adGroup: host, ad: { id: 'y', params: { segmentId: ['b', 'c'] } }, zone: three, request: req3 })
    t.is(soft.verdict, 'excluded')
    t.true(soft.contradictionOverridable)
  })
}

const DEVICES_ALL = ['desktop', 'mobile', 'tablet', 'smarttv', 'console', 'wearable', 'embedded']

{ // segmentName from the pick
  const T0 = 'fbdmxz'
  const T1 = '81bkz5'
  const WEB = { id: 'ch1', type: 'Web' }
  const zone = { id: 'zn', name: 'Zone N', networkId: 'n', publisherId: 'p', creativeAssetGroupId: CAG, type: 'Display', templateId: T0, segmentsStatus: 'on', segments: [{ id: 'a', name: 'segA', templateId: T0, trafficAllocation: 50 }, { id: 'b', name: 'segB', templateId: T1, trafficAllocation: 50 }] }
  const verdictOf = (params, z = zone) => eligibility({ adGroup: { id: 'g', creativeAssetGroupId: CAG, params }, zone: z, request: zoneRequest(z, WEB) })

  test('segmentName from the pick > a segmentName rule is decided per candidate, like segmentId', t => {
    const e = verdictOf({ segmentName: ['segA'] })
    t.is(e.verdict, 'conditional')
    t.deepEqual(e.conditions[0].candidates.map((c) => [c.segmentName, c.passes]), [['segA', true], ['segB', false]])
    const one = { ...zone, segments: [zone.segments[0]], ...{} }
    one.segments = [{ ...zone.segments[0], trafficAllocation: 100 }]
    t.is(verdictOf({ segmentName: ['segA'] }, one).verdict, 'eligible')
    const zoneItself = { ...zone, segments: [{ id: 'b', name: 'segB', templateId: T1, trafficAllocation: 50 }] }
    t.deepEqual(verdictOf({ segmentName: ['Zone N'] }, zoneItself).conditions[0].candidates.map((c) => c.passes), [false, true])
  })

  test('segmentName from the pick > a name no segment has is never overridable', t => {
    const one = { ...zone, segments: [{ id: 'a', name: 'segA', templateId: T0, trafficAllocation: 100 }] }
    const nope = verdictOf({ segmentName: ['nope'] }, one)
    t.is(nope.verdict, 'excluded')
    t.false(nope.excludedByDefault)
    const pastCap = { ...zone, segments: [{ id: 'a', name: 'segA', templateId: T0, trafficAllocation: 100 }, { id: 'c', name: 'segC', templateId: T1, trafficAllocation: 10 }] }
    t.true(verdictOf({ segmentName: ['segC'] }, pastCap).excludedByDefault) // never picked, but pinnable
  })

  test('segmentName from the pick > a visit cannot set segmentName on a segments zone; it can elsewhere', t => {
    const visit = visitRequest(zone, WEB, { segmentName: 'segB', segmentId: 'a' }, { complete: true })
    t.is(eligibility({ adGroup: { id: 'g', creativeAssetGroupId: CAG, params: { segmentName: ['segA'] } }, zone, request: visit }).verdict, 'eligible')
    const plain = { ...zone, segmentsStatus: 'off' }
    t.is(verdictOf({ segmentName: ['segA'] }, plain).conditions[0].source, 'request')
  })
}
