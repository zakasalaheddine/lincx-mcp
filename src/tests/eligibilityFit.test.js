/**
 * fitEligibility — the B5 contract: a zone too big for one response is PAGED,
 * never degraded. Every returned row keeps its full field set (offers,
 * scoped_via, via, reasons, conflicts); rows that don't fit are reachable via
 * offset; summary stays exact over the whole set at every offset/bucket.
 *
 * Scale mirrors the 2026-08-03 review fixture: zone 8z7wzb, 83 directly
 * targeted + 124 free-radical groups, which measured ~118k chars unpaged
 * against a 30k guard.
 */
import test from 'ava'
import { fitEligibility, summarizeEligibility } from '../tools/zoneEligibilityTools.js'

const LIMIT = 30_000
const ZONE = '8z7wzb'
const CAG = '0bckt2'

const offers = (o = {}) => ({
  total: 3,
  inScope: 3,
  live: 3,
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

const row = (id, targeted) => ({
  id,
  name: `Some Advertiser — Campaign ${id} (US Desktop)`,
  archived: false,
  campaign_on: true,
  adgroup_on: true,
  has_enabled_ad: true,
  creative_resolves: true,
  has_live_viable_ad: true,
  fully_live: true,
  off_reason: [],
  scoped_via: targeted ? ['ad-group-whitelist', 'zone-selection'] : ['zone-selection'],
  eligible: true,
  via: targeted ? ['ad-group-whitelist', 'zone-selection'] : ['zone-selection'],
  reasons: [],
  conflicts: [],
  offers: targeted ? offers() : offers({ freeRadical: 3, freeRadicalAdIds: ['ad000001', 'ad000002', 'ad000003'] })
})

const payload = (nDirect, nRadical, nConflict = 0, nInert = 0) => {
  const direct = Array.from({ length: nDirect }, (_, i) => row(`d${i}`, true))
  const radicals = Array.from({ length: nRadical }, (_, i) => row(`r${i}`, false))
  const conflict = Array.from({ length: nConflict }, (_, i) => row(`c${i}`, true))
  const inert = Array.from({ length: nInert }, (_, i) => ({
    ...row(`i${i}`, false),
    eligible: false,
    reasons: ['targets-other-zones'],
    conflicts: ['inert-ad-level-whitelist'],
    scoped_via: ['ad-level-whitelist', 'zone-selection'],
    offers: offers({ inScope: 0, adLevelTargeted: 1, inertWhitelisted: 1, inertWhitelistedAdIds: ['adX'] })
  }))
  return {
    zone: { id: ZONE, name: 'Some Zone Name', creativeAssetGroupId: CAG, templateId: 'tpl1' },
    summary: summarizeEligibility(direct, radicals, conflict, inert),
    directlyTargeted: direct,
    freeRadicals: radicals,
    conflicting: conflict,
    inertWhitelists: inert,
    scan: { zonesScanned: 300, adGroupsScanned: 900, campaignsScanned: 400, adsScanned: 3000, creativesScanned: 1344 }
  }
}

const parse = (r) => {
  const text = r.content[0].text
  const body = text.slice(text.indexOf('\n\n') + 2)
  return { header: text.slice(0, text.indexOf('\n\n')), json: JSON.parse(body) }
}
const size = (r) => JSON.stringify(r).length

/** Walk every page of a bucket, returning the concatenated rows. */
function walk (full, bucket) {
  const rows = []
  let offset = 0
  let pages = 0
  while (offset !== undefined) {
    const { json } = parse(fitEligibility(full, bucket, offset, LIMIT))
    for (const k of ['directlyTargeted', 'freeRadicals', 'conflicting', 'inertWhitelists']) {
      if (Array.isArray(json[k])) rows.push(...(json[k]))
    }
    offset = json.page?.next_offset
    if (++pages > 50) throw new Error('paging did not terminate')
  }
  return { rows, pages }
}

const FIELDS = ['offers', 'scoped_via', 'via', 'reasons', 'conflicts', 'fully_live', 'off_reason', 'eligible']

{ // fitEligibility — small zone fits in one call (B1–B4)
  const full = payload(5, 4, 1)
  const { header, json } = parse(fitEligibility(full, 'all', 0, LIMIT))

  test('fitEligibility — small zone fits in one call (B1–B4) > returns every bucket in full, complete:true, no next_offset', t => {
    t.is(json.complete, true)
    t.is(json.page.next_offset, undefined)
    t.is(json.directlyTargeted.length, 5)
    t.is(json.freeRadicals.length, 4)
    t.is(json.conflicting.length, 1)
  })

  test('fitEligibility — small zone fits in one call (B1–B4) > B1/B2 — array lengths match the summary counts one-for-one', t => {
    t.is(json.directlyTargeted.length, json.summary.directlyTargeted)
    t.is(json.freeRadicals.length, json.summary.freeRadicalHosts)
    t.is(json.conflicting.length, json.summary.conflicting)
  })

  test('fitEligibility — small zone fits in one call (B1–B4) > header states exact counts and no page warning', t => {
    t.true(header.includes('5 targeted'))
    t.false(header.includes('PARTIAL PAGE'))
  })
}

{ // fitEligibility — the inertWhitelists bucket
  const full = payload(5, 4, 1, 3)

  test('fitEligibility — the inertWhitelists bucket > is selectable on its own and returns only inert rows', t => {
    const { json } = parse(fitEligibility(full, 'inertWhitelists', 0, LIMIT))
    t.is(json.inertWhitelists.length, 3)
    t.is(json.directlyTargeted, undefined)
    t.is(json.page.total, 3)
    for (const r of json.inertWhitelists) {
      t.true(r.conflicts.includes('inert-ad-level-whitelist'))
      t.is(r.offers.inertWhitelisted, 1)
      t.is(r.eligible, false) // nothing here serves
      t.is(r.offers.inScope, 0)
    }
  })

  test('fitEligibility — the inertWhitelists bucket > counts at both grains in the summary and rides in bucket:\'all\'', t => {
    const { header, json } = parse(fitEligibility(full, 'all', 0, LIMIT))
    t.is(json.summary.inertWhitelistGroups, 3)
    t.is(json.summary.inertWhitelistOffers, 3)
    t.is(json.page.total, 13) // 5 + 4 + 1 + 3
    t.true(header.includes('INERT ad-level whitelists'))
  })

  test('fitEligibility — the inertWhitelists bucket > stays out of the reconciliation buckets', t => {
    const { json } = parse(fitEligibility(full, 'all', 0, LIMIT))
    const ids = (k) => (json[k]).map((r) => r.id)
    for (const id of ids('inertWhitelists')) {
      t.false(ids('directlyTargeted').includes(id))
      t.false(ids('conflicting').includes(id))
    }
    // directlyTargeted + conflicting is unchanged by the new bucket.
    t.is(json.summary.directlyTargeted + json.summary.conflicting, 6)
  })

  test('fitEligibility — the inertWhitelists bucket > says nothing in the header when there is no dead config', t => {
    const { header } = parse(fitEligibility(payload(5, 4, 1, 0), 'all', 0, LIMIT))
    t.false(header.includes('INERT'))
  })
}

{ // fitEligibility — review fixture scale, 83 + 124 (B5)
  const full = payload(83, 124)

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > stays under the response guard', t => {
    t.true(size(fitEligibility(full, 'all', 0, LIMIT)) <= LIMIT)
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > B5 — every returned row keeps its FULL field set (no id-string degradation)', t => {
    const { json } = parse(fitEligibility(full, 'all', 0, LIMIT))
    const rows = [...json.directlyTargeted, ...json.freeRadicals]
    t.true(rows.length > 0)
    for (const r of rows) {
      t.is(typeof r, 'object')
      for (const f of FIELDS) t.not(r[f], undefined)
      t.true(Object.keys(r.offers).includes('freeRadical'))
    }
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > signals the partial page in both the body and the header', t => {
    const { header, json } = parse(fitEligibility(full, 'all', 0, LIMIT))
    t.is(json.complete, false)
    t.is(json.page.next_offset, json.page.returned)
    t.is(json.page.total, 207)
    t.true(header.includes('PARTIAL PAGE'))
    t.true(header.includes('offset:'))
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > summary is exact over the WHOLE set at every offset', t => {
    for (const offset of [0, 40, 150, 206]) {
      const { json } = parse(fitEligibility(full, 'all', offset, LIMIT))
      t.deepEqual(json.summary, full.summary)
      t.is(json.summary.directlyTargeted, 83)
      t.is(json.summary.freeRadicalHosts, 124)
      t.is(json.summary.freeRadicalOffers, 372) // 124 radical groups × 3 free-radical ads
    }
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > paging is lossless — each row exactly once, no gaps, no duplicates', t => {
    const { rows, pages } = walk(full, 'all')
    t.true(pages > 1)
    t.is(rows.length, 207)
    const ids = rows.map((r) => r.id)
    t.is(new Set(ids).size, 207)
    t.deepEqual(ids, [...full.directlyTargeted, ...full.freeRadicals].map((r) => r.id))
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > bucket:\'freeRadicals\' returns only free radicals, still fully paged and lossless', t => {
    const { json } = parse(fitEligibility(full, 'freeRadicals', 0, LIMIT))
    t.is(json.directlyTargeted, undefined)
    t.is(json.conflicting, undefined)
    t.is(json.page.total, 124)
    t.is(json.summary.directlyTargeted, 83) // summary unaffected by the bucket filter
    const { rows } = walk(full, 'freeRadicals')
    t.deepEqual(rows.map((r) => r.id), full.freeRadicals.map((r) => r.id))
    for (const r of rows) t.is(r.offers.freeRadical, 3)
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > every page stays under the guard', t => {
    let offset = 0
    while (offset !== undefined) {
      const result = fitEligibility(full, 'all', offset, LIMIT)
      t.true(size(result) <= LIMIT)
      offset = parse(result).json.page?.next_offset
    }
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > an offset past the end returns an empty page (never an error), and never claims complete', t => {
    const { json } = parse(fitEligibility(full, 'all', 999, LIMIT))
    t.is(json.page.returned, 0)
    t.deepEqual(json.directlyTargeted, [])
    t.is(json.complete, false) // 0 rows is not the whole answer
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > a TAIL page never claims complete — complete means this one response holds everything', t => {
    // Walk to the last page: it has no next_offset but is only a slice of 207.
    let offset = 0; let last
    while (true) {
      const { json } = parse(fitEligibility(full, 'all', offset, LIMIT))
      last = json
      if (json.page.next_offset === undefined) break
      offset = json.page.next_offset
    }
    t.true(offset > 0)
    t.true(last.page.returned < last.page.total)
    t.is(last.complete, false)
  })

  /** …and says so in the header. Field-reported twice as "complete is broken", so the
   * tail page states the rule instead of leaving it to be inferred from the flag. */
  test('fitEligibility — review fixture scale, 83 + 124 (B5) > the tail page header announces FINAL PAGE and why complete is false', t => {
    let offset = 0; let header = ''
    while (true) {
      const result = fitEligibility(full, 'all', offset, LIMIT)
      header = result.content[0].text.split('\n')[0]
      const { json } = parse(result)
      if (json.page.next_offset === undefined) break
      offset = json.page.next_offset
    }
    t.true(header.includes('FINAL PAGE'))
    t.true(header.includes('no next_offset'))
    t.false(header.includes('PARTIAL PAGE'))
  })

  test('fitEligibility — review fixture scale, 83 + 124 (B5) > complete:true implies the arrays equal the full selected slice (the B1/B2 key)', t => {
    for (const bucket of ['all', 'directlyTargeted', 'freeRadicals', 'conflicting']) {
      for (const offset of [0, 5, 90, 999]) {
        const { json } = parse(fitEligibility(full, bucket, offset, LIMIT))
        if (!json.complete) continue
        t.is(json.page.offset, 0)
        t.is(json.page.returned, json.page.total)
      }
    }
  })
}

// fitEligibility — pathological single oversize row
test('fitEligibility — pathological single oversize row > falls back to ids-only with complete:false and a re-run note, never a silent partial', t => {
  const full = payload(1, 0)
  full.directlyTargeted[0].offers.freeRadicalAdIds = Array.from({ length: 5000 }, (_, i) => `ad${i}`)
  const { json } = parse(fitEligibility(full, 'all', 0, LIMIT))
  t.is(json.complete, false)
  t.deepEqual(json.ids, ['d0'])
  t.true(json.note.includes('bucket'))
  t.is(json.summary.directlyTargeted, 1)
})
