/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/zoneInventoryTools.js
 *
 * get_zone_targeting_inventory — composite: which ad groups are DIRECTLY targeted
 * to a zone, and is each fully live (campaign enabled and inside its flight window +
 * ad group + a live ad with a viable creative)? Second sanctioned server-side composite alongside report_query — it
 * fetches whole-network list sets internally and returns only the compact matched
 * rollup, so no ad-group rows are ever paged through the LLM.
 */

import { z } from 'zod'
import { requiredNetworkIdShape } from './_shared.js'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { RESPONSE_SIZE_LIMIT } from '../constants.js'
import { adServesInZone, zoneRequest, refusesEveryVisit, segmentPickFlags } from './eligibility.js'
// Type-only (erased at compile) — keeps the one shared scoped_via enum without a
// runtime import cycle: eligibility.js imports the entity types from here.

// A level is "on" only if enabled and not archived. archived is omitted when
// false, so `!== true` treats a missing key as false.
const on = (x) =>
  !!x && x.enabled === true && x.archived !== true

const has = (arr, v) => Array.isArray(arr) && arr.includes(v)

/**
 * Is this campaign inside its flight window at `now`? Mirrors the serving engine
 * (filterAdgroupsByEnabledCampaigns → isCampaignActive): `dateStart <= now < dateEnd`
 * on ISO strings, `dateEnd` INCLUSIVE (upstream adds a day before comparing), and a
 * missing bound is open ('0000' / '9999').
 *
 * Upstream adds that day with local-time `setDate`, but on a UTC container (GAE flex,
 * node:22-alpine, no TZ), so its window closes at 00:00 UTC after `dateEnd`. The day is
 * added in UTC here to land on that same instant wherever this server runs — local time
 * would shift the end by the host's offset, and by an hour across a DST change.
 *
 * The bounds are NOT treated alike, and deliberately so. An unparsable `dateEnd` is
 * treated as open, because upstream would throw a RangeError there (`addOneDay` calls
 * toISOString on an invalid Date) and one bad record must not fail the whole call. An
 * unparsable `dateStart` is left to the raw string compare, which puts the campaign
 * outside its window — that looks harsh, but it is exactly what the engine does
 * ('not-a-date' <= now is false there too), and matching the engine is the point.
 * Exported for tests.
 */
export function campaignInWindow (campaign, now) {
  if (!campaign) return false
  const nowIso = new Date(now).toISOString()
  const start = campaign.dateStart || '0000'
  let end = '9999'
  if (campaign.dateEnd) {
    const d = new Date(campaign.dateEnd)
    if (!Number.isNaN(d.getTime())) {
      d.setUTCDate(d.getUTCDate() + 1)
      end = d.toISOString()
    }
  }
  return start <= nowIso && nowIso < end
}

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

/**
 * The one-line answer for an archived zone, shared by every zone-keyed tool so the
 * three give the same verdict. An archived zone is not "a zone nothing targets" —
 * the serving engine refuses it before any ad group is considered, so every row a
 * rollup could return is unreachable. Exported for tests.
 */
export function archivedZoneText (zone) {
  return `Zone ${zone.name ?? zone.id} (${zone.id}) is ARCHIVED — the ad server refuses to serve an archived zone, so no ad group can serve here regardless of targeting. No eligibility evaluated. Unarchive the zone to get a meaningful answer.`
}

/**
 * The one-line answer for a segments-on zone the ad server refuses on every visit:
 * neither the zone nor any of its segments passes its own allow/block lists, so
 * findTopAds throws before any ad group is considered. Shared by every zone-keyed
 * tool, like archivedZoneText. Exported for tests.
 */
export function refusedZoneText (zone) {
  return `Zone ${zone.name ?? zone.id} (${zone.id}) has segments on but no segments, and the zone itself fails its own allowlist/blocklist on every visit — the ad server answers every visit with "Zone or segments don't match allowlist/blocklist criteria", so no ad group can serve here regardless of targeting. No eligibility evaluated. Fix the zone's lists or add a segment to get a meaningful answer.`
}

