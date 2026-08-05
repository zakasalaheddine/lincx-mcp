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
  conflicts: string[];   // 'inert-ad-level-whitelist'
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

  // An ad-level whitelist naming a zone its GROUP cannot reach never fires —
  // filterAdgroups() drops the group before filterAds() is consulted. The config
  // reads as "this ad is targeted here" and does nothing. Field-found on Adnet:
  // 18 ads across 8 groups, 6 of them live, where a Facebook-zone carve-out was
  // rolled out on the ads but the parent group was never scoped to that zone.
  const conflicts: string[] = [];
  if (scoped_via.includes("ad-level-whitelist") && !group.eligible) {
    conflicts.push("inert-ad-level-whitelist");
  }

  return { adGroupId: adGroup.id, adId: ad.id ?? "", zoneId, serves, scoped_via, freeRadical, reasons, conflicts };
}

export type OfferRollup = {
  total: number;             // ads in the group
  inScope: number;           // TARGETING only: group eligible AND the ad is neither
                             // blacklisted nor confined elsewhere. Says nothing about
                             // on/off state — was `serving`, which read as live exposure.
  live: number;              // inScope AND the whole chain is on (campaign, ad group,
                             // ad, viable creative) — what actually renders today
  freeRadical: number;       // in scope via shared CAG only (the config-grain leak count)
  freeRadicalLive: number;   // …of those, the ones live right now. freeRadical > 0 with
                             // freeRadicalLive === 0 is a standing trap: one toggle away
                             // from leaking (e.g. held out only by campaign state)
  adLevelTargeted: number;   // ad's own params.zoneId names the zone
  adLevelBlacklisted: number;// ad's own exceptParams.zoneId excludes the zone
  confinedElsewhere: number; // ad whitelists only OTHER zones
  inertWhitelisted: number;  // ad whitelists THIS zone but its group can't reach it — dead config
  freeRadicalAdIds: string[];
  inertWhitelistedAdIds: string[];
};

/**
 * Per-group offer-grain counts, so a pure free-radical subset is derivable.
 *
 * `isLive(ad)` is injected rather than derived here: liveness needs the campaign
 * and creative rows, which this module deliberately never reads (it stays pure and
 * network-agnostic). Callers pass `campaign_on && adgroup_on && adLiveViable(ad,
 * creatives)`. Required, not defaulted — a default would make a wrong count look
 * like a passing assertion.
 */
export function offerRollup(
  group: Eligibility,
  adGroup: AdGroup,
  ads: Ad[],
  zone: { id: string; creativeAssetGroupId?: string },
  isLive: (ad: Ad) => boolean,
): OfferRollup {
  const offers = ads.map((ad) => ({ ...offerEligibility(group, adGroup, ad, zone), live: isLive(ad) }));
  const freeRadicals = offers.filter((o) => o.freeRadical);
  const inert = offers.filter((o) => o.conflicts.includes("inert-ad-level-whitelist"));
  return {
    total: offers.length,
    inScope: offers.filter((o) => o.serves).length,
    live: offers.filter((o) => o.serves && o.live).length,
    freeRadical: freeRadicals.length,
    freeRadicalLive: freeRadicals.filter((o) => o.live).length,
    adLevelTargeted: offers.filter((o) => o.scoped_via.includes("ad-level-whitelist")).length,
    adLevelBlacklisted: offers.filter((o) => o.scoped_via.includes("ad-level-blacklist")).length,
    confinedElsewhere: offers.filter((o) => o.reasons.includes("ad-targets-other-zones")).length,
    inertWhitelisted: inert.length,
    freeRadicalAdIds: freeRadicals.map((o) => o.adId).filter(Boolean),
    inertWhitelistedAdIds: inert.map((o) => o.adId).filter(Boolean),
  };
}

/**
 * zone → its ad groups bucketed by how they are scoped (NOT by eligibility):
 * - `directlyTargeted` — ad-group-whitelisted and not blacklisted (= the inventory
 *   tool's targeted set; reconciles to it). Kept even when NOT eligible (e.g. CAG
 *   mismatch) so config problems surface via each row's `conflicts`/`reasons`
 *   instead of silently vanishing.
 * - `freeRadicals` — eligible but not ad-group-whitelisted (leaks in via shared CAG).
 *   HOST grain: the free radical is the OFFER, the group only hosts it, so a row here
 *   can hold zero free-radical OFFERS (e.g. its only ad is zone-whitelisted → that ad
 *   renders because it is ad-level-targeted, not via the CAG). Use `offerRollup` for
 *   the offer-grain count, incl. `freeRadicalLive` (a dormant host leaks nothing).
 * - `conflicting` — ad-group-whitelisted AND blacklisted (targets+excepts the zone).
 * - `inertWhitelists` — NOT in scope for the zone, yet one of its ads whitelists the
 *   zone. Nothing here serves; it is a pure config-defect bucket. Without it these
 *   groups are dropped, and a dead ad-level whitelist is undiscoverable — the config
 *   reads as "targeted here" in the UI and does nothing.
 * Groups that neither touch the zone nor hold an inert whitelist are dropped.
 *
 * The reconciliation invariant is untouched: `inertWhitelists` groups are, by
 * construction, neither ad-group-whitelisted nor eligible, so they cannot appear in
 * `directlyTargeted` or `conflicting`.
 */
export function zoneEligibility(
  adGroups: AdGroup[],
  zone: { id: string; creativeAssetGroupId?: string },
  adsByGroup: Record<string, Ad[]>,
): { directlyTargeted: Eligibility[]; freeRadicals: Eligibility[]; conflicting: Eligibility[]; inertWhitelists: Eligibility[] } {
  const directlyTargeted: Eligibility[] = [];
  const freeRadicals: Eligibility[] = [];
  const conflicting: Eligibility[] = [];
  const inertWhitelists: Eligibility[] = [];
  for (const adGroup of adGroups) {
    const ads = adsByGroup[adGroup.id] ?? [];
    const e = eligibility({ adGroup, zone, ads });
    const agWhitelist = e.via.includes("ad-group-whitelist");
    if (agWhitelist && e.excluded) conflicting.push(e);
    else if (agWhitelist) directlyTargeted.push(e);
    else if (e.eligible) freeRadicals.push(e);
    else if (ads.some((ad) => has(ad.params?.zoneId, zone.id))) {
      inertWhitelists.push({ ...e, conflicts: [...e.conflicts, "inert-ad-level-whitelist"] });
    }
  }
  return { directlyTargeted, freeRadicals, conflicting, inertWhitelists };
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
