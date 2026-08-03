/**
 * tools/eligibility.ts
 *
 * The general eligibility join: can an ad group serve in a zone, and by what
 * path? One pure predicate powers three read directions (zone→groups,
 * group→zones, serve-explain). Network-agnostic — it takes already-fetched rows
 * as arguments and never reads the active network, so a future team-vs-client /
 * multi-network access layer can feed it a different set per network without
 * touching the join.
 */

import type { AdGroup, Ad } from "./zoneInventoryTools.js";

export type EligibilityInput = {
  adGroup: AdGroup;
  zone: { id: string; creativeAssetGroupId?: string };
  ads: Ad[]; // ads belonging to adGroup
};

export type Eligibility = {
  adGroupId: string;
  zoneId: string;
  eligible: boolean;
  via: string[];       // 'ad-group-whitelist' | 'zone-selection'
  excluded: boolean;   // blacklisted via exceptParams
  reasons: string[];   // 'archived' | 'blacklisted' | 'cag-mismatch' | 'targets-other-zones'
  conflicts: string[]; // 'targets-and-excepts' | 'whitelisted-cag-mismatch'
};

const has = (arr: string[] | undefined, v: string): boolean =>
  Array.isArray(arr) && arr.includes(v);

/**
 * The single `scoped_via` domain — HOW a group/offer is scoped to a zone. Shared
 * by every tool that emits the field (the group-grain rollup in
 * zoneInventoryTools and the offer grain in `offerEligibility`) so a consumer
 * reading them together never sees the same field name over two different
 * enums. NOT the same field as `Eligibility.via`, which is the narrower
 * "why is this group eligible" path (whitelist / CAG) and stays as-is.
 */
export const SCOPED_VIA = [
  "ad-group-whitelist",
  "ad-group-blacklist",
  "ad-level-whitelist",
  "ad-level-blacklist",
  "zone-selection",
] as const;
export type ScopedVia = (typeof SCOPED_VIA)[number];

/**
 * GROUP-level eligibility: can this ad group serve ANY ad in this zone?
 * Eligible = not archived AND CAG match AND not blacklisted AND in scope, where
 * in scope = the group whitelists the zone OR targets ZERO zones (open within its
 * CAG → "free radical"). `exceptParams.zoneId` is a blacklist (the opposite of
 * params) and always wins. Ad-level params are NOT a group-scoping mechanism —
 * they only filter WHICH ads serve within an eligible group (see adServesInZone).
 */
export function eligibility({ adGroup, zone }: EligibilityInput): Eligibility {
  const zoneId = zone.id;
  const archived = adGroup.archived === true;
  const cagMatch = zone.creativeAssetGroupId !== undefined
    && adGroup.creativeAssetGroupId === zone.creativeAssetGroupId;
  const inParams = has(adGroup.params?.zoneId, zoneId);
  const inExcept = has(adGroup.exceptParams?.zoneId, zoneId);
  const targetsZeroZones = (adGroup.params?.zoneId?.length ?? 0) === 0;

  const via: string[] = [];
  if (inParams) via.push("ad-group-whitelist");
  if (cagMatch) via.push("zone-selection");

  const conflicts: string[] = [];
  if (inParams && inExcept) conflicts.push("targets-and-excepts");
  if (inParams && !cagMatch) conflicts.push("whitelisted-cag-mismatch");

  const reasons: string[] = [];
  let eligible = false;
  if (archived) {
    reasons.push("archived");
  } else if (inExcept) {
    reasons.push("blacklisted");
  } else if (!cagMatch) {
    reasons.push("cag-mismatch");
  } else if (inParams || targetsZeroZones) {
    eligible = true;
  } else {
    reasons.push("targets-other-zones");
  }

  return { adGroupId: adGroup.id, zoneId, eligible, via, excluded: inExcept, reasons, conflicts };
}

/**
 * Per-ad LAST targeting check, applied only within a group already eligible for
 * the zone: an ad serves in the zone unless its own `exceptParams.zoneId`
 * blacklists it there, or its own `params.zoneId` is a non-empty whitelist that
 * omits the zone (confining that ad to other zones). One blacklisted ad is hidden
 * while its siblings still serve.
 */
export function adServesInZone(ad: Ad, zoneId: string): boolean {
  if (has(ad.exceptParams?.zoneId, zoneId)) return false;
  const wl = ad.params?.zoneId;
  if (Array.isArray(wl) && wl.length > 0 && !wl.includes(zoneId)) return false;
  return true;
}

/**
 * OFFER grain: a single (ad group × ad) pair evaluated against a zone. The group
 * verdict decides whether the pair can be considered at all (filterAdgroups runs
 * first — an ad-level whitelist can never rescue an ineligible group); the ad's own
 * params/exceptParams are then the last check.
 */
export type Offer = {
  adGroupId: string;
  adId: string;
  zoneId: string;
  serves: boolean;       // group eligible AND this ad passes its own targeting
  scoped_via: ScopedVia[]; // shared SCOPED_VIA domain (same enum the group-grain rollup uses)
  freeRadical: boolean;  // serves via the shared CAG ONLY — no whitelist at either level
  reasons: string[];     // group reasons + 'ad-blacklisted' | 'ad-targets-other-zones'
};

