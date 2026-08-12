/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/zoneInventoryTools.js
 *
 * get_zone_targeting_inventory — composite: which ad groups are DIRECTLY targeted
 * to a zone, and is each fully live (campaign + ad group + a live ad with a viable
 * creative)? Second sanctioned server-side composite alongside report_query — it
 * fetches whole-network list sets internally and returns only the compact matched
 * rollup, so no ad-group rows are ever paged through the LLM.
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { RESPONSE_SIZE_LIMIT } from '../constants.js'
// Type-only (erased at compile) — keeps the one shared scoped_via enum without a
// runtime import cycle: eligibility.js imports the entity types from here.

// A level is "on" only if enabled and not archived. archived is omitted when
// false, so `!== true` treats a missing key as false.
const on = (x) =>
  !!x && x.enabled === true && x.archived !== true

const has = (arr, v) => Array.isArray(arr) && arr.includes(v)

/** Pull the row array out of an unknown list response (bare array, {data:[]}, {items:[]}). */
export function asRows (data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data
    for (const k of Object.keys(obj)) if (Array.isArray(obj[k])) return obj[k]
  }
  return []
}

/** Unwrap a single-entity response that may be `{ data: {...} }` or the bare object. */
export function asEntity (data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) return obj.data
    return obj
  }
  return {}
}

/** Is this ad itself live — enabled, not archived, and pointing at an existing,
 * non-archived creative? Zone-independent on purpose: the caller has already
 * decided the ad serves in the zone (adServesHere / adServesInZone). Shared with
 * the offer grain so "live" means the same thing in both tools. */
export function adLiveViable (ad, creatives) {
  if (!on(ad)) return false
  if (ad.creativeId === undefined) return false
  const c = creatives[ad.creativeId]
  return c !== undefined && c.archived !== true
}

/** Split ad groups into those directly targeting the zone and those that both
 * target and except it (conflicting). exceptParams-only groups are neither. */
export function selectTargeting (adGroups, zoneId) {
  const targeted = []
  const conflicting = []
  for (const ag of adGroups) {
    const inParams = has(ag.params?.zoneId, zoneId)
    const inExcept = has(ag.exceptParams?.zoneId, zoneId)
    if (inParams && inExcept) conflicting.push(ag)
    else if (inParams) targeted.push(ag)
  }
  return { targeted, conflicting }
}

/** Roll up enabled-state across campaign → ad group → ad → creative for each
 * targeted ad group. Filters rows by mode; summary is always over the full set. */
export function rollupZoneTargeting (args

) {
  const { zoneId, zoneCag, targeted, conflicting, campaigns, adsByGroup, creatives, mode } = args
  const creativeResolves = (creativeId) =>
    creativeId !== undefined && creatives[creativeId] !== undefined

  // Per-ad LAST targeting check: an ad is hidden in THIS zone if its own
  // exceptParams blacklists the zone, or its own non-empty params whitelist omits
  // it. One hidden ad doesn't sink the group — its siblings still serve.
  const adServesHere = (a) => {
    if (zoneId === undefined) return true
    if (has(a.exceptParams?.zoneId, zoneId)) return false
    const wl = a.params?.zoneId
    if (Array.isArray(wl) && wl.length > 0 && !wl.includes(zoneId)) return false
    return true
  }

  const all = targeted.map((ag) => {
    const campaign = ag.campaignId !== undefined ? campaigns[ag.campaignId] : undefined
    const ads = adsByGroup[ag.id] ?? []

    const campaign_on = on(campaign)
    const adgroup_on = on(ag)
    const has_enabled_ad = ads.some(on)
    const creative_resolves = ads.some((a) => creativeResolves(a.creativeId))
    // Live-viable is zone-specific: only ads that actually serve in this zone count.
    const has_live_viable_ad = ads.some((a) => adServesHere(a) && adLiveViable(a, creatives))
    const archived = ag.archived === true

    const off_reason = []
    if (!campaign_on) off_reason.push('campaign')
    if (!adgroup_on) off_reason.push(archived ? 'archived' : 'adgroup')
    if (!has_live_viable_ad) off_reason.push('no_live_viable_ad')

    const fully_live = campaign_on && adgroup_on && has_live_viable_ad

    // How this already-selected group is scoped to the zone (annotate-only).
    // Same SCOPED_VIA domain as the offer grain — one enum across both tools.
    const scoped_via = []
    if (zoneId !== undefined && has(ag.params?.zoneId, zoneId)) scoped_via.push('ad-group-whitelist')
    if (zoneId !== undefined && has(ag.exceptParams?.zoneId, zoneId)) scoped_via.push('ad-group-blacklist')
    if (zoneId !== undefined && ads.some((a) => has(a.params?.zoneId, zoneId))) scoped_via.push('ad-level-whitelist')
    if (zoneId !== undefined && ads.some((a) => has(a.exceptParams?.zoneId, zoneId))) scoped_via.push('ad-level-blacklist')
    if (zoneCag !== undefined && ag.creativeAssetGroupId === zoneCag) scoped_via.push('zone-selection')

    return {
      id: ag.id,
      name: ag.name ?? ag.id,
      archived,
      campaign_on,
      adgroup_on,
      has_enabled_ad,
      creative_resolves,
      has_live_viable_ad,
      fully_live,
      off_reason,
      scoped_via
    }
  })

  const summary = {
    targeted: all.length,
    live: all.filter((r) => r.fully_live).length,
    off: all.filter((r) => !r.fully_live).length,
    archived: all.filter((r) => r.archived).length,
    conflicting: conflicting.length
  }

  const groups = mode === 'live'
    ? all.filter((r) => r.fully_live)
    : mode === 'off'
      ? all.filter((r) => !r.fully_live)
      : all

  return { groups, summary }
}

