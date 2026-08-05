/**
 * tools/zoneEligibilityTools.ts
 *
 * Three thin reads over the pure `eligibility` join (tools/eligibility.ts):
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError } from "../services/workApi.js";
import { RESPONSE_SIZE_LIMIT } from "../constants.js";
import {
  asRows, asEntity, rollupZoneTargeting, adLiveViable,
  type AdGroup, type Ad, type Campaign, type Creative, type Row,
} from "./zoneInventoryTools.js";
import {
  eligibility, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  type Eligibility, type OfferRollup,
} from "./eligibility.js";

type ZoneLite = { id: string; name?: string; creativeAssetGroupId?: string; templateId?: string };
type TextResult = { content: { type: "text"; text: string }[] };

const err = (text: string): TextResult => ({ content: [{ type: "text" as const, text }] });

/** Resolve + validate the session; returns the session or a ready-to-return error. */
async function guard(extra: { sessionId?: string } | undefined): Promise<
  { ok: true; session: Awaited<ReturnType<typeof validateSession>>["session"] } | { ok: false; result: TextResult }
> {
  const sessionId = await resolveLincxSession(extra?.sessionId);
  if (!sessionId) return { ok: false, result: err("Error: Not authenticated. Use 'auth_login' first.") };
  const v = await validateSession(sessionId);
  if (!v.valid || !v.session) return { ok: false, result: err(`Error: ${v.error}`) };
  return { ok: true, session: v.session };
}

type Index = {
  zones: ZoneLite[]; adGroups: AdGroup[];
  campaigns: Record<string, Campaign>; creatives: Record<string, Creative>;
  adsByGroup: Record<string, Ad[]>;
  scan: { zonesScanned: number; adGroupsScanned: number; campaignsScanned: number; adsScanned: number; creativesScanned: number };
};

/** One GET per entity — each returns the whole network set (documented in workApi). */
async function fetchIndex(session: NonNullable<Awaited<ReturnType<typeof validateSession>>["session"]>): Promise<Index> {
  const [zonesRaw, adGroupsRaw, campaignsRaw, adsRaw, creativesRaw] = await Promise.all([
    workApiRequest<unknown>(session, "GET", "/api/zones"),
    workApiRequest<unknown>(session, "GET", "/api/ad-groups"),
    workApiRequest<unknown>(session, "GET", "/api/campaigns"),
    workApiRequest<unknown>(session, "GET", "/api/ads"),
    workApiRequest<unknown>(session, "GET", "/api/creatives"),
  ]);
  const zones = asRows<ZoneLite>(zonesRaw);
  const adGroups = asRows<AdGroup>(adGroupsRaw);
  const campaignRows = asRows<{ id: string; enabled?: boolean; archived?: boolean }>(campaignsRaw);
  const adRows = asRows<Ad & { adGroupId?: string }>(adsRaw);
  const creativeRows = asRows<{ id: string; archived?: boolean }>(creativesRaw);

  const campaigns: Record<string, Campaign> = {};
  for (const c of campaignRows) if (c.id) campaigns[c.id] = { enabled: c.enabled, archived: c.archived };
  const creatives: Record<string, Creative> = {};
  for (const c of creativeRows) if (c.id) creatives[c.id] = { archived: c.archived };
  const adsByGroup: Record<string, Ad[]> = {};
  for (const a of adRows) {
    if (!a.adGroupId) continue;
    (adsByGroup[a.adGroupId] ??= []).push({ id: a.id, enabled: a.enabled, archived: a.archived, creativeId: a.creativeId, params: a.params, exceptParams: a.exceptParams });
  }
  return {
    zones, adGroups, campaigns, creatives, adsByGroup,
    scan: {
      zonesScanned: zones.length, adGroupsScanned: adGroups.length,
      campaignsScanned: campaignRows.length, adsScanned: adRows.length, creativesScanned: creativeRows.length,
    },
  };
}

/** header + compact JSON in the content text; degrade only by shedding row bodies
 * (never the exact summary counts) if a pathological set overflows the guard.
 * `rowKeys` maps each row-array key to the field to keep as its id when shedding.
 * Used by the two small tools (reach / explain_serve); the eligibility rollup
 * pages instead — see fitEligibility. `complete:false` is the shared "this is
 * not the whole answer" flag across the whole family (was `truncated`). */