// A zone list rule as the condition an unserved visit meets, in words: an
// allowlist fails on a value it does not name, a blocklist on one it does.
const zoneRuleText = (r) => {
  const more = r.valuesTotal > r.values.length ? ', …' : ''
  const named = r.values.length === 1 && !more ? r.values[0] : `[${r.values.join(', ')}${more}]`
  const many = r.values.length > 1 || more
  if (r.source === 'zone') {
    return `${r.key} is ${r.actual ?? 'not set'} (the zone sets it, and its ${r.op === 'requires' ? `allowlist needs ${named}` : 'blocklist names it'} — so every visit)`
  }
  const fails = r.op === 'requires'
    ? `${r.key} is ${many ? `none of ${named}` : `not ${named}`}`
    : `${r.key} is ${many ? `one of ${named}` : named}`
  if (r.source !== 'zone-default') return fails
  const listed = (r.op === 'excludes' || !!r.actual) && r.values.includes(r.actual)
  if (!listed && more) return `${fails} (the zone default is ${r.actual})`
  const defaultPasses = r.op === 'requires' ? listed : !listed
  return defaultPasses
    ? `${fails} (only when a visit overrides the zone default ${r.actual})`
    : `${fails} (true at the zone default ${r.actual})`
}

/**
 * Appended to every zone-keyed header when the rows describe only some visits:
 * the visits that keep the zone's defaults get no candidate (the served ones all
 * override the named defaults, which the rows therefore read as visit keys), or no
 * unpinned visit gets one and only a visit pinning a segmentId is served, or a share
 * of unpinned visits gets no ad because the zone fails its own lists while its
 * passing segments cover less than 100%. Exported for tests.
 */
export function segmentPickNote (zone, rows = 'the rows below describe') {
  if (zone?.refusesDefaultVisits) {
    const keys = zone.overriddenOnServedVisits ?? []
    const named = keys.length === 1 ? `${keys[0]} is judged as a visit key` : `${keys.join(', ')} are judged as visit keys`
    return ` — NOTE: the ad server refuses every visit that keeps this zone's defaults (no segment, and not the zone itself, passes its lists on them); only visits overriding ${keys.join(', ')} are served, so ${named} below`
  }
  if (zone?.servesOnlyPinnedVisits) {
    return ` — NOTE: the ad server picks no segment for any visit that does not name a segmentId (no segment passes its lists with reachable allocation, and the zone itself does not either); only a visit pinning a segmentId — which skips those checks — is served, so ${rows} that rare traffic`
  }
  if (zone?.unservedShare) {
    const { min, max, atDefaults, zoneRules = [] } = zone.unservedShare
    const lead = min === max ? `${max}%` : min > 0 ? `between ${min}% and ${max}%` : `up to ${max}%`
    const atDefault = atDefaults === undefined ? '' : ` (${atDefaults}% of the visits keeping the zone's defaults)`
    const tail = min === max ? '' : `, depending on the visit${atDefault}; segments whose lists exclude each other can leave the real share well inside these bounds`
    return ` — NOTE: ${lead} of the visits that do not pin a segmentId get no ad at all${tail}.${zoneRules.length ? ` It happens only on visits where ${zoneRules.map(zoneRuleText).join(', or ')}: on those` : ' On those visits'} the zone fails its own allowlist/blocklist, so it takes no share of the draw, and the segments that pass cover the rest; ${rows} only the served visits`
  }
  return ''
}

/**
 * The zone's channel, for the `channelType` the serving engine adds to every
 * request — or null when it does not exist (a 404, or a zone with no channelId).
 * xtendOptions looks the channel up with channel.get on every visit, which throws
 * NotFound for a missing one, so such a zone serves nothing: callers answer that,
 * as for an archived zone. Every other failure (401, 5xx, timeout) is rethrown —
 * guessing a channelType would answer a different question than the one asked.
 * `get` is the caller's own workApiRequest, so each tool module fetches through
 * the client it imported.
 */