;
;

/** One-line human header (counts + any degradation flag). */
export function inventoryHeader (s

) {
  const { summary: m } = s
  const flags = `${m.targeted} targeted · ${m.live} live · ${m.off} off · ${m.archived} archived · ${m.conflicting} conflicting`
  const degrade = s.complete === false
    ? " — INCOMPLETE: too many groups for one response, re-run with mode:'off'/'live' (ids returned, counts exact)"
    : s.namesOmitted
      ? " — names omitted to fit; every ad group's id + flags are present"
      : ''
  return `Zone ${s.zone.name} (${s.zone.id}) — ${flags}${degrade}`
}

/**
 * Pack the full inventory into a tool result guaranteed to fit `limit`, WITHOUT
 * ever dropping an ad group (the answer is exhaustive by contract). Degrades in
 * this order only: (1) full rows with names; (2) rows minus the `name` field
 * (ids + flags survive, `namesOmitted`); (3) — only for pathological thousands —
 * ids-only with `complete:false` and an explicit instruction to split by mode.
 *
 * The rollup is carried in the `content` TEXT (header line + compact JSON), NOT
 * in structuredContent: MCP hosts (claude.ai included) feed only `content` to the
 * model — `structuredContent` is delivered but not surfaced, so putting the rows
 * there alone made the model see only the header. Text is the reliable channel
 * (same as report_query). No structuredContent → the size guard counts the payload
 * once, not twice, which is also why more rows fit.
 */
export function fitZoneInventory (full, limit) {
  const wrap = (s) => ({
    content: [{ type: 'text', text: `${inventoryHeader(s)}\n\n${JSON.stringify(s)}` }]
  })
  const size = (r) => JSON.stringify(r).length

  const complete = { ...full, complete: true }
  const full_ = wrap(complete)
  if (size(full_) <= limit) return full_

  const stripped = {
    ...full,
    complete: true,
    namesOmitted: true,
    groups: full.groups.map(({ name, ...r }) => r),
    conflicting: full.conflicting.map(({ id }) => ({ id }))
  }
  const stripped_ = wrap(stripped)
  if (size(stripped_) <= limit) return stripped_

  return wrap({
    zone: full.zone,
    mode: full.mode,
    summary: full.summary,
    complete: false,
    note: "Too many targeted ad groups to return in one response. Re-run with mode:'off' or mode:'live' to split — the summary counts are exact. groupIds lists every targeted ad group id so nothing is hidden.",
    groupIds: full.groups.map((g) => g.id),
    conflicting: full.conflicting.map(({ id }) => ({ id })),
    scan: full.scan
  })
}

