/* eslint-disable camelcase -- Tool input / output fields and OAuth params are snake_case on the wire: protocol, not style. */
/**
 * tools/zoneEligibilityTools.js
 *
 * Three thin reads over the pure `eligibility` join (tools/eligibility.js):
 *   - get_zone_eligible_ad_groups(zoneId)        zone  → eligible groups (split)
 *   - get_ad_group_zone_reach(adGroupId)         group → zones it leaks into
 *   - explain_serve(zoneId, adGroupId | adId)    pair  → eligible? by what path? why not?
 *
 * Each fetches the same whole-network list sets get_zone_targeting_inventory
 * already fetches (every Work API list endpoint returns the full set in one GET),
 * runs the pure join in memory, and returns only the compact result in the
 * model-visible content TEXT (a header line + compact JSON), same channel and
 * size discipline as the inventory tool.
 */

import { z } from 'zod'
import { requiredNetworkIdShape } from './_shared.js'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { RESPONSE_SIZE_LIMIT } from '../constants.js'
import {
  asRows, asEntity, rollupZoneTargeting, adLiveViable, archivedZoneText, refusedZoneText, missingChannelText, fetchChannel,
  segmentPickNote

} from './zoneInventoryTools.js'
import {
  eligibility, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  zoneRequest, adVerdict, refusesEveryVisit, segmentPickFlags, contradiction, VALUES_CAP

} from './eligibility.js'

const err = (text) => ({ content: [{ type: 'text', text }] })

/** Resolve + validate the session; returns the session or a ready-to-return error. */
async function guard (extra, networkId) {
  const auth = await resolveLincxSession(extra)
  if (!auth) return { ok: false, result: err("Error: Not authenticated. Use 'auth_login' first.") }
  const v = await validateSession(auth)
  if (!v.valid || !v.session) return { ok: false, result: err(`Error: ${v.error}`) }
  return { ok: true, session: v.session }
}

;

/** One GET per entity — each returns the whole network set (documented in workApi). */
async function fetchIndex (session, network_id) {
  const [zonesRaw, adGroupsRaw, campaignsRaw, adsRaw, creativesRaw] = await Promise.all([
    workApiRequest(session, 'GET', '/api/zones', { networkId: network_id }),
    workApiRequest(session, 'GET', '/api/ad-groups', { networkId: network_id }),
    workApiRequest(session, 'GET', '/api/campaigns', { networkId: network_id }),
    workApiRequest(session, 'GET', '/api/ads', { networkId: network_id }),
    workApiRequest(session, 'GET', '/api/creatives', { networkId: network_id })
  ])
  const zones = asRows(zonesRaw)
  const adGroups = asRows(adGroupsRaw)
  const campaignRows = asRows(campaignsRaw)
  const adRows = asRows(adsRaw)
  const creativeRows = asRows(creativesRaw)

  const campaigns = {}
  for (const c of campaignRows) if (c.id) campaigns[c.id] = { enabled: c.enabled, archived: c.archived, dateStart: c.dateStart, dateEnd: c.dateEnd }
  const creatives = {}
  for (const c of creativeRows) if (c.id) creatives[c.id] = { archived: c.archived }
  const adsByGroup = {}
  for (const a of adRows) {
    if (!a.adGroupId) continue;
    (adsByGroup[a.adGroupId] ??= []).push({ id: a.id, enabled: a.enabled, archived: a.archived, creativeId: a.creativeId, params: a.params, exceptParams: a.exceptParams })
  }
  return {
    zones,
    adGroups,
    campaigns,
    creatives,
    adsByGroup,
    scan: {
      zonesScanned: zones.length,
      adGroupsScanned: adGroups.length,
      campaignsScanned: campaignRows.length,
      adsScanned: adRows.length,
      creativesScanned: creativeRows.length
    }
  }
}

/** header + compact JSON in the content text; degrade only by shedding row bodies
 * (never the exact summary counts) if a pathological set overflows the guard.
 * `rowKeys` maps each row-array key to the field to keep as its id when shedding.
 * Used by the two small tools (reach / explain_serve); the eligibility rollup
 * pages instead — see fitEligibility. `complete:false` is the shared "this is
 * not the whole answer" flag across the whole family (was `truncated`). */
function pack (header, payload, rowKeys) {
  const render = (p) => ({ content: [{ type: 'text', text: `${header}\n\n${JSON.stringify(p)}` }] })
  const full = render({ ...payload, complete: true })
  if (JSON.stringify(full).length <= RESPONSE_SIZE_LIMIT) return full
  // Overflow: replace each row array with just its ids + complete:false. Summary stays exact.
  const shed = { ...payload, complete: false }
  for (const [k, idKey] of Object.entries(rowKeys)) {
    const rows = payload[k]
    if (Array.isArray(rows)) shed[k] = rows.map((r) => (r)[idKey])
  }
  return render(shed)
}

;

/** Merge each group's live rollup row with its join verdict (eligible/verdict/via/
 * reasons/conflicts/conditions/paramBlocks/matchedKeys) and its offer-grain
 * (ad group × ad) counts. Exported for tests. */
export function enrich (elig, idx, zone, request, now) {
  const byId = new Map(elig.map((e) => [e.adGroupId, e]))
  const groups = idx.adGroups.filter((g) => byId.has(g.id))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const { groups: rows } = rollupZoneTargeting({
    zoneId: zone.id,
    zoneCag: zone.creativeAssetGroupId,
    targeted: groups,
    conflicting: [],
    campaigns: idx.campaigns,
    adsByGroup: idx.adsByGroup,
    creatives: idx.creatives,
    mode: 'all',
    now,
    request
  })
  return rows.map((r) => {
    const e = byId.get(r.id)
    // Offer-grain liveness = the group's own chain (campaign + ad group) AND this ad.
    // Same predicate the inventory rollup uses for has_live_viable_ad, per ad instead
    // of "some ad", so a dormant free-radical host reports freeRadicalLive: 0.
    const isLive = (ad) => r.campaign_on && r.adgroup_on && adLiveViable(ad, idx.creatives)
    const offers = offerRollup({ group: e, adGroup: groupById.get(r.id), ads: idx.adsByGroup[r.id] ?? [], zone, isLive, request })
    return {
      ...r,
      eligible: e.eligible,
      verdict: e.verdict,
      conditional: e.conditional,
      via: e.via,
      reasons: e.reasons,
      conflicts: e.conflicts,
      conditions: e.conditions,
      paramBlocks: e.paramBlocks,
      matchedKeys: e.matchedKeys,
      ...(e.contradiction ? { contradiction: e.contradiction } : {}),
      ...(e.contradictionOverridable ? { contradictionOverridable: true } : {}),
      offers
    }
  })
}

/**
 * What the conditional answers depend on, aggregated over the zone: every visit key
 * named by a conditional group, or by a conditional ad inside a group that is not
 * excluded. Whitelist and blacklist values stay apart (`requires` / `excludes`) —
 * merged, a mobile-only group and a never-mobile group read the same. A key the
 * segment pick decides (templateId on a segments zone) is marked `segment: true`:
 * it is not a value a visit carries. Exported for tests.
 */