export async function fetchChannel (session, channelId, get = workApiRequest) {
  if (!channelId) return null
  try {
    const c = asEntity(await get(session, 'GET', `/api/channels/${channelId}`))
    return c.id ? c : null
  } catch (e) {
    if (e?.status === 404) return null
    throw e
  }
}

/**
 * The one-line answer for a zone whose channel does not exist, shared by every
 * zone-keyed tool like archivedZoneText. Exported for tests.
 */
export function missingChannelText (zone) {
  const which = zone.channelId ? `points at channel ${zone.channelId}, which does not exist` : 'has no channel'
  return `Zone ${zone.name ?? zone.id} (${zone.id}) ${which} — the ad server looks the zone's channel up on every visit and fails without it, so no ad group can serve here regardless of targeting. No eligibility evaluated. Give the zone an existing channel to get a meaningful answer.`
}

/** What keeps this ad itself from being live: the ad switched off or archived, or
 * its creative missing or archived. Empty when the ad is live. Zone-independent on
 * purpose: the caller has already decided the ad serves in the zone (adServesHere /
 * adServesInZone). Shared with the offer grain so "live" means the same thing in
 * both tools, and so the offer grain can say WHAT is off. */
export function adOffReasons (ad, creatives) {
  const off = []
  if (ad.archived === true) off.push('ad-archived')
  else if (ad.enabled !== true) off.push('ad-disabled')
  const c = ad.creativeId === undefined ? undefined : creatives[ad.creativeId]
  if (c === undefined) off.push('creative-missing')
  else if (c.archived === true) off.push('creative-archived')
  return off
}

/** Is this ad itself live — enabled, not archived, and pointing at an existing,
 * non-archived creative? */
export function adLiveViable (ad, creatives) {
  return adOffReasons(ad, creatives).length === 0
}

/** The campaign → ad group half of the chain: the campaign enabled, not archived and
 * inside its flight window, the ad group enabled and not archived. */
