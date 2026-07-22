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
  asRows, asEntity, rollupZoneTargeting,
  type AdGroup, type Ad, type Campaign, type Creative, type Row,
} from "./zoneInventoryTools.js";
import { eligibility, zoneEligibility, adGroupReach, type Eligibility } from "./eligibility.js";

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
    (adsByGroup[a.adGroupId] ??= []).push({ id: a.id, enabled: a.enabled, archived: a.archived, creativeId: a.creativeId, params: a.params });
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
 * (never the exact summary counts) if a pathological set overflows the guard. */
function pack(header: string, payload: Record<string, unknown>, rowKeys: string[]): TextResult {
  const render = (p: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: `${header}\n\n${JSON.stringify(p)}` }] });
  const full = render(payload);
  if (JSON.stringify(full).length <= RESPONSE_SIZE_LIMIT) return full;
  // Overflow: replace each row array with its ids + a truncated flag. Summary stays exact.
  const shed: Record<string, unknown> = { ...payload, truncated: true };
  for (const k of rowKeys) {
    const rows = payload[k];
    if (Array.isArray(rows)) shed[k] = rows.map((r) => (r as { id?: string; adGroupId?: string; zoneId?: string }).id ?? (r as { adGroupId?: string }).adGroupId ?? (r as { zoneId?: string }).zoneId);
  }
  return render(shed);
}

/** Merge each eligible group's live rollup row with its join verdict (via/conflicts). */
function enrich(elig: Eligibility[], idx: Index, zoneId: string, zoneCag?: string): (Row & { via: string[]; conflicts: string[] })[] {
  const byId = new Map(elig.map((e) => [e.adGroupId, e]));
  const groups = idx.adGroups.filter((g) => byId.has(g.id));
  const { groups: rows } = rollupZoneTargeting({
    zoneId, zoneCag, targeted: groups, conflicting: [],
    campaigns: idx.campaigns, adsByGroup: idx.adsByGroup, creatives: idx.creatives, mode: "all",
  });
  return rows.map((r) => {
    const e = byId.get(r.id)!;
    return { ...r, via: e.via, conflicts: e.conflicts };
  });
}