function pack(header: string, payload: Record<string, unknown>, rowKeys: Record<string, "id" | "adGroupId" | "zoneId">): TextResult {
  const render = (p: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: `${header}\n\n${JSON.stringify(p)}` }] });
  const full = render({ ...payload, complete: true });
  if (JSON.stringify(full).length <= RESPONSE_SIZE_LIMIT) return full;
  // Overflow: replace each row array with just its ids + complete:false. Summary stays exact.
  const shed: Record<string, unknown> = { ...payload, complete: false };
  for (const [k, idKey] of Object.entries(rowKeys)) {
    const rows = payload[k];
    if (Array.isArray(rows)) shed[k] = rows.map((r) => (r as Record<string, string>)[idKey]);
  }
  return render(shed);
}

export type EnrichedRow = Row & {
  eligible: boolean; via: string[]; reasons: string[]; conflicts: string[]; offers: OfferRollup;
};

/** Merge each group's live rollup row with its join verdict (eligible/via/reasons/
 * conflicts) and its offer-grain (ad group × ad) counts. */
function enrich(elig: Eligibility[], idx: Index, zoneId: string, zoneCag?: string): EnrichedRow[] {
  const byId = new Map(elig.map((e) => [e.adGroupId, e]));
  const groups = idx.adGroups.filter((g) => byId.has(g.id));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const zone = { id: zoneId, creativeAssetGroupId: zoneCag };
  const { groups: rows } = rollupZoneTargeting({
    zoneId, zoneCag, targeted: groups, conflicting: [],
    campaigns: idx.campaigns, adsByGroup: idx.adsByGroup, creatives: idx.creatives, mode: "all",
  });
  return rows.map((r) => {
    const e = byId.get(r.id)!;
    // Offer-grain liveness = the group's own chain (campaign + ad group) AND this ad.
    // Same predicate the inventory rollup uses for has_live_viable_ad, per ad instead
    // of "some ad", so a dormant free-radical host reports freeRadicalLive: 0.
    const isLive = (ad: Ad) => r.campaign_on && r.adgroup_on && adLiveViable(ad, idx.creatives);
    const offers = offerRollup(e, groupById.get(r.id)!, idx.adsByGroup[r.id] ?? [], zone, isLive);
    return { ...r, eligible: e.eligible, via: e.via, reasons: e.reasons, conflicts: e.conflicts, offers };
  });
}

type OfferCount = Exclude<keyof OfferRollup, "freeRadicalAdIds" | "inertWhitelistedAdIds">;

/**
 * Counts for get_zone_eligible_ad_groups, exported for tests. Grain matters:
 * `freeRadical*` is summed over the free-radical bucket ONLY — a directly-targeted
 * group's offers always carry `ad-group-whitelist`, and a conflicting group is never
 * eligible, so neither can hold a free-radical offer. The ad-level totals cover both
 * SERVING buckets (direct + radicals); `conflicting` is excluded because nothing in it
 * serves. `directlyTargeted + conflicting` still reconciles to get_zone_targeting_inventory.
 */