export function conditionKeysOf (rows, adsByGroup, zoneId, request) {
  const acc = new Map()
  const add = (c, groupId) => {
    if (!acc.has(c.key)) acc.set(c.key, { requires: new Set(), excludes: new Set(), groups: new Set(), segment: false })
    const a = acc.get(c.key)
    for (const v of c.values) a[c.op === 'requires' ? 'requires' : 'excludes'].add(v)
    a.groups.add(groupId)
    if (c.source === 'segment') a.segment = true
  }
  for (const r of rows) {
    if (r.verdict === 'excluded') continue
    for (const c of r.conditions) add(c, r.id)
    for (const ad of adsByGroup[r.id] ?? []) {
      const av = adVerdict(ad, zoneId, request)
      // An ad whose rules contradict its group's never serves, so its keys are not
      // something the zone's answers depend on.
      if (av.verdict === 'conditional' && !contradiction([...r.conditions, ...av.conditions], request)) {
        for (const c of av.conditions) add(c, r.id)
      }
    }
  }
  const list = (set) => {
    const values = [...set]
    return values.length > VALUES_CAP ? { values: values.slice(0, VALUES_CAP), valuesTotal: values.length } : { values }
  }
  const out = {}
  for (const [key, a] of [...acc].sort(([x], [y]) => x.localeCompare(y))) {
    out[key] = {
      ...(a.requires.size ? { requires: list(a.requires) } : {}),
      ...(a.excludes.size ? { excludes: list(a.excludes) } : {}),
      groups: a.groups.size,
      ...(a.segment ? { segment: true } : {})
    }
  }
  return out
}

/** The zone as the eligibility answers describe it, incl. the keys its rules read. */
const zoneView = (zone, channel, request) => ({
  id: String(zone.id),
  name: String(zone.name ?? zone.id),
  creativeAssetGroupId: zone.creativeAssetGroupId,
  templateId: zone.templateId,
  type: zone.type,
  channelType: channel?.type,
  ...segmentPickFlags(request)
})

/**
 * Counts for get_zone_eligible_ad_groups, exported for tests. Grain matters:
 * `freeRadical*` is summed over the free-radical bucket ONLY — a directly-targeted
 * group's offers always carry `ad-group-whitelist`, and a conflicting group is never
 * eligible, so neither can hold a free-radical offer. The ad-level totals cover both
 * SERVING buckets (direct + radicals); `conflicting` is excluded because nothing in it
 * serves. `directlyTargeted + conflicting` still reconciles to get_zone_targeting_inventory.
 */
export function summarizeEligibility (
  direct, radicals, conflict, inert = [], { excludedByDefault = [], conditionKeys = {} } = {}
) {
  const sum = (rows, k) => rows.reduce((n, r) => n + (r.offers[k] ?? 0), 0)
  const is = (v) => (r) => r.verdict === v
  const directEligible = direct.filter(is('eligible'))
  const directCond = direct.filter(is('conditional'))
  const radicalsEligible = radicals.filter(is('eligible'))
  const radicalsCond = radicals.filter(is('conditional'))
  // Live is read at the offer grain, not from fully_live: fully_live counts any
  // live ad that is not excluded on its own, so a group whose live ads are all
  // geo-only read as serving every visit (#91). Its ads are alternatives — any
  // one serving is enough — which the group's AND-ed conditions[] cannot carry,
  // so the verdict stays and the group gets its own count instead.
  const liveEveryVisit = (r) => r.offers.live > 0
  const liveOnConditionalAds = (r) => r.offers.live === 0 && r.offers.conditionalLive > 0
  const liveConditional = (r) => r.offers.conditionalLive > 0
  return {
    directlyTargeted: direct.length,
    directlyTargetedLive: directEligible.filter(liveEveryVisit).length,
    directlyTargetedLiveOnConditionalAds: directEligible.filter(liveOnConditionalAds).length,
    directlyTargetedIneligible: direct.filter(is('excluded')).length,
    // Rex's rule: a conditional group serves only on some traffic, so it sits in
    // neither the eligible nor the excluded counts, with its own live axis.
    directlyTargetedConditional: directCond.length,
    directlyTargetedConditionalLive: directCond.filter(liveConditional).length,
    // HOST grain: the free radical is the OFFER; the group only hosts it. A host
    // with 0 free-radical offers is not itself a leak.
    freeRadicalHosts: radicalsEligible.length,
    freeRadicalHostsLive: radicalsEligible.filter(liveEveryVisit).length,
    freeRadicalHostsLiveOnConditionalAds: radicalsEligible.filter(liveOnConditionalAds).length,
    freeRadicalHostsConditional: radicalsCond.length,
    freeRadicalHostsConditionalLive: radicalsCond.filter(liveConditional).length,
    // Offer grain (ad group × ad) — the true CAG-leak count. A free-radical HOST
    // whose only ad is zone-whitelisted contributes 0 free-radical offers.
    freeRadicalOffers: sum(radicals, 'freeRadical'),
    // …of those, the ones live right now. freeRadicalOffers sums across dormant
    // hosts too, so on its own it reads as live exposure and isn't. The gap between
    // the two IS the standing-trap volume — offers a single toggle (most often the
    // campaign) away from landing in the zone.
    freeRadicalOffersLive: sum(radicals, 'freeRadicalLive'),
    freeRadicalOffersConditional: sum(radicals, 'freeRadicalConditional'),
    freeRadicalOffersConditionalLive: sum(radicals, 'freeRadicalConditionalLive'),
    adLevelTargetedOffers: sum(direct, 'adLevelTargeted') + sum(radicals, 'adLevelTargeted'),
    adLevelBlacklistedOffers: sum(direct, 'adLevelBlacklisted') + sum(radicals, 'adLevelBlacklisted'),
    conflicting: conflict.length,
    // Config defects, not serving: an ad whitelists this zone under a group that
    // cannot reach it, so the whitelist never fires. Counted at both grains — the
    // groups hosting dead config, and the dead ads themselves.
    inertWhitelistGroups: inert.length,
    inertWhitelistOffers: sum(inert, 'inertWhitelisted'),
    excludedByDefault: excludedByDefault.length,
    conditionKeys
  }
}

;
const BUCKETS = ['directlyTargeted', 'freeRadicals', 'conflicting', 'inertWhitelists', 'excludedByDefault']