export function chainState (campaign, adGroup, now) {
  const campaign_enabled = on(campaign)
  return { campaign_enabled, campaign_on: campaign_enabled && campaignInWindow(campaign, now), adgroup_on: on(adGroup) }
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
  const { zoneId, zoneCag, targeted, conflicting, campaigns, adsByGroup, creatives, mode, now, request } = args
  // Required, not defaulted: campaign liveness is time-dependent, and a silent
  // fallback to the real clock would let a test assert a window it never pinned.
  if (now === undefined) throw new TypeError('rollupZoneTargeting: `now` is required — campaign windows are time-dependent')
  const creativeResolves = (creativeId) =>
    creativeId !== undefined && creatives[creativeId] !== undefined

  // Per-ad LAST targeting check (adServesInZone): an ad is hidden in THIS zone if
  // its own zoneId whitelist/blacklist rules it out or, with a request, another of
  // its params keys excludes it. One hidden ad doesn't sink the group — its siblings
  // still serve. A conditional ad still counts: it serves on matching traffic.
  const adServesHere = (a) => zoneId === undefined || adServesInZone(a, zoneId, request)

  const all = targeted.map((ag) => {
    const campaign = ag.campaignId !== undefined ? campaigns[ag.campaignId] : undefined
    const ads = adsByGroup[ag.id] ?? []

    // A campaign is on only while it is enabled, not archived, AND inside its flight
    // window — the engine drops its ad groups the moment the window closes. The engine's
    // campaign filter checks enabled + window only; the `archived` term is ours, and it
    // cannot disagree in practice (archiving a campaign writes enabled:false in the same
    // op and cascades to its ad groups), so it only guards inconsistent data.
    const { campaign_enabled, campaign_on, adgroup_on } = chainState(campaign, ag, now)
    const has_enabled_ad = ads.some(on)
    const creative_resolves = ads.some((a) => creativeResolves(a.creativeId))
    // Live-viable is zone-specific: only ads that actually serve in this zone count.
    const has_live_viable_ad = ads.some((a) => adServesHere(a) && adLiveViable(a, creatives))
    const archived = ag.archived === true

    const off_reason = []
    // Two different fixes, so two different reasons: switch the campaign on, or
    // move its dates.
    if (!campaign_on) off_reason.push(campaign_enabled ? 'campaign-window' : 'campaign')
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
    // Falsy zone CAG = no CAG filter upstream, so a "match" there is the absence of
    // scoping rather than zone-selection.
    if (zoneCag && ag.creativeAssetGroupId === zoneCag) scoped_via.push('zone-selection')

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
  return `Zone ${s.zone.name} (${s.zone.id}) — ${flags}${degrade}${segmentPickNote(s.zone)}`
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
    description: `Audit which ad groups are DIRECTLY targeted to a zone (via the ad group's params.zoneId) and, for each, whether it is FULLY LIVE — campaign, ad group, and at least one ad all enabled (and not archived) with a viable creative attached, and the campaign inside its dateStart/dateEnd flight window (dateEnd inclusive, a missing bound open) — or where it is off. An enabled campaign whose window has passed is reported campaign_on:false with off_reason 'campaign-window', distinct from 'campaign' (switched off or archived). Exhaustive and server-side: it scans the whole network's ad groups/campaigns/ads/creatives internally and returns only the compact matched rollup, so nothing is paged through the model. exceptParams.zoneId is treated as an exclusion (a group that both targets and excepts the zone is reported under 'conflicting', not 'targeted').

The result is the text content: a one-line header, then a blank line, then compact JSON { zone, mode, summary, groups[], conflicting[], scan }. Parse the JSON (everything after the first blank line) to render the table. Each groups[] row: { id, name, archived, campaign_on, adgroup_on, has_enabled_ad, creative_resolves, has_live_viable_ad, fully_live, off_reason[], scoped_via[] }. has_live_viable_ad counts only ads whose own targeting rules let them serve in this zone — zoneId and every other params / exceptParams key, checked against what the zone itself decides (e.g. an ad blacklisting the zone's template does not count); an ad that depends on the visit (device, geo, time) still counts, since it serves on matching traffic. fully_live does NOT check the GROUP's own rules beyond zoneId (e.g. exceptParams.templateId naming this zone's template, or a mobile-only params.device): a group those rules keep out, always or for some visitors, still reads fully_live here. get_zone_eligible_ad_groups applies them, so its summary.directlyTargetedLive (eligible groups with a live ad that serves every visit keeping the zone's defaults) can be LOWER than this tool's live count on the same zone; the gap is exactly the targeted groups reading fully_live:true here that it reports as verdict 'excluded' or 'conditional' — for those rules, and also for a creativeAssetGroupId that does not match the zone's, which this tool does not check either — plus the eligible groups whose live ads all depend on the visit (directlyTargetedLiveOnConditionalAds): has_live_viable_ad here counts a geo-only ad as live. Use that tool when the question is whether a group actually serves. scoped_via lists HOW the group is scoped to the zone (annotate-only, the row set is unchanged). It uses ONE shared enum across every tool that emits the field — 'ad-group-whitelist' (the group's params.zoneId names the zone — always present on a targeted row), 'ad-group-blacklist' (the group's exceptParams.zoneId excludes the zone; such a group is reported under 'conflicting' here, so this value is rare on a targeted row and common on the eligibility tool's conflicting rows), 'ad-level-whitelist' (one of its ads also whitelists the zone), 'ad-level-blacklist' (one of its ads excludes the zone via ad.exceptParams.zoneId — that ad is hidden here, siblings still serve), 'zone-selection' (the group shares the zone's creativeAssetGroupId — never set when the zone has no creativeAssetGroupId, since no CAG filter applies there). Same five values, same meaning, in get_zone_eligible_ad_groups and explain_serve. For per-(ad group × ad) offer-grain scoping and free-radical counts, use get_zone_eligible_ad_groups. The tool answers in one line, with no rollup, when the ad server refuses the zone on every visit: the zone is ARCHIVED, its channel does not exist (or it has none — the channel is looked up on every visit), or it has segments on with no segments and fails its own allowlist/blocklist — a targeting rollup for it would describe config that cannot run. When a segments zone serves only some visits, the rollup comes with a header NOTE and a flag on zone: refusesDefaultVisits + overriddenOnServedVisits[] (visits keeping the zone's defaults get no ad; the served ones override the named defaults), servesOnlyPinnedVisits (only a visit naming a segmentId is served), or unservedShare { min, max, atDefaults?, zoneRules[] } (bounds, in percent, on the share of visits not naming a segmentId that get no ad, because the zone fails its own allowlist/blocklist while the segments that pass cover less than 100%; atDefaults is the exact share for visits keeping the zone's defaults when known; zoneRules[] names the zone's own list rules that some visit fails — an unserved visit fails at least one — and the header NOTE words each as the condition those visits meet). This tool NEVER drops ad groups: the row set is always complete. If a mega-zone would overflow the response, it first omits the optional 'name' field (sets namesOmitted:true; ids + flags remain), and only as a last resort for pathological sizes returns ids-only with complete:false plus an instruction to re-run with mode:'off'/'live' — it never silently returns a partial list.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      zoneId: z.string().describe('Zone ID to audit targeting for'),
      mode: z.enum(['all', 'live', 'off']).default('all').describe('Filter the returned groups: all (default), only fully-live, or only not-fully-live. Summary counts always cover the full targeted set.')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ zoneId, mode, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    const session = v.session
    try {
      // Every list endpoint returns the full network set in one call; fetch in parallel.
      // The channel hangs off the zone, so it chains on the zone fetch alone.
      const zoneP = workApiRequest(session, 'GET', `/api/zones/${zoneId}`)
      const [zoneRaw, channel, adGroupsRaw, campaignsRaw, adsRaw, creativesRaw] = await Promise.all([
        zoneP,
        zoneP.then((raw) => fetchChannel(session, asEntity(raw).channelId), () => null),
        workApiRequest(session, 'GET', '/api/ad-groups', { networkId: network_id }),
        workApiRequest(session, 'GET', '/api/campaigns', { networkId: network_id }),
        workApiRequest(session, 'GET', '/api/ads', { networkId: network_id }),
        workApiRequest(session, 'GET', '/api/creatives', { networkId: network_id })
      ])

      const zone = asEntity(zoneRaw)
      if (!zone.id) return { content: [{ type: 'text', text: 'Error: Resource not found. Double-check the zone ID.' }] }
      if (zone.networkId && zone.networkId !== network_id) return { content: [{ type: 'text', text: `Error: Zone '${zoneId}' belongs to network '${zone.networkId}', not '${network_id}'.` }] }
      // An archived zone serves nothing — the serving engine refuses it outright
      // (throwIfZoneArchived), so a targeting rollup for it would describe config
      // that cannot run. Say so instead of returning rows that read as live.
      if (zone.archived === true) return { content: [{ type: 'text', text: archivedZoneText(zone) }] }

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

      if (!channel) return { content: [{ type: 'text', text: missingChannelText(zone) }] }
      const request = zoneRequest(zone, channel)
      if (refusesEveryVisit(request)) return { content: [{ type: 'text', text: refusedZoneText(zone) }] }
      const { targeted, conflicting } = selectTargeting(adGroups, zoneId)
      const { groups, summary } = rollupZoneTargeting({
        zoneId,
        zoneCag: zone.creativeAssetGroupId,
        targeted,
        conflicting,
        campaigns,
        adsByGroup,
        creatives,
        mode,
        now: Date.now(),
        request
      })

      const full = {
        zone: {
          id: String(zone.id),
          name: String(zone.name ?? zone.id),
          creativeAssetGroupId: zone.creativeAssetGroupId,
          templateId: zone.templateId,
          ...segmentPickFlags(request)
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