export function summarizeEligibility(
  direct: EnrichedRow[], radicals: EnrichedRow[], conflict: EnrichedRow[], inert: EnrichedRow[] = [],
) {
  const sum = (rows: EnrichedRow[], k: OfferCount) => rows.reduce((n, r) => n + r.offers[k], 0);
  return {
    directlyTargeted: direct.length,
    directlyTargetedLive: direct.filter((r) => r.fully_live).length,
    directlyTargetedIneligible: direct.filter((r) => !r.eligible).length,
    // HOST grain: the free radical is the OFFER; the group only hosts it. A host
    // with 0 free-radical offers is not itself a leak.
    freeRadicalHosts: radicals.length,
    freeRadicalHostsLive: radicals.filter((r) => r.fully_live).length,
    // Offer grain (ad group × ad) — the true CAG-leak count. A free-radical HOST
    // whose only ad is zone-whitelisted contributes 0 free-radical offers.
    freeRadicalOffers: sum(radicals, "freeRadical"),
    // …of those, the ones live right now. freeRadicalOffers sums across dormant
    // hosts too, so on its own it reads as live exposure and isn't. The gap between
    // the two IS the standing-trap volume — offers a single toggle (most often the
    // campaign) away from landing in the zone.
    freeRadicalOffersLive: sum(radicals, "freeRadicalLive"),
    adLevelTargetedOffers: sum(direct, "adLevelTargeted") + sum(radicals, "adLevelTargeted"),
    adLevelBlacklistedOffers: sum(direct, "adLevelBlacklisted") + sum(radicals, "adLevelBlacklisted"),
    conflicting: conflict.length,
    // Config defects, not serving: an ad whitelists this zone under a group that
    // cannot reach it, so the whitelist never fires. Counted at both grains — the
    // groups hosting dead config, and the dead ads themselves.
    inertWhitelistGroups: inert.length,
    inertWhitelistOffers: sum(inert, "inertWhitelisted"),
  };
}

export type Bucket = "all" | "directlyTargeted" | "freeRadicals" | "conflicting" | "inertWhitelists";
const BUCKETS = ["directlyTargeted", "freeRadicals", "conflicting", "inertWhitelists"] as const;
export type EligibilityPayload = {
  zone: ZoneLite;
  summary: ReturnType<typeof summarizeEligibility>;
  directlyTargeted: EnrichedRow[]; freeRadicals: EnrichedRow[]; conflicting: EnrichedRow[];
  inertWhitelists: EnrichedRow[];
  scan: Index["scan"];
};
type Page = { bucket: Bucket; offset: number; returned: number; total: number; next_offset?: number };