export function registerZoneEligibilityTools(server: McpServer): void {
  // 1) zone → eligible ad groups (directly targeted + free radicals)
  server.registerTool("get_zone_eligible_ad_groups", {
    title: "Zone Eligible Ad Groups",
    description: `List every ad group ELIGIBLE to serve in a zone — not just the ones directly targeted. An ad group is eligible when its creativeAssetGroupId matches the zone's, it is not blacklisted (zone in its exceptParams.zoneId), and it is in scope: whitelisted (the group's or an ad's params.zoneId names the zone) OR it targets ZERO zones (open within its CAG). Results split into 'directlyTargeted' (whitelisted) and 'freeRadicals' (eligible via the shared CAG only — they leak in despite no direct targeting). Each row carries the same live rollup as get_zone_targeting_inventory (campaign_on, adgroup_on, has_live_viable_ad, fully_live, off_reason[], scoped_via[]) plus via[] and any conflicts[]. Whole-network scan server-side; only the compact result is returned in the content text (header + compact JSON).`,
    inputSchema: z.object({ zoneId: z.string().describe("Zone ID to list eligible ad groups for") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ zoneId }, extra) => {
    const g = await guard(extra);
    if (!g.ok) return g.result;
    try {
      const zoneRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/zones/${zoneId}`);
      const zone = asEntity(zoneRaw);
      if (!zone.id) return err("Error: Resource not found. Double-check the zone ID.");
      const idx = await fetchIndex(g.session!);
      const zoneLite: ZoneLite = { id: String(zone.id), name: String(zone.name ?? zone.id), creativeAssetGroupId: zone.creativeAssetGroupId as string | undefined, templateId: zone.templateId as string | undefined };

      const { directlyTargeted, freeRadicals } = zoneEligibility(idx.adGroups, zoneLite, idx.adsByGroup);
      const direct = enrich(directlyTargeted, idx, zoneLite.id, zoneLite.creativeAssetGroupId);
      const radicals = enrich(freeRadicals, idx, zoneLite.id, zoneLite.creativeAssetGroupId);

      const summary = {
        eligible: direct.length + radicals.length,
        directlyTargeted: direct.length, directlyTargetedLive: direct.filter((r) => r.fully_live).length,
        freeRadicals: radicals.length, freeRadicalsLive: radicals.filter((r) => r.fully_live).length,
      };
      const header = `Zone ${zoneLite.name} (${zoneLite.id}) — ${summary.eligible} eligible · ${summary.directlyTargeted} targeted (${summary.directlyTargetedLive} live) · ${summary.freeRadicals} free radicals (${summary.freeRadicalsLive} live)`;
      return pack(header, { zone: zoneLite, summary, directlyTargeted: direct, freeRadicals: radicals, scan: idx.scan }, ["directlyTargeted", "freeRadicals"]);
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
        id: String(agE.id), name: agE.name as string | undefined,
        params: agE.params as AdGroup["params"], exceptParams: agE.exceptParams as AdGroup["exceptParams"],
        creativeAssetGroupId: agE.creativeAssetGroupId as string | undefined,
      };
      const idx = await fetchIndex(g.session!);
      const ads = idx.adsByGroup[adGroup.id] ?? [];
      const reach = adGroupReach(adGroup, idx.zones, ads);
      const named = reach.map((e) => ({ ...e, zoneName: idx.zones.find((z) => z.id === e.zoneId)?.name ?? e.zoneId }));
      const direct = named.filter((e) => e.via.includes("ad-group-whitelist") || e.via.includes("ad-level-whitelist")).length;
      const header = `Ad group ${adGroup.name ?? adGroup.id} (${adGroup.id}) reaches ${reach.length} zones — ${direct} targeted · ${reach.length - direct} via shared CAG (free radical)`;
      return pack(header, { adGroup: { id: adGroup.id, name: adGroup.name, creativeAssetGroupId: adGroup.creativeAssetGroupId }, summary: { reaches: reach.length, targeted: direct, freeRadical: reach.length - direct }, zones: named, scan: idx.scan }, ["zones"]);
    } catch (e) { return err(handleWorkApiError(e)); }
  });

  // 3) (zone, adGroup|ad) pair → why did/​didn't X serve here
  server.registerTool("explain_serve", {
    title: "Explain Serve",
    description: `Explain, for a single (zone, ad group OR ad) pair, whether it is eligible to serve in the zone, by what path (via[]), and if not, why not (reasons[]) — the "why did X serve in this zone?" direction of the eligibility join. Pass exactly one of adGroupId or adId (an adId is resolved to its ad group; its own ad-level whitelist/blacklist for the zone is also reported). Returns the single eligibility verdict with any conflicts[]. Whole-network scan server-side.`,
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
      let adBlacklisted = false;
      let groupId = adGroupId;
      if (adId) {
        const adRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/ads/${adId}`);
        const adE = asEntity(adRaw);
        if (!adE.id) return err("Error: Resource not found. Double-check the ad ID.");
        ad = { id: String(adE.id), enabled: adE.enabled as boolean | undefined, archived: adE.archived as boolean | undefined, creativeId: adE.creativeId as string | undefined, params: adE.params as Ad["params"], adGroupId: adE.adGroupId as string | undefined };
        groupId = ad.adGroupId;
        if (!groupId) return err("Error: that ad has no ad group.");
        // ponytail: ad-level blacklist (zone in the ad's own exceptParams) isn't in the
        // core predicate — check it here for the single-ad case. Upgrade into eligibility()
        // if a bulk read ever needs per-ad blacklists.
        const adExceptZones = (adE.exceptParams as { zoneId?: string[] } | undefined)?.zoneId;
        adBlacklisted = Array.isArray(adExceptZones) && adExceptZones.includes(zoneLite.id);
      }
      const agRaw = await workApiRequest<unknown>(g.session!, "GET", `/api/ad-groups/${groupId}`);
      const agE = asEntity(agRaw);
      if (!agE.id) return err("Error: Resource not found. Double-check the ad group ID.");
      const adGroup: AdGroup = { id: String(agE.id), name: agE.name as string | undefined, params: agE.params as AdGroup["params"], exceptParams: agE.exceptParams as AdGroup["exceptParams"], creativeAssetGroupId: agE.creativeAssetGroupId as string | undefined };

      const idx = await fetchIndex(g.session!);
      // For an ad, judge only that ad; for a group, all its ads.
      const ads = ad ? [ad] : (idx.adsByGroup[adGroup.id] ?? []);
      const verdict = eligibility({ adGroup, zone: zoneLite, ads });
      const reasons = adBlacklisted ? [...verdict.reasons, "ad-blacklisted"] : verdict.reasons;
      const eligible = verdict.eligible && !adBlacklisted;

      const subject = ad ? `ad ${ad.id}` : `ad group ${adGroup.name ?? adGroup.id} (${adGroup.id})`;
      const header = eligible
        ? `${subject} IS eligible in zone ${zoneLite.name} (${zoneLite.id}) — via ${verdict.via.join(", ")}`
        : `${subject} is NOT eligible in zone ${zoneLite.name} (${zoneLite.id}) — ${reasons.join(", ")}`;
      return pack(header, { zone: zoneLite, subject: ad ? { adId: ad.id, adGroupId: adGroup.id } : { adGroupId: adGroup.id }, ...verdict, eligible, reasons }, []);
    } catch (e) { return err(handleWorkApiError(e)); }
  });
}