/**
 * Evaluate one (ad group × ad) pair in a zone, on top of an already-computed group
 * verdict. A **free radical** at this grain is an untargeted ad under an untargeted
 * group, net of blacklists at BOTH levels — i.e. it renders solely via the shared
 * CAG. An ad whose own `params.zoneId` names the zone is ad-level-TARGETED, not a
 * free radical (counting it as one over-counts the CAG leak).
 */
export function offerEligibility(
  group: Eligibility,
  adGroup: AdGroup,
  ad: Ad,
  zone: { id: string; creativeAssetGroupId?: string },
): Offer {
  const zoneId = zone.id;
  const scoped_via: ScopedVia[] = [];
  if (has(adGroup.params?.zoneId, zoneId)) scoped_via.push("ad-group-whitelist");
  if (has(adGroup.exceptParams?.zoneId, zoneId)) scoped_via.push("ad-group-blacklist");
  if (has(ad.params?.zoneId, zoneId)) scoped_via.push("ad-level-whitelist");
  if (has(ad.exceptParams?.zoneId, zoneId)) scoped_via.push("ad-level-blacklist");
  if (zone.creativeAssetGroupId !== undefined && adGroup.creativeAssetGroupId === zone.creativeAssetGroupId) {
    scoped_via.push("zone-selection");
  }

  const reasons = [...group.reasons];
  let serves = group.eligible;
  if (serves && !adServesInZone(ad, zoneId)) {
    serves = false;
    reasons.push(has(ad.exceptParams?.zoneId, zoneId) ? "ad-blacklisted" : "ad-targets-other-zones");
  }

  const freeRadical = serves
    && !scoped_via.includes("ad-group-whitelist")
    && !scoped_via.includes("ad-level-whitelist");

  return { adGroupId: adGroup.id, adId: ad.id ?? "", zoneId, serves, scoped_via, freeRadical, reasons };
}

export type OfferRollup = {
  total: number;             // ads in the group
  serving: number;           // offers that actually serve in this zone
  freeRadical: number;       // serving via shared CAG only (the true leak count)
  adLevelTargeted: number;   // ad's own params.zoneId names the zone
  adLevelBlacklisted: number;// ad's own exceptParams.zoneId excludes the zone
  confinedElsewhere: number; // ad whitelists only OTHER zones
  freeRadicalAdIds: string[];
};

/** Per-group offer-grain counts, so a pure free-radical subset is derivable. */
export function offerRollup(
  group: Eligibility,
  adGroup: AdGroup,
  ads: Ad[],
  zone: { id: string; creativeAssetGroupId?: string },
): OfferRollup {
  const offers = ads.map((ad) => offerEligibility(group, adGroup, ad, zone));
  const freeRadicals = offers.filter((o) => o.freeRadical);
  return {
    total: offers.length,
    serving: offers.filter((o) => o.serves).length,
    freeRadical: freeRadicals.length,
    adLevelTargeted: offers.filter((o) => o.scoped_via.includes("ad-level-whitelist")).length,
    adLevelBlacklisted: offers.filter((o) => o.scoped_via.includes("ad-level-blacklist")).length,
    confinedElsewhere: offers.filter((o) => o.reasons.includes("ad-targets-other-zones")).length,
    freeRadicalAdIds: freeRadicals.map((o) => o.adId).filter(Boolean),
  };
}

/**
 * zone → its ad groups bucketed by how they are scoped (NOT by eligibility):
 * - `directlyTargeted` — ad-group-whitelisted and not blacklisted (= the inventory
 *   tool's targeted set; reconciles to it). Kept even when NOT eligible (e.g. CAG
 *   mismatch) so config problems surface via each row's `conflicts`/`reasons`
 *   instead of silently vanishing.
 * - `freeRadicals` — eligible but not ad-group-whitelisted (leaks in via shared CAG).
 *   GROUP grain: a group here can still hold zero free-radical OFFERS (e.g. its only
 *   ad is zone-whitelisted → that ad renders because it is ad-level-targeted, not via
 *   the CAG). Use `offerRollup` for the offer-grain count.
 * - `conflicting` — ad-group-whitelisted AND blacklisted (targets+excepts the zone).
 * Groups neither whitelisted nor eligible are dropped (they don't touch the zone).
 */
export function zoneEligibility(
  adGroups: AdGroup[],
  zone: { id: string; creativeAssetGroupId?: string },
  adsByGroup: Record<string, Ad[]>,
): { directlyTargeted: Eligibility[]; freeRadicals: Eligibility[]; conflicting: Eligibility[] } {
  const directlyTargeted: Eligibility[] = [];
  const freeRadicals: Eligibility[] = [];
  const conflicting: Eligibility[] = [];
  for (const adGroup of adGroups) {
    const e = eligibility({ adGroup, zone, ads: adsByGroup[adGroup.id] ?? [] });
    const agWhitelist = e.via.includes("ad-group-whitelist");
    if (agWhitelist && e.excluded) conflicting.push(e);
    else if (agWhitelist) directlyTargeted.push(e);
    else if (e.eligible) freeRadicals.push(e);
  }
  return { directlyTargeted, freeRadicals, conflicting };
}

/** group → every zone it can serve/leak into (the flip of zoneEligibility). */
export function adGroupReach(
  adGroup: AdGroup,
  zones: { id: string; creativeAssetGroupId?: string }[],
  ads: Ad[],
): Eligibility[] {
  return zones
    .map((zone) => eligibility({ adGroup, zone, ads }))
    .filter((e) => e.eligible);
}