/** One-line human header: exact counts always, plus the page state when paged. */
export function eligibilityHeader (zone, s, page) {
  const inert = s.inertWhitelistOffers > 0
    ? ` · ${s.inertWhitelistOffers} INERT ad-level whitelists across ${s.inertWhitelistGroups} out-of-scope groups (dead config: the ad names this zone, its group cannot reach it)`
    : ''
  const cond = (n, live) => n > 0 ? ` · ${n} conditional (${live} live)` : ''
  const onCondAds = (n) => n > 0 ? `, ${n} live only on conditional ads` : ''
  const directCond = s.directlyTargetedConditional > 0 ? `, ${s.directlyTargetedConditional} conditional (${s.directlyTargetedConditionalLive} live)` : ''
  const byDefault = s.excludedByDefault > 0 ? ` · ${s.excludedByDefault} excluded by a zone default (a visit overriding it would change this)` : ''
  const keys = Object.keys(s.conditionKeys ?? {})
  const depends = keys.length > 0 ? ` · conditional on: ${keys.join(', ')}` : ''
  const counts = `${s.directlyTargeted} targeted (${s.directlyTargetedLive} live${onCondAds(s.directlyTargetedLiveOnConditionalAds)}${directCond}, ${s.directlyTargetedIneligible} config-ineligible) · ${s.freeRadicalHosts} free-radical hosts (${s.freeRadicalHostsLive} live${onCondAds(s.freeRadicalHostsLiveOnConditionalAds)})${cond(s.freeRadicalHostsConditional, s.freeRadicalHostsConditionalLive)} / ${s.freeRadicalOffers} free-radical offers (${s.freeRadicalOffersLive} live)${cond(s.freeRadicalOffersConditional, s.freeRadicalOffersConditionalLive)} · ${s.conflicting} conflicting${inert}${byDefault}${depends}`
  // Two paged states, both spelled out. The TAIL page is the one that reads like a
  // bug: it carries complete:false (correct — this response does NOT hold the whole
  // slice, it starts at a non-zero offset) with no next_offset. Two reviewers have
  // now filed that as "complete is broken", so the header says it outright rather
  // than leaving the flag to be inferred.
  const rows = page ? `rows ${page.offset}–${page.offset + page.returned - 1} of ${page.total} for bucket '${page.bucket}'` : ''
  const paged = page === undefined
    ? ''
    : page.next_offset !== undefined
      ? ` — PARTIAL PAGE: ${rows}; re-run with offset:${page.next_offset} (same bucket) for the rest. Summary counts above are exact for the WHOLE set.`
      : page.offset > 0
        ? ` — FINAL PAGE: ${rows}; no next_offset, so paging is done. complete is false BY DESIGN here — it means "this one response is not the whole slice", not "more pages remain". Page on the absence of next_offset, never on complete. Summary counts above are exact for the WHOLE set.`
        : ''
  return `Zone ${zone.name} (${zone.id}) — ${counts}${segmentPickNote(zone)}${paged}`
}

/**
 * Pack the eligibility rollup into a result that fits `limit`, WITHOUT ever
 * degrading a returned row's field set — the offer-grain payload (`offers`,
 * `scoped_via`, `via`, `reasons`, `conflicts`) is the reason to call this tool, so
 * shedding it is worse than returning fewer rows. Every returned row is complete;
 * rows that don't fit are reachable via `offset` (the list-tool `next_offset`
 * idiom), and `summary` is always exact over the FULL set regardless of paging.
 *
 * Paging runs over ONE flat list — the selected buckets concatenated in fixed
 * order — so `offset`/`next_offset` is a single unambiguous index even for
 * bucket:'all'. Rows are re-split into their named arrays for the response.
 *
 * Last resort only (a single row larger than the whole budget): ids-only with
 * complete:false. Never a silent partial: `complete` and `page.next_offset` say so.
 */