/** One-line human header: exact counts always, plus the page state when paged. */
export function eligibilityHeader(zone: ZoneLite, s: EligibilityPayload["summary"], page?: Page): string {
  const inert = s.inertWhitelistOffers > 0
    ? ` · ${s.inertWhitelistOffers} INERT ad-level whitelists across ${s.inertWhitelistGroups} out-of-scope groups (dead config: the ad names this zone, its group cannot reach it)`
    : "";
  const counts = `${s.directlyTargeted} targeted (${s.directlyTargetedLive} live, ${s.directlyTargetedIneligible} config-ineligible) · ${s.freeRadicalHosts} free-radical hosts (${s.freeRadicalHostsLive} live) / ${s.freeRadicalOffers} free-radical offers (${s.freeRadicalOffersLive} live) · ${s.conflicting} conflicting${inert}`;
  // Two paged states, both spelled out. The TAIL page is the one that reads like a
  // bug: it carries complete:false (correct — this response does NOT hold the whole
  // slice, it starts at a non-zero offset) with no next_offset. Two reviewers have
  // now filed that as "complete is broken", so the header says it outright rather
  // than leaving the flag to be inferred.
  const rows = page ? `rows ${page.offset}–${page.offset + page.returned - 1} of ${page.total} for bucket '${page.bucket}'` : "";
  const paged = page === undefined ? ""
    : page.next_offset !== undefined
    ? ` — PARTIAL PAGE: ${rows}; re-run with offset:${page.next_offset} (same bucket) for the rest. Summary counts above are exact for the WHOLE set.`
    : page.offset > 0
    ? ` — FINAL PAGE: ${rows}; no next_offset, so paging is done. complete is false BY DESIGN here — it means "this one response is not the whole slice", not "more pages remain". Page on the absence of next_offset, never on complete. Summary counts above are exact for the WHOLE set.`
    : "";
  return `Zone ${zone.name} (${zone.id}) — ${counts}${paged}`;
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
export function fitEligibility(full: EligibilityPayload, bucket: Bucket, offset: number, limit: number): TextResult {
  const flat: { bucket: (typeof BUCKETS)[number]; row: EnrichedRow }[] = [];
  for (const b of BUCKETS) {
    if (bucket !== "all" && bucket !== b) continue;
    for (const row of full[b] ?? []) flat.push({ bucket: b, row });
  }
  const window = flat.slice(Math.max(0, offset));

  const render = (body: Record<string, unknown>, page?: Page): TextResult => ({
    content: [{ type: "text" as const, text: `${eligibilityHeader(full.zone, full.summary, page)}\n\n${JSON.stringify(body)}` }],
  });

  const build = (n: number): { result: TextResult; size: number } => {
    const slice = window.slice(0, n);
    const page: Page = {
      bucket, offset, returned: slice.length, total: flat.length,
      ...(offset + slice.length < flat.length ? { next_offset: offset + slice.length } : {}),
    };
    // complete = this response holds the ENTIRE selected slice — nothing before it
    // (offset 0) and nothing after it (no next_offset). Offset-relative "nothing
    // left" would report complete:true on a tail page holding 37 of 207 rows, and a
    // reconciliation check against `summary` would then read as a regression.
    const complete = offset === 0 && page.next_offset === undefined;
    const body: Record<string, unknown> = { zone: full.zone, summary: full.summary, page, complete };
    for (const b of BUCKETS) {
      if (bucket !== "all" && bucket !== b) continue;
      body[b] = slice.filter((s) => s.bucket === b).map((s) => s.row);
    }
    body.scan = full.scan;
    const result = render(body, page);
    return { result, size: JSON.stringify(result).length };
  };

  const whole = build(window.length);
  if (whole.size <= limit) return whole.result;

  // Largest prefix that fits. Rows vary in size, so binary-search rather than assume.
  let lo = 0, hi = window.length, best: TextResult | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === 0) { lo = 1; continue; }
    const attempt = build(mid);
    if (attempt.size <= limit) { best = attempt.result; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (best) return best;

  // Pathological: even one full row overflows the budget. Ids only, flagged.
  return render({
    zone: full.zone, summary: full.summary, bucket, complete: false,
    note: "A single ad-group row exceeds the response budget, so only ids are returned. Re-run with bucket:'freeRadicals' | 'directlyTargeted' | 'conflicting' to narrow, or use explain_serve for one (zone, ad group) pair. Summary counts are exact.",
    ids: window.map((s) => s.row.id),
    scan: full.scan,
  });
}

export function registerZoneEligibilityTools(server: McpServer): void {
  // 1) zone → eligible ad groups (directly targeted + free radicals)
  server.registerTool("get_zone_eligible_ad_groups", {
    title: "Zone Eligible Ad Groups",
    description: `List every ad group ELIGIBLE to serve in a zone — not just the ones directly targeted. An ad group is eligible when it is NOT archived (archived = out of service), its creativeAssetGroupId matches the zone's, it is not blacklisted (zone in its exceptParams.zoneId), and it is in scope: the group's params.zoneId names the zone OR it targets ZERO zones (open within its CAG). Ad-level params/exceptParams are a per-ad LAST check (filterAdgroups runs first, so an ad-level whitelist can never rescue an ineligible group) — they decide WHICH ads serve within an eligible group, feed has_live_viable_ad, and drive the offer-grain counts below. Results split into 'directlyTargeted' (ad-group-whitelisted and not blacklisted — this reconciles to get_zone_targeting_inventory's targeted set; groups that are targeted but config-broken, e.g. CAG mismatch, are KEPT here with eligible:false and their reasons[]/conflicts[], never silently dropped), 'freeRadicals' (eligible via the shared CAG only — they leak in despite no direct targeting), 'conflicting' (targets AND excepts the zone), and 'inertWhitelists' (DEAD CONFIG: the group cannot reach this zone, yet one of its ads whitelists the zone via ad.params.zoneId — filterAdgroups runs first, so that whitelist never fires and the ad silently does not serve here, even though the config reads as if it is targeted). directlyTargeted + conflicting reconciles to the inventory tool; inertWhitelists is disjoint from both and nothing in it serves.

FREE RADICALS ARE REPORTED AT TWO GRAINS. The 'freeRadicals' row set is HOST grain (summary.freeRadicalHosts): ad groups eligible only via the shared CAG — the free radical is the OFFER, the group merely hosts it. The true leak count is OFFER grain — an (ad group × ad) pair that serves solely via the CAG, i.e. an untargeted ad (empty params.zoneId) under an untargeted group, net of blacklists at BOTH levels (summary.freeRadicalOffers). An untargeted group whose only ad is zone-whitelisted is 1 free-radical HOST but 0 free-radical OFFERS — that ad renders because it is ad-level-targeted, not via the CAG.

BOTH GRAINS HAVE A LIVE AXIS, AND ONLY THE LIVE ONE IS EXPOSURE. summary.freeRadicalOffers sums across dormant hosts (a host whose campaign is off still contributes offers), so on its own it reads as live leak and is not; summary.freeRadicalOffersLive counts only offers whose whole chain is on (campaign + ad group + ad + viable creative) — that is what is leaking into the zone right now. The gap between them is standing-trap volume: config that lands in the zone the moment one toggle flips, most often the campaign. Per row, offers.freeRadical > 0 with offers.freeRadicalLive === 0 identifies exactly those hosts.

Every row carries offers: { total, inScope, live, freeRadical, freeRadicalLive, adLevelTargeted, adLevelBlacklisted, confinedElsewhere, inertWhitelisted, freeRadicalAdIds[], inertWhitelistedAdIds[] } so a pure free-radical subset is derivable. offers.inScope is TARGETING ONLY — the group is eligible and this ad is neither blacklisted nor confined to other zones — and says nothing about on/off state; offers.live is the same set with the whole chain on. summary also totals adLevelTargetedOffers, adLevelBlacklistedOffers, inertWhitelistGroups and inertWhitelistOffers.

Each row also carries the same live rollup as get_zone_targeting_inventory (campaign_on, adgroup_on, has_live_viable_ad, fully_live, off_reason[], scoped_via[]) plus eligible, via[], reasons[], conflicts[]. scoped_via uses the SAME five-value enum as get_zone_targeting_inventory and explain_serve ('ad-group-whitelist' | 'ad-group-blacklist' | 'ad-level-whitelist' | 'ad-level-blacklist' | 'zone-selection').

EVERY RETURNED ROW IS COMPLETE — the offer payload is never stripped to fit. A zone with too many groups for one response is PAGED, not degraded: use bucket to select one bucket (e.g. bucket:'freeRadicals' for a pure free-radical subset) and offset to walk the rest. The response carries page: { bucket, offset, returned, total, next_offset? } and complete (true only when this ONE response holds the entire selected slice — offset 0 and no next_offset). summary is ALWAYS exact over the full set, regardless of bucket/offset — so with bucket:'all' and complete:true the arrays match the summary counts one-for-one. The only case where a row body is not returned is pathological (a single ad group whose row alone exceeds the whole response budget): then ids are returned with complete:false and a note, never a silent partial. Whole-network scan server-side; compact result in the content text (header + compact JSON).`,
    inputSchema: z.object({
      zoneId: z.string().describe("Zone ID to list eligible ad groups for"),
      bucket: z.enum(["all", "directlyTargeted", "freeRadicals", "conflicting", "inertWhitelists"]).default("all")
        .describe("Which bucket(s) to return rows for. Summary counts always cover the full set; this only narrows the ROWS so a large zone fits in one response (e.g. 'freeRadicals' for a pure free-radical subset, or 'inertWhitelists' for ads whose zone whitelist is dead because their group cannot reach the zone)."),
      offset: z.number().int().min(0).default(0)
        .describe("Row offset within the selected bucket(s) — pass the next_offset from a previous call to continue."),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ zoneId, bucket, offset }, extra) => {
    const g = await guard(extra);
    if (!g.ok) return g.result;
    try {
      const zoneRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/zones/${zoneId}`);
      const zone = asEntity(zoneRaw);
      if (!zone.id) return err("Error: Resource not found. Double-check the zone ID.");
      const idx = await fetchIndex(g.session!);
      const zoneLite: ZoneLite = { id: String(zone.id), name: String(zone.name ?? zone.id), creativeAssetGroupId: zone.creativeAssetGroupId as string | undefined, templateId: zone.templateId as string | undefined };

      const { directlyTargeted, freeRadicals, conflicting, inertWhitelists } = zoneEligibility(idx.adGroups, zoneLite, idx.adsByGroup);
      const direct = enrich(directlyTargeted, idx, zoneLite.id, zoneLite.creativeAssetGroupId);
      const radicals = enrich(freeRadicals, idx, zoneLite.id, zoneLite.creativeAssetGroupId);
      const conflict = enrich(conflicting, idx, zoneLite.id, zoneLite.creativeAssetGroupId);
      const inert = enrich(inertWhitelists, idx, zoneLite.id, zoneLite.creativeAssetGroupId);

      const summary = summarizeEligibility(direct, radicals, conflict, inert);
      return fitEligibility(
        { zone: zoneLite, summary, directlyTargeted: direct, freeRadicals: radicals, conflicting: conflict, inertWhitelists: inert, scan: idx.scan },
        bucket, offset, RESPONSE_SIZE_LIMIT,
      );
    } catch (e) { return err(handleWorkApiError(e)); }
  });

  // 2) ad group → zones it can serve/leak into
  server.registerTool("get_ad_group_zone_reach", {
    title: "Ad Group Zone Reach",
    description: `Show every zone an ad group can serve or LEAK into — the flip of get_zone_eligible_ad_groups. For the given ad group, evaluates the same eligibility join against all zones: it reaches a zone when the CAG matches, it is not blacklisted there, and it is in scope (whitelists the zone or targets zero zones → free radical across every zone sharing its CAG). Returns each reachable zone with via[] and any conflicts[]. Whole-network scan server-side; compact result in the content text.`,
    inputSchema: z.object({ adGroupId: z.string().describe("Ad group ID to compute zone reach for") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ adGroupId }, extra) => {
    const g = await guard(extra);
    if (!g.ok) return g.result;
    try {
      const agRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/ad-groups/${adGroupId}`);
      const agE = asEntity(agRaw);
      if (!agE.id) return err("Error: Resource not found. Double-check the ad group ID.");
      const adGroup: AdGroup = {
        id: String(agE.id), name: agE.name as string | undefined, archived: agE.archived as boolean | undefined,
        params: agE.params as AdGroup["params"], exceptParams: agE.exceptParams as AdGroup["exceptParams"],
        creativeAssetGroupId: agE.creativeAssetGroupId as string | undefined,
      };
      const idx = await fetchIndex(g.session!);
      const ads = idx.adsByGroup[adGroup.id] ?? [];
      const reach = adGroupReach(adGroup, idx.zones, ads);
      const named = reach.map((e) => ({ ...e, zoneName: idx.zones.find((z) => z.id === e.zoneId)?.name ?? e.zoneId }));
      const direct = named.filter((e) => e.via.includes("ad-group-whitelist")).length;
      const header = `Ad group ${adGroup.name ?? adGroup.id} (${adGroup.id}) reaches ${reach.length} zones — ${direct} targeted · ${reach.length - direct} via shared CAG (free radical)`;
      return pack(header, { adGroup: { id: adGroup.id, name: adGroup.name, creativeAssetGroupId: adGroup.creativeAssetGroupId }, summary: { reaches: reach.length, targeted: direct, freeRadical: reach.length - direct }, zones: named, scan: idx.scan }, { zones: "zoneId" });
    } catch (e) { return err(handleWorkApiError(e)); }
  });

  // 3) (zone, adGroup|ad) pair → why did/​didn't X serve here
  server.registerTool("explain_serve", {
    title: "Explain Serve",
    description: `Explain, for a single (zone, ad group OR ad) pair, whether it is eligible to serve in the zone, by what path (via[]), and if not, why not (reasons[]) — the "why did X serve in this zone?" direction of the eligibility join. Pass exactly one of adGroupId or adId (an adId is resolved to its ad group; its own ad-level whitelist/blacklist for the zone is also reported). With an adId the answer is at the OFFER grain (ad group × ad): it adds offer: { scoped_via[] — 'ad-group-whitelist' | 'ad-group-blacklist' | 'ad-level-whitelist' | 'ad-level-blacklist' | 'zone-selection' — freeRadical, true only when the pair serves via the shared CAG alone (untargeted group AND untargeted ad, net of blacklists at both levels), and conflicts[], which carries 'inert-ad-level-whitelist' when this ad whitelists the zone but its group cannot reach it, so the whitelist is dead config that never fires }. Returns the single eligibility verdict with any conflicts[]. Whole-network scan server-side.`,
    inputSchema: z.object({
      zoneId: z.string().describe("Zone ID to explain serving in"),
      adGroupId: z.string().optional().describe("Ad group ID to explain (omit if passing adId)"),
      adId: z.string().optional().describe("Ad ID to explain (resolved to its ad group; omit if passing adGroupId)"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ zoneId, adGroupId, adId }, extra) => {
    if ((adGroupId ? 1 : 0) + (adId ? 1 : 0) !== 1) return err("Error: pass exactly one of adGroupId or adId.");
    const g = await guard(extra);
    if (!g.ok) return g.result;
    try {
      const zoneRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/zones/${zoneId}`);
      const zone = asEntity(zoneRaw);
      if (!zone.id) return err("Error: Resource not found. Double-check the zone ID.");
      const zoneLite: ZoneLite = { id: String(zone.id), name: String(zone.name ?? zone.id), creativeAssetGroupId: zone.creativeAssetGroupId as string | undefined };

      let ad: (Ad & { adGroupId?: string }) | undefined;
      let groupId = adGroupId;
      if (adId) {
        const adRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/ads/${adId}`);
        const adE = asEntity(adRaw);
        if (!adE.id) return err("Error: Resource not found. Double-check the ad ID.");
        ad = { id: String(adE.id), enabled: adE.enabled as boolean | undefined, archived: adE.archived as boolean | undefined, creativeId: adE.creativeId as string | undefined, params: adE.params as Ad["params"], exceptParams: adE.exceptParams as Ad["exceptParams"], adGroupId: adE.adGroupId as string | undefined };
        groupId = ad.adGroupId;
        if (!groupId) return err("Error: that ad has no ad group.");
      }
      const agRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/ad-groups/${groupId}`);
      const agE = asEntity(agRaw);
      if (!agE.id) return err("Error: Resource not found. Double-check the ad group ID.");
      const adGroup: AdGroup = { id: String(agE.id), name: agE.name as string | undefined, archived: agE.archived as boolean | undefined, params: agE.params as AdGroup["params"], exceptParams: agE.exceptParams as AdGroup["exceptParams"], creativeAssetGroupId: agE.creativeAssetGroupId as string | undefined };

      // Group-level verdict first; ad-level params only narrow WHICH ads serve within it.
      const verdict = eligibility({ adGroup, zone: zoneLite, ads: [] });
      // With an adId, evaluate the OFFER grain on top: scoped_via at both levels and
      // whether this pair is a free radical (serves via the shared CAG alone).
      const offer = ad ? offerEligibility(verdict, adGroup, ad, zoneLite) : undefined;
      const reasons = offer ? offer.reasons : verdict.reasons;
      const eligible = offer ? offer.serves : verdict.eligible;

      const subject = ad ? `ad ${ad.id}` : `ad group ${adGroup.name ?? adGroup.id} (${adGroup.id})`;
      const path = offer ? offer.scoped_via.join(", ") : verdict.via.join(", ");
      const header = eligible
        ? `${subject} IS eligible in zone ${zoneLite.name} (${zoneLite.id}) — via ${path}${offer?.freeRadical ? " (free radical: shared CAG only)" : ""}`
        : `${subject} is NOT eligible in zone ${zoneLite.name} (${zoneLite.id}) — ${reasons.join(", ")}`;
      return pack(header, {
        zone: zoneLite,
        subject: ad ? { adId: ad.id, adGroupId: adGroup.id } : { adGroupId: adGroup.id },
        ...verdict, eligible, reasons,
        ...(offer ? { offer: { scoped_via: offer.scoped_via, freeRadical: offer.freeRadical, conflicts: offer.conflicts } } : {}),
      }, {});
    } catch (e) { return err(handleWorkApiError(e)); }
  });
}