export function registerZoneInventoryTools (server) {
  server.registerTool('get_zone_targeting_inventory', {
    title: 'Zone Targeting Inventory',
    description: `Audit which ad groups are DIRECTLY targeted to a zone (via the ad group's params.zoneId) and, for each, whether it is FULLY LIVE — campaign, ad group, and at least one ad all enabled (and not archived) with a viable creative attached — or where it is off. Exhaustive and server-side: it scans the whole network's ad groups/campaigns/ads/creatives internally and returns only the compact matched rollup, so nothing is paged through the model. exceptParams.zoneId is treated as an exclusion (a group that both targets and excepts the zone is reported under 'conflicting', not 'targeted').

The result is the text content: a one-line header, then a blank line, then compact JSON { zone, mode, summary, groups[], conflicting[], scan }. Parse the JSON (everything after the first blank line) to render the table. Each groups[] row: { id, name, archived, campaign_on, adgroup_on, has_enabled_ad, creative_resolves, has_live_viable_ad, fully_live, off_reason[], scoped_via[] }. scoped_via lists HOW the group is scoped to the zone (annotate-only, the row set is unchanged). It uses ONE shared enum across every tool that emits the field — 'ad-group-whitelist' (the group's params.zoneId names the zone — always present on a targeted row), 'ad-group-blacklist' (the group's exceptParams.zoneId excludes the zone; such a group is reported under 'conflicting' here, so this value is rare on a targeted row and common on the eligibility tool's conflicting rows), 'ad-level-whitelist' (one of its ads also whitelists the zone), 'ad-level-blacklist' (one of its ads excludes the zone via ad.exceptParams.zoneId — that ad is hidden here, siblings still serve), 'zone-selection' (the group shares the zone's creativeAssetGroupId). Same five values, same meaning, in get_zone_eligible_ad_groups and explain_serve. For per-(ad group × ad) offer-grain scoping and free-radical counts, use get_zone_eligible_ad_groups. This tool NEVER drops ad groups: the row set is always complete. If a mega-zone would overflow the response, it first omits the optional 'name' field (sets namesOmitted:true; ids + flags remain), and only as a last resort for pathological sizes returns ids-only with complete:false plus an instruction to re-run with mode:'off'/'live' — it never silently returns a partial list.`,
    inputSchema: z.object({
      zoneId: z.string().describe('Zone ID to audit targeting for'),
      mode: z.enum(['all', 'live', 'off']).default('all').describe('Filter the returned groups: all (default), only fully-live, or only not-fully-live. Summary counts always cover the full targeted set.')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ zoneId, mode }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    const session = v.session

    try {
      // Every list endpoint returns the full network set in one call; fetch in parallel.
      const [zoneRaw, adGroupsRaw, campaignsRaw, adsRaw, creativesRaw] = await Promise.all([
        workApiRequest(session, 'GET', `/api/zones/${zoneId}`),
        workApiRequest(session, 'GET', '/api/ad-groups'),
        workApiRequest(session, 'GET', '/api/campaigns'),
        workApiRequest(session, 'GET', '/api/ads'),
        workApiRequest(session, 'GET', '/api/creatives')
      ])

      const zone = asEntity(zoneRaw)
      if (!zone.id) return { content: [{ type: 'text', text: 'Error: Resource not found. Double-check the zone ID.' }] }

      const adGroups = asRows(adGroupsRaw)
      const campaignRows = asRows(campaignsRaw)
      const adRows = asRows(adsRaw)
      const creativeRows = asRows(creativesRaw)

      const campaigns = {}
      for (const c of campaignRows) if (c.id) campaigns[c.id] = { enabled: c.enabled, archived: c.archived }
      const creatives = {}
      for (const c of creativeRows) if (c.id) creatives[c.id] = { archived: c.archived }
      const adsByGroup = {}
      for (const a of adRows) {
        if (!a.adGroupId) continue;
        (adsByGroup[a.adGroupId] ??= []).push({ id: a.id, enabled: a.enabled, archived: a.archived, creativeId: a.creativeId, params: a.params, exceptParams: a.exceptParams })
      }

      const { targeted, conflicting } = selectTargeting(adGroups, zoneId)
      const { groups, summary } = rollupZoneTargeting({
        zoneId,
        zoneCag: zone.creativeAssetGroupId,
        targeted,
        conflicting,
        campaigns,
        adsByGroup,
        creatives,
        mode
      })

      const full = {
        zone: {
          id: String(zone.id),
          name: String(zone.name ?? zone.id),
          creativeAssetGroupId: zone.creativeAssetGroupId,
          templateId: zone.templateId
        },
        mode,
        summary,
        groups,
        conflicting: conflicting.map((g) => ({ id: g.id, name: g.name ?? g.id })),
        scan: {
          adGroupsScanned: adGroups.length,
          campaignsScanned: campaignRows.length,
          adsScanned: adRows.length,
          creativesScanned: creativeRows.length
        }
      }

      // Never drop ad groups (the answer is exhaustive by contract). fitZoneInventory
      // keeps every row and, only if a mega-zone still overflows, sheds the optional
      // `name` field (ids + flags survive) before ever signalling incompleteness. The
      // rollup rides in the content text (header + compact JSON) — the model-visible
      // channel — never in structuredContent alone.
      return fitZoneInventory(full, RESPONSE_SIZE_LIMIT)
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