export function fitEligibility (full, bucket, offset, limit) {
  const flat = []
  for (const b of BUCKETS) {
    if (bucket !== 'all' && bucket !== b) continue
    for (const row of full[b] ?? []) flat.push({ bucket: b, row })
  }
  const window = flat.slice(Math.max(0, offset))

  const render = (body, page) => ({
    content: [{ type: 'text', text: `${eligibilityHeader(full.zone, full.summary, page)}\n\n${JSON.stringify(body)}` }]
  })

  const build = (n) => {
    const slice = window.slice(0, n)
    const page = {
      bucket,
      offset,
      returned: slice.length,
      total: flat.length,
      ...(offset + slice.length < flat.length ? { next_offset: offset + slice.length } : {})
    }
    // complete = this response holds the ENTIRE selected slice — nothing before it
    // (offset 0) and nothing after it (no next_offset). Offset-relative "nothing
    // left" would report complete:true on a tail page holding 37 of 207 rows, and a
    // reconciliation check against `summary` would then read as a regression.
    const complete = offset === 0 && page.next_offset === undefined
    const body = { zone: full.zone, summary: full.summary, page, complete }
    for (const b of BUCKETS) {
      if (bucket !== 'all' && bucket !== b) continue
      body[b] = slice.filter((s) => s.bucket === b).map((s) => s.row)
    }
    body.scan = full.scan
    const result = render(body, page)
    return { result, size: JSON.stringify(result).length }
  }

  const whole = build(window.length)
  if (whole.size <= limit) return whole.result

  // Largest prefix that fits. Rows vary in size, so binary-search rather than assume.
  let lo = 0; let hi = window.length; let best = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (mid === 0) { lo = 1; continue }
    const attempt = build(mid)
    if (attempt.size <= limit) { best = attempt.result; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (best) return best

  // Pathological: even one full row overflows the budget. Ids only, flagged.
  return render({
    zone: full.zone,
    summary: full.summary,
    bucket,
    complete: false,
    note: "A single ad-group row exceeds the response budget, so only ids are returned. Re-run with bucket:'freeRadicals' | 'directlyTargeted' | 'conflicting' to narrow, or use explain_serve for one (zone, ad group) pair. Summary counts are exact.",
    ids: window.map((s) => s.row.id),
    scan: full.scan
  })
}

/**
 * How every eligibility tool describes the verdict. One text, so the three tools
 * cannot drift apart on the semantics.
 */
const VERDICT_DOC = `TARGETING RULES BEYOND zoneId. The ad server checks every params / exceptParams key (and an ad group's legacy geo / devices fields), not just zoneId, against the request it builds for each visit. Every row (and explain_serve) carries verdict: 'eligible' | 'conditional' | 'excluded', with conditional (bool), conditions[], paramBlocks[] and matchedKeys[]; eligible stays a boolean and is true only for verdict 'eligible'.
- ELIGIBLE: serves on every visit that does not override a zone default, as far as the GROUP's own targeting goes — whether one of its ads serves every visit is a separate question: the ad server judges each ad on its own, so a group whose ads are all geo-only stays eligible, and offers.live (an ad serving every visit) vs offers.conditionalLive with offers.conditionalAds tells them apart. When matchedKeys[] holds an entry with source 'zone-default' or 'segment', the row is eligible BECAUSE of that default: a visit overriding that key with another value drops it (e.g. a group requiring s1=abc on a zone defaulting s1 to abc does not serve an s1=xyz visit). EXCLUDED: serves on no visit that leaves the zone's defaults alone; paramBlocks[] names each blocking rule { path, key, op, values, source: 'zone' | 'zone-default' | 'segment' | 'always', actual, overridable } — overridable:true means a visit overriding that key could let it through. CONDITIONAL: serves on some visits only, and conditions[] says which. A block wins over a condition, and conditions that can never all hold on one visit (a group that requires device mobile with an ad that excludes it) are excluded with reason 'conditions-contradict' and contradiction naming the key; contradictionOverridable:true marks one only the segment pick causes (no segment's template meets every rule, but a template a visit could name would), which lands in excludedByDefault like any overridable block. The tools never assume a visit: they report what config decides and leave the rest as conditions for you to read.
- Keys the ZONE sets: zoneId, networkId, creativeAssetGroupId, publisherId, zoneType (zone.type), channelType (the type of the zone's channel). The tools treat these as fixed (source 'zone', overridable:false): a real ad tag does not send them. Strictly, a tag that did — as a data-* attribute or prefixed page param — would override them too, since the ad server applies the visit's values last. ZONE DEFAULTS: templateId and every zone.dataAttributesDefault key. A visit overrides a default with a data-* attribute on the ad tag, a page query param prefixed lincx- / adverse- / tgt- (e.g. ?lincx-templateId=…), or — for keys the network maps from the page URL (its pageUrlKeys, e.g. ?sub=… → article) — the page URL itself. So a block on a default is overridable:true, an untargeted group it blocks is listed in excludedByDefault instead of dropped, and an eligible row that matched a default (matchedKeys source 'zone-default') holds only while visits leave that key alone.
- TEMPLATE ON A SEGMENTS ZONE: per visit the ad server picks one candidate — a segment that passes its own allow/block lists and has allocation, or the zone itself, which competes only when it passes its own lists and those segments leave allocation under 100 — unless the visit names a templateId (it wins) or a segmentId (it pins that segment). The draw is over 100 and walks the segments in order, so a segment starting past a cumulative 100% is never a candidate. If the zone itself fails its lists while the segments that pass total under 100%, the remaining share of unpinned visits gets no ad at all: zone.unservedShare gives it in percent as bounds { min, max, atDefaults? }: no unpinned visit gets less than min or more than max (zone-set keys taken as fixed, as everywhere in these tools), atDefaults is the exact share for visits keeping the zone's defaults (set when no list there reads a visit key), and zoneRules[] { path, key, op: 'requires' | 'excludes', values, valuesTotal, source: 'request' | 'zone-default' | 'zone', actual? } names the rules in the zone's own lists that some visit fails — an unserved visit fails at least one of them, and a visit passing all of them is served (source 'zone': a value the zone sets, failing every visit) — and the header NOTE words each as the condition those visits meet; min === max means every unpinned visit gets that share. Lists reading a visit key or a zone default make the share depend on the visit. Segments whose lists exclude each other (one mobile-only, one desktop-only, as persona splits usually are) never pass together, so the real share can sit well inside the bounds. The header says so. When the candidates disagree on a templateId rule, the row is conditional with source 'segment' and the condition lists candidates[] { segmentId (null = the zone itself), templateId, passes }: the row serves on visits that land on a candidate with passes:true.
- VISIT keys — device, deviceOs, geoState, geoRegion, geoPostal, geoCity, geoCountry, geoCountryName, geoIP, the dateTime* keys, page-URL keys, custom keys — only the visit decides. A params (whitelist) rule on one is a condition with op 'requires': the row serves only on visits whose key holds one of values[]. An exceptParams (blacklist) rule is a condition with op 'excludes': it serves on every visit EXCEPT those whose key holds one of values[]. A row with several conditions needs all of them to hold, and an offer needs its group's and its ad's. What a visit carries: device (desktop | mobile | tablet | smarttv | console | wearable | embedded) and deviceOs (ios | android | other), both from the user agent — desktop / other when it says nothing — and never settable by a query param; geoState — the tag's data-geo-state when set, else the visitor's geo-lookup region code (uppercase, e.g. TX); a visitor whose geo lookup returns no region is sent with an empty geoState (as is a direct API call that sends none), and an empty geoState fails every geoState / geo whitelist; and every dateTime* key as a lowercase weekday plus unpadded hour (dateTimeUTC: 'mon13'), taken from the visit's timestamp — the tag sends the browser's local time, so dateTimeVisitor is the visitor's own clock (its UTC offset, not its geo), and a visit with no timestamp gets the server's UTC time, making dateTimeVisitor equal dateTimeUTC. A visit's own parameters can set geoState and the dateTime* keys directly. A key a visit does not carry fails every whitelist on it and fires no blacklist. Values compare as exact strings: params.geoState is CASE-SENSITIVE — a lowercase rule like 'tx' never matches a lookup-derived TX — while the legacy geo field is matched uppercased.
- Conditional rows are counted on their own (…Conditional / …ConditionalLive), in neither the eligible nor the excluded counts. summary.conditionKeys names every visit key the zone's conditional rows depend on — { requires: { values }, excludes: { values }, groups, segment? }: requires lists the values whitelists need, excludes the values blacklists refuse, and segment:true marks a key the segment pick decides rather than a value the visit carries; offers.conditionalAds lists (up to 10) ads whose OWN rules depend on the visit. get_event_stats_keys shows real values for custom keys.
- matchedKeys[] lists the keys a whitelist matched (e.g. a free radical whose params.templateId names the zone's template) — it stays a free radical: free radical means no params.zoneId, open within the CAG.
- exceptParams.position / zoneId-position / templateId-position are slot rules the ad server applies AFTER selecting an ad (where it may be placed), so they say nothing about whether a group serves and are not reported. segmentId, on a segments zone, is set by the segment pick like templateId and read per candidate; elsewhere it is a visit key.
- A list naming every value a key can take — all 168 dateTime* day-hours, all seven devices, all three deviceOs values — matches every visit: as a whitelist it counts as no rule, as a blacklist it excludes the row on every visit (source 'always'). Empty lists are no rule.
- A zone whose channel does not exist (or that has none) is refused on every visit — the ad server looks the channel up on each one — and the tools answer that alone, as for an archived zone (reach skips such zones and names them in scan.missingChannelZonesSkipped; a channel it cannot read — e.g. hidden from your permissions — lands in scan.unreadableChannelZonesSkipped instead, never as "does not exist").
- WHEN A SEGMENTS ZONE SERVES ONLY SOME VISITS. If the visits that keep the zone's defaults get no candidate (the lists fail only on a default), the rows are still returned, zone.refusesDefaultVisits is true, zone.overriddenOnServedVisits names the defaults every served visit overrides, and those keys are judged as visit keys in the rows (a group matching the rejected default reads conditional, not eligible). If no visit gets a candidate without naming a segmentId, the rows are returned against every segment, zone.servesOnlyPinnedVisits is true, and they describe only that rare pinned traffic (a pinned segment skips its lists and allocation). If instead some unpinned visits get no candidate at all (the zone fails its own lists while the segments that pass cover less than 100%), the rows are returned for the served visits and zone.unservedShare gives that share (see TEMPLATE ON A SEGMENTS ZONE). The header says each case, and reach rows carry the same flags. Only a segments zone with no segments at all whose own lists fail on every visit is refused outright; the tools then answer that alone, as for an archived zone (reach skips it and names it in scan.refusedZonesSkipped).`

const listOf = (c) => {
  const list = `${c.key} ∈ [${c.values.join(', ')}${c.valuesTotal > c.values.length ? ', …' : ''}]`
  if (c.source !== 'segment') return list
  const via = c.candidates.filter((x) => x.passes).map((x) => x.segmentId ?? 'the zone itself')
  return `${list} (decided by the segment picked: passes on ${via.join(', ')})`
}

const sourceLabel = { zone: 'zone', 'zone-default': 'zone default', segment: 'segment templates' }

/** One block, human-readable: which rule, against what value, and whether a visit could change it. */
function describeBlock (b) {
  const reason = b.op === 'requires' ? 'param-mismatch' : 'param-blacklisted'
  const actual = b.source === 'always'
    ? 'the list names every value, so it matches every visit'
    : b.actual === null || b.actual === undefined || b.actual === ''
      ? `${sourceLabel[b.source]} has none`
      : `${sourceLabel[b.source]} ${[].concat(b.actual).join(' / ')}`
  const hint = b.overridable ? `; a visit overriding ${b.key} would change this` : ''
  return `${reason}: ${b.key} (${actual}${hint})`
}

/**
 * The pair's contradiction for explain_serve's top level: the offer's, which judges
 * the group's and the ad's rules together, else the group's own (an excluded group
 * leaves the offer nothing to judge). Spread over the group's fields, so both keys
 * are always written — undefined drops out of the JSON.
 */
function pairClash (group, offer) {
  const from = offer.contradiction ? offer : group
  return { contradiction: from.contradiction, contradictionOverridable: from.contradictionOverridable }
}

/**
 * Is the PAIR excluded only by what a visit could override? Judged from the group's
 * verdict and the ad's OWN verdict (adVerdict), not from the offer: when the group
 * is excluded the offer never looks at the ad, so an ad that can never serve here
 * would otherwise go unseen. The group must be in scope or excluded only by default;
 * the ad must not be zone-blacklisted or confined elsewhere; every block and clash —
 * the ad's, and the group's and the ad's rules taken together — must be overridable;
 * and something must actually exclude the pair. Exported for tests.
 */
export function pairExcludedByDefault ({ group, ad, request }) {
  if (group.verdict === 'excluded' && !group.excludedByDefault) return false
  if (ad.reasons.some((r) => r === 'ad-blacklisted' || r === 'ad-targets-other-zones')) return false
  if (!ad.paramBlocks.every((b) => b.overridable)) return false
  if (ad.clash && !ad.clash.overridable) return false
  const together = contradiction([...(group.conditions ?? []), ...ad.conditions], request)
  if (together && !together.overridable) return false
  return group.excludedByDefault === true || ad.paramBlocks.length > 0 ||
    ad.clash?.overridable === true || together?.overridable === true
}

/** The explain_serve header, one of: IS eligible / CONDITIONAL / NOT eligible. Exported for tests. */
export function explainHeader (subject, zone, v) {
  const where = `zone ${zone.name} (${zone.id})`
  if (v.verdict === 'eligible') {
    const defaults = (v.matchedKeys ?? []).filter((m) => m.source === 'zone-default' || m.source === 'segment')
    const holds = defaults.length
      ? `; holds only while ${defaults.map((m) => m.source === 'segment'
        ? `the visit lands on a segment with template ${[].concat(m.value).join(' / ')} (a visit naming another templateId, or pinning a segmentId with another template, changes it)`
        : `the visit leaves ${m.key} at its zone default ${[].concat(m.value).join(' / ')}`).join(' and ')}`
      : ''
    return `${subject} IS eligible in ${where} — via ${v.path}${v.freeRadical ? ' (free radical: no direct targeting)' : ''}${holds}`
  }
  if (v.verdict === 'conditional') {
    const requires = v.conditions.filter((c) => c.op === 'requires').map(listOf)
    const excludes = v.conditions.filter((c) => c.op === 'excludes').map(listOf)
    const parts = []
    if (requires.length) parts.push(`only for visits where ${requires.join(' and ')}`)
    if (excludes.length) parts.push(`${requires.length ? 'and ' : ''}serves except for visits where ${excludes.join(' or ')}`)
    return `${subject} is CONDITIONAL in ${where} — ${parts.join(', ')}${v.freeRadical ? ' (free radical: no direct targeting)' : ''}`
  }
  const reason = (r) => !/conditions-contradict$/.test(r) || !v.contradiction
    ? r
    : v.contradictionOverridable
      ? `${r}: ${v.contradiction} (no segment's template meets every rule on it; a visit naming a templateId that does would change this)`
      : `${r}: ${v.contradiction} (no single visit meets every rule on it)`
  const detail = v.paramBlocks.length
    ? [...v.reasons.filter((r) => !/param-/.test(r)).map(reason), ...v.paramBlocks.map(describeBlock)].join(', ')
    : v.reasons.map(reason).join(', ')
  return `${subject} is NOT eligible in ${where} — ${detail}`
}

export function registerZoneEligibilityTools (server) {
  // 1) zone → eligible ad groups (directly targeted + free radicals)
  server.registerTool('get_zone_eligible_ad_groups', {
    title: 'Zone Eligible Ad Groups',
    description: `List every ad group ELIGIBLE to serve in a zone — not just the ones directly targeted. An ad group is in scope for a zone when it is NOT archived (archived = out of service), its creativeAssetGroupId matches the zone's — or the zone has NO creativeAssetGroupId, in which case that filter does not apply at all and every group passes it, exactly as the serving engine behaves — it is not blacklisted (zone in its exceptParams.zoneId), and the group's params.zoneId names the zone OR it targets ZERO zones (open within its CAG). It is then ELIGIBLE only if every other targeting rule passes too — see TARGETING RULES below. Ad-level params/exceptParams are a per-ad LAST check (filterAdgroups runs first, so an ad-level whitelist can never rescue an ineligible group) — they decide WHICH ads serve within an eligible group, feed has_live_viable_ad, and drive the offer-grain counts below. Results split by how a group is SCOPED to the zone (each row's verdict says whether it serves): 'directlyTargeted' (ad-group-whitelisted and not blacklisted — this reconciles to get_zone_targeting_inventory's targeted set; groups that are targeted but config-broken, e.g. CAG mismatch or a params block, are KEPT here with eligible:false and their reasons[]/conflicts[]/paramBlocks[], never silently dropped; a conditional one stays here too), 'freeRadicals' (eligible or conditional without direct targeting — via the shared CAG, or, when the zone has no CAG, because no CAG filter applies at all; either way they leak in), 'conflicting' (targets AND excepts the zone), 'inertWhitelists' (DEAD CONFIG: the group cannot reach this zone, yet one of its ads whitelists the zone via ad.params.zoneId — filterAdgroups runs first, so that whitelist never fires and the ad silently does not serve here, even though the config reads as if it is targeted), and 'excludedByDefault' (an untargeted group blocked ONLY by a zone default — templateId, a dataAttributesDefault key, a segment template — that a visit overriding the key would let through). directlyTargeted + conflicting reconciles to the inventory tool; inertWhitelists and excludedByDefault are disjoint from both and nothing in them serves. Untargeted groups blocked on a zone-fixed key, or on every visit, are dropped. If the zone is ARCHIVED, no buckets are returned at all: the ad server refuses an archived zone before any ad group is considered, so every row would be unreachable.

${VERDICT_DOC}

FREE RADICALS ARE REPORTED AT TWO GRAINS. The 'freeRadicals' row set is HOST grain (summary.freeRadicalHosts counts the eligible ones, summary.freeRadicalHostsConditional the conditional ones): ad groups in scope only via the shared CAG — the free radical is the OFFER, the group merely hosts it. The true leak count is OFFER grain — an (ad group × ad) pair that serves solely via the CAG, i.e. an untargeted ad (empty params.zoneId) under an untargeted group, net of blacklists at BOTH levels (summary.freeRadicalOffers, plus freeRadicalOffersConditional for pairs that depend on the visit). An untargeted group whose only ad is zone-whitelisted is 1 free-radical HOST but 0 free-radical OFFERS — that ad renders because it is ad-level-targeted, not via the CAG.

BOTH GRAINS HAVE A LIVE AXIS, AND ONLY THE LIVE ONE IS EXPOSURE. summary.freeRadicalOffers sums across dormant hosts (a host whose campaign is off still contributes offers), so on its own it reads as live leak and is not; summary.freeRadicalOffersLive counts only offers whose whole chain is on (campaign + ad group + ad + viable creative) — that is what is leaking into the zone right now. The gap between them is standing-trap volume: config that lands in the zone the moment one toggle flips, most often the campaign. Per row, offers.freeRadical > 0 with offers.freeRadicalLive === 0 identifies exactly those hosts.

Every row carries offers: { total, inScope, live, conditional, conditionalLive, freeRadical, freeRadicalLive, freeRadicalConditional, freeRadicalConditionalLive, adLevelTargeted, adLevelBlacklisted, confinedElsewhere, inertWhitelisted, freeRadicalAdIds[], inertWhitelistedAdIds[], conditionalAds[] } so a pure free-radical subset is derivable. offers.inScope is TARGETING ONLY — the group is eligible and this ad passes its own rules on every visit — and says nothing about on/off state; offers.live is the same set with the whole chain on; offers.conditional counts the pairs that depend on the visit, and offers.conditionalAds names (up to 10) ads whose own rules do. summary also totals adLevelTargetedOffers, adLevelBlacklistedOffers, inertWhitelistGroups, inertWhitelistOffers and excludedByDefault.

Each row also carries the same live rollup as get_zone_targeting_inventory (campaign_on — enabled, not archived AND inside the campaign's flight window; adgroup_on, has_live_viable_ad, fully_live, off_reason[] — 'campaign' vs 'campaign-window' tell a switched-off campaign from an expired one — scoped_via[]) plus eligible, verdict, conditional, via[], reasons[], conflicts[], conditions[], paramBlocks[], matchedKeys[]. scoped_via uses the SAME five-value enum as get_zone_targeting_inventory and explain_serve ('ad-group-whitelist' | 'ad-group-blacklist' | 'ad-level-whitelist' | 'ad-level-blacklist' | 'zone-selection').

LIVE GROUP COUNTS ARE READ FROM THE OFFERS, NOT FROM fully_live. A row's fully_live is the inventory tool's flag: it counts any live ad that is not excluded on its own, so a group whose only live ads are geo-only reads fully_live:true. The summary does not: directlyTargetedLive and freeRadicalHostsLive count an eligible group only when it has a live ad that serves every visit that keeps the zone's defaults (offers.live > 0 — the same caveat as 'eligible': an ad that matched only a zone default drops on a visit overriding it, and on a zone with refusesDefaultVisits, servesOnlyPinnedVisits or unservedShare 'every visit' means the visits that zone serves); an eligible group whose live ads ALL depend on the visit (offers.live === 0, offers.conditionalLive > 0) is counted in directlyTargetedLiveOnConditionalAds / freeRadicalHostsLiveOnConditionalAds instead, and its verdict stays 'eligible' — the group's own rules pass, and its ads are alternatives (the ad server judges each ad on its own, so any one serving is enough), which conditions[] (all must hold on one visit) cannot express; offers.conditionalAds lists those ads with their conditions. The …ConditionalLive counts likewise need offers.conditionalLive > 0. A group whose conditional ads together cover every visit (one ad mobile-only, another never-mobile) still lands in …LiveOnConditionalAds, so that count can include groups that in fact serve everyone. Counting rows with fully_live:true can therefore exceed these counts.

EVERY RETURNED ROW IS COMPLETE — the offer payload is never stripped to fit. A zone with too many groups for one response is PAGED, not degraded: use bucket to select one bucket (e.g. bucket:'freeRadicals' for a pure free-radical subset) and offset to walk the rest. The response carries page: { bucket, offset, returned, total, next_offset? } and complete (true only when this ONE response holds the entire selected slice — offset 0 and no next_offset). summary is ALWAYS exact over the full set, regardless of bucket/offset — so with bucket:'all' and complete:true the arrays match the summary counts one-for-one (freeRadicals = freeRadicalHosts + freeRadicalHostsConditional). The only case where a row body is not returned is pathological (a single ad group whose row alone exceeds the whole response budget): then ids are returned with complete:false and a note, never a silent partial. Whole-network scan server-side; compact result in the content text (header + compact JSON).`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      zoneId: z.string().describe('Zone ID to list eligible ad groups for'),
      bucket: z.enum(['all', 'directlyTargeted', 'freeRadicals', 'conflicting', 'inertWhitelists', 'excludedByDefault']).default('all')
        .describe("Which bucket(s) to return rows for. Summary counts always cover the full set; this only narrows the ROWS so a large zone fits in one response (e.g. 'freeRadicals' for a pure free-radical subset, 'inertWhitelists' for ads whose zone whitelist is dead because their group cannot reach the zone, or 'excludedByDefault' for groups only a zone default keeps out)."),
      offset: z.number().int().min(0).default(0)
        .describe('Row offset within the selected bucket(s) — pass the next_offset from a previous call to continue.')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ zoneId, bucket, offset, network_id }, extra) => {
    const g = await guard(extra, network_id)
    if (!g.ok) return g.result
    try {
      const zoneRaw = await workApiRequest(g.session, 'GET', `/api/zones/${zoneId}`)
      const zone = asEntity(zoneRaw)
      if (!zone.id) return err('Error: Resource not found. Double-check the zone ID.')
      if (zone.networkId && zone.networkId !== network_id) return err(`Error: Zone '${zoneId}' belongs to network '${zone.networkId}', not '${network_id}'.`)
      if (zone.archived === true) return err(archivedZoneText(zone))
      const [idx, channel] = await Promise.all([fetchIndex(g.session, network_id), fetchChannel(g.session, zone.channelId, workApiRequest)])
      if (!channel) return err(missingChannelText(zone))
      const req = zoneRequest(zone, channel)
      if (refusesEveryVisit(req)) return err(refusedZoneText(zone))
      const zoneLite = zoneView(zone, channel, req)

      const b = zoneEligibility(idx.adGroups, zone, idx.adsByGroup, req)
      // One clock for every bucket: two reads either side of a window boundary
      // would otherwise disagree inside a single response.
      const now = Date.now()
      const [direct, radicals, conflict, inert, byDefault] = [b.directlyTargeted, b.freeRadicals, b.conflicting, b.inertWhitelists, b.excludedByDefault]
        .map((rows) => enrich(rows, idx, zone, req, now))

      const summary = summarizeEligibility(direct, radicals, conflict, inert, {
        excludedByDefault: byDefault,
        conditionKeys: conditionKeysOf([...direct, ...radicals], idx.adsByGroup, zoneLite.id, req)
      })
      return fitEligibility(
        { zone: zoneLite, summary, directlyTargeted: direct, freeRadicals: radicals, conflicting: conflict, inertWhitelists: inert, excludedByDefault: byDefault, scan: idx.scan },
        bucket, offset, RESPONSE_SIZE_LIMIT
      )
    } catch (e) { return err(handleWorkApiError(e)) }
  })

  // 2) ad group → zones it can serve/leak into
  server.registerTool('get_ad_group_zone_reach', {
    title: 'Ad Group Zone Reach',
    description: `Show every zone an ad group can serve or LEAK into — the flip of get_zone_eligible_ad_groups. For the given ad group, evaluates the same eligibility join against all zones: it reaches a zone when the CAG matches (or the zone has no CAG, which applies no CAG filter at all), it is not blacklisted there, it is in scope (whitelists the zone or targets zero zones → free radical across every zone sharing its CAG), and its other targeting rules pass in that zone (a zone where they hold only for some visits is reported conditional). Returns each zone it can serve in with via[], verdict ('eligible' | 'conditional'), conditions[], matchedKeys[] and any conflicts[]; excludedByDefault[] lists the zones where only a zone default (templateId, a dataAttributesDefault key, a segment template) keeps it out. summary: { reaches, targeted, freeRadical } count ELIGIBLE zones only; conditional counts the zones it reaches only on some traffic; excludedByDefault counts the default-blocked ones. An archived zone is never reachable — the ad server refuses archived zones, so they are skipped and counted in scan.archivedZonesSkipped, and any this group still whitelists are named in scan.archivedTargeted (dead targeting: it reads as if the group serves there and it cannot). Whole-network scan server-side; compact result in the content text.

${VERDICT_DOC}`,
    inputSchema: z.object({ ...requiredNetworkIdShape, adGroupId: z.string().describe('Ad group ID to compute zone reach for') }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ adGroupId, network_id }, extra) => {
    const g = await guard(extra, network_id)
    if (!g.ok) return g.result
    try {
      const agRaw = await workApiRequest(g.session, 'GET', `/api/ad-groups/${adGroupId}`)
      const agE = asEntity(agRaw)
      if (!agE.id) return err('Error: Resource not found. Double-check the ad group ID.')
      if (agE.networkId && agE.networkId !== network_id) return err(`Error: Ad group '${adGroupId}' belongs to network '${agE.networkId}', not '${network_id}'.`)
      const adGroup = {
        id: String(agE.id),
        name: agE.name,
        archived: agE.archived,
        params: agE.params,
        exceptParams: agE.exceptParams,
        geo: agE.geo,
        devices: agE.devices,
        creativeAssetGroupId: agE.creativeAssetGroupId
      }
      const [idx, channelsRaw] = await Promise.all([
        fetchIndex(g.session, network_id),
        workApiRequest(g.session, 'GET', '/api/channels', { networkId: network_id })
      ])
      const channels = new Map(asRows(channelsRaw).filter((c) => c.id).map((c) => [c.id, c]))
      // Reach is "where can this group actually serve", so archived zones are not
      // reachable at any targeting — the serving engine refuses them outright.
      const liveZones = idx.zones.filter((z) => z.archived !== true)
      const archivedZones = idx.zones.length - liveZones.length
      // An archived zone this group still whitelists is dead config: it cannot serve
      // there, but the targeting reads as if it can. A bare count would hide WHICH
      // zone, so name them — same reason the inert-whitelist bucket exists.
      const whitelist = adGroup.params?.zoneId
      const archivedTargeted = idx.zones
        .filter((z) => z.archived === true && Array.isArray(whitelist) && whitelist.includes(z.id))
        .map((z) => z.id)
      // The channels list is filtered by the user's permissions, so a channel missing
      // from it may only be hidden: look each one up by id before calling it missing.
      // Missing (404, or no channelId) means the ad server fails every visit — skipped
      // like an archived zone. Unreadable (any other failure) means this answer cannot
      // say — skipped too, and named apart, never reported as "does not exist".
      const unreadable = new Set()
      const lookups = [...new Set(liveZones.map((z) => z.channelId).filter((id) => id && !channels.has(id)))]
      await Promise.all(lookups.map(async (id) => {
        try {
          const c = await fetchChannel(g.session, id, workApiRequest)
          if (c) channels.set(id, c)
        } catch {
          unreadable.add(id)
        }
      }))
      const unreadableChannel = liveZones.filter((z) => unreadable.has(z.channelId)).map((z) => z.id)
      const missingChannel = liveZones.filter((z) => !channels.has(z.channelId) && !unreadable.has(z.channelId)).map((z) => z.id)
      const withChannel = liveZones.filter((z) => channels.has(z.channelId))
      const requests = new Map(withChannel.map((z) => [z.id, zoneRequest(z, channels.get(z.channelId))]))
      const refusedZones = withChannel.filter((z) => refusesEveryVisit(requests.get(z.id))).map((z) => z.id)
      const servingZones = withChannel.filter((z) => !refusedZones.includes(z.id))
      const evaluated = adGroupReach(adGroup, servingZones, (z) => requests.get(z.id))
      // A zone that serves only some visits (default visits refused, or only pinned
      // ones served) says so on its row, as its own tools do in their header.
      const named = evaluated.map((x) => ({
        ...x,
        zoneName: servingZones.find((z) => z.id === x.zoneId)?.name ?? x.zoneId,
        ...segmentPickFlags(requests.get(x.zoneId))
      }))
      const reach = named.filter((x) => x.verdict !== 'excluded')
      const byDefault = named.filter((x) => x.verdict === 'excluded')
      const eligible = reach.filter((x) => x.verdict === 'eligible')
      const direct = eligible.filter((x) => x.via.includes('ad-group-whitelist')).length
      const conditional = reach.length - eligible.length
      const summary = { reaches: eligible.length, targeted: direct, freeRadical: eligible.length - direct, conditional, excludedByDefault: byDefault.length }
      const extras = [conditional ? `${conditional} conditional` : '', byDefault.length ? `${byDefault.length} excluded by a zone default` : ''].filter(Boolean)
      const header = `Ad group ${adGroup.name ?? adGroup.id} (${adGroup.id}) reaches ${eligible.length} zones — ${direct} targeted · ${eligible.length - direct} free radical (via shared CAG)${extras.length ? ` · ${extras.join(' · ')}` : ''}`
      return pack(header, { adGroup: { id: adGroup.id, name: adGroup.name, creativeAssetGroupId: adGroup.creativeAssetGroupId }, summary, zones: reach, excludedByDefault: byDefault, scan: { ...idx.scan, archivedZonesSkipped: archivedZones, archivedTargeted, refusedZonesSkipped: refusedZones, missingChannelZonesSkipped: missingChannel, unreadableChannelZonesSkipped: unreadableChannel } }, { zones: 'zoneId', excludedByDefault: 'zoneId' })
    } catch (e) { return err(handleWorkApiError(e)) }
  })

  // 3) (zone, adGroup|ad) pair → why did/didn't X serve here
  server.registerTool('explain_serve', {
    title: 'Explain Serve',
    description: `Explain, for a single (zone, ad group OR ad) pair, whether it is eligible to serve in the zone, by what path (via[]), and if not, why not (reasons[], paramBlocks[]) — the "why did X serve in this zone?" direction of the eligibility join. Pass exactly one of adGroupId or adId (an adId is resolved to its ad group; its own ad-level whitelist/blacklist for the zone and its other params keys are also reported). The header reads 'IS eligible' (adding '; holds only while the visit leaves <key> at its zone default <value>' when the verdict rests on a default), 'is CONDITIONAL … only for visits where <key> ∈ [values]' (or '… serves except for visits where …'), or 'is NOT eligible' naming each blocked rule and whether a visit overriding a zone default would change it. With an adId the answer is at the OFFER grain (ad group × ad): the top-level verdict, conditions[], paramBlocks[], matchedKeys[], contradiction and excludedByDefault are the PAIR's (the group's rules and the ad's together, as the header reads them), and it adds offer: { verdict, conditional, conditions[], paramBlocks[], matchedKeys[] (the ad's own rules alone), scoped_via[] — 'ad-group-whitelist' | 'ad-group-blacklist' | 'ad-level-whitelist' | 'ad-level-blacklist' | 'zone-selection' — freeRadical, true only when the pair reaches the zone without any direct targeting — via the shared CAG, or via no CAG filter at all on a zone with no CAG (untargeted group AND untargeted ad, net of blacklists at both levels), and conflicts[], which carries 'inert-ad-level-whitelist' when this ad whitelists the zone but its group cannot reach it, so the whitelist is dead config that never fires }; the top-level verdict is then the pair's. If the zone itself is archived the answer is that alone: the ad server refuses archived zones, so nothing serves there at any targeting. Whole-network scan server-side.

${VERDICT_DOC}`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      zoneId: z.string().describe('Zone ID to explain serving in'),
      adGroupId: z.string().optional().describe('Ad group ID to explain (omit if passing adId)'),
      adId: z.string().optional().describe('Ad ID to explain (resolved to its ad group; omit if passing adGroupId)')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ zoneId, adGroupId, adId, network_id }, extra) => {
    if ((adGroupId ? 1 : 0) + (adId ? 1 : 0) !== 1) return err('Error: pass exactly one of adGroupId or adId.')
    const g = await guard(extra, network_id)
    if (!g.ok) return g.result
    try {
      const zoneRaw = await workApiRequest(g.session, 'GET', `/api/zones/${zoneId}`)
      const zone = asEntity(zoneRaw)
      if (!zone.id) return err('Error: Resource not found. Double-check the zone ID.')
      if (zone.networkId && zone.networkId !== network_id) return err(`Error: Zone '${zoneId}' belongs to network '${zone.networkId}', not '${network_id}'.`)
      if (zone.archived === true) return err(archivedZoneText(zone))
      const channel = await fetchChannel(g.session, zone.channelId, workApiRequest)
      if (!channel) return err(missingChannelText(zone))
      const req = zoneRequest(zone, channel)
      if (refusesEveryVisit(req)) return err(refusedZoneText(zone))
      const zoneLite = zoneView(zone, channel, req)

      let ad
      let groupId = adGroupId
      if (adId) {
        const adRaw = await workApiRequest(g.session, 'GET', `/api/ads/${adId}`)
        const adE = asEntity(adRaw)
        if (!adE.id) return err('Error: Resource not found. Double-check the ad ID.')
        if (adE.networkId && adE.networkId !== network_id) return err(`Error: Ad '${adId}' belongs to network '${adE.networkId}', not '${network_id}'.`)
        ad = { id: String(adE.id), enabled: adE.enabled, archived: adE.archived, creativeId: adE.creativeId, params: adE.params, exceptParams: adE.exceptParams, adGroupId: adE.adGroupId }
        groupId = ad.adGroupId
        if (!groupId) return err('Error: that ad has no ad group.')
      }
      const agRaw = await workApiRequest(g.session, 'GET', `/api/ad-groups/${groupId}`)
      const agE = asEntity(agRaw)
      if (!agE.id) return err('Error: Resource not found. Double-check the ad group ID.')
      if (agE.networkId && agE.networkId !== network_id) return err(`Error: Ad group '${groupId}' belongs to network '${agE.networkId}', not '${network_id}'.`)
      const adGroup = { id: String(agE.id), name: agE.name, archived: agE.archived, params: agE.params, exceptParams: agE.exceptParams, geo: agE.geo, devices: agE.devices, creativeAssetGroupId: agE.creativeAssetGroupId }

      // Group-level verdict first; ad-level params only narrow WHICH ads serve within it.
      const verdict = eligibility({ adGroup, zone, request: req })
      // With an adId, evaluate the OFFER grain on top: scoped_via at both levels and
      // whether this pair is a free radical (reaches the zone with no direct targeting:
      // shared CAG, or no CAG filter at all when the zone has no CAG).
      const offer = ad ? offerEligibility({ group: verdict, adGroup, ad, zone, request: req }) : undefined
      const reasons = offer ? offer.reasons : verdict.reasons
      const effective = offer ? offer.verdict : verdict.verdict

      const subject = ad ? `ad ${ad.id}` : `ad group ${adGroup.name ?? adGroup.id} (${adGroup.id})`
      const header = explainHeader(subject, zoneLite, {
        verdict: effective,
        path: offer ? offer.scoped_via.join(', ') : verdict.via.join(', '),
        freeRadical: offer ? offer.freeRadical : false,
        reasons,
        contradiction: offer ? offer.contradiction : verdict.contradiction,
        contradictionOverridable: offer ? offer.contradictionOverridable : verdict.contradictionOverridable,
        matchedKeys: [...verdict.matchedKeys, ...(offer?.matchedKeys ?? [])],
        conditions: [...verdict.conditions, ...(offer?.conditions ?? [])],
        paramBlocks: [...verdict.paramBlocks, ...(offer?.paramBlocks ?? [])]
      })
      return pack(`${header}${segmentPickNote(zoneLite, 'this answer describes')}`, {
        zone: zoneLite,
        subject: ad ? { adId: ad.id, adGroupId: adGroup.id } : { adGroupId: adGroup.id },
        ...verdict,
        eligible: effective === 'eligible',
        verdict: effective,
        conditional: effective === 'conditional',
        reasons,
        // With an adId the top level describes the PAIR, so its rules are the group's
        // and the ad's together — the same set the header reads. `offer` keeps the
        // ad's own rules apart.
        ...(offer
          ? {
              conditions: [...verdict.conditions, ...offer.conditions],
              paramBlocks: [...verdict.paramBlocks, ...offer.paramBlocks],
              matchedKeys: [...verdict.matchedKeys, ...offer.matchedKeys],
              ...pairClash(verdict, offer),
              excludedByDefault: offer.verdict === 'excluded' && pairExcludedByDefault({ group: verdict, ad: adVerdict(ad, zone.id, req), request: req })
            }
          : {}),
        ...(offer
          ? {
              offer: {
                verdict: offer.verdict,
                conditional: offer.conditional,
                conditions: offer.conditions,
                paramBlocks: offer.paramBlocks,
                matchedKeys: offer.matchedKeys,
                ...(offer.contradiction ? { contradiction: offer.contradiction } : {}),
                ...(offer.contradictionOverridable ? { contradictionOverridable: true } : {}),
                scoped_via: offer.scoped_via,
                freeRadical: offer.freeRadical,
                conflicts: offer.conflicts
              }
            }
          : {})
      }, {})
    } catch (e) { return err(handleWorkApiError(e)) }
  })
}
