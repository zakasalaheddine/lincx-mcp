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
  via: string[];       // 'ad-group-whitelist' | 'ad-level-whitelist' | 'zone-selection'
  excluded: boolean;   // blacklisted via exceptParams
  reasons: string[];   // 'blacklisted' | 'cag-mismatch' | 'targets-other-zones'
  conflicts: string[]; // 'targets-and-excepts' | 'whitelisted-cag-mismatch'
};

const has = (arr: string[] | undefined, v: string): boolean =>
  Array.isArray(arr) && arr.includes(v);

/**
 * Eligible = CAG match AND not blacklisted AND in scope, where in scope is one
 * of: the group whitelists the zone, an ad whitelists it, or the group targets
 * ZERO zones (open within its CAG → "free radical"). exceptParams.zoneId is a
 * blacklist (the opposite of params) and always wins.
 */
export function eligibility({ adGroup, zone, ads }: EligibilityInput): Eligibility {
  const zoneId = zone.id;
  const cagMatch = zone.creativeAssetGroupId !== undefined
    && adGroup.creativeAssetGroupId === zone.creativeAssetGroupId;
  const inParams = has(adGroup.params?.zoneId, zoneId);
  const inExcept = has(adGroup.exceptParams?.zoneId, zoneId);
  const adLevelWhitelist = ads.some((a) => has(a.params?.zoneId, zoneId));
  const targetsZeroZones = (adGroup.params?.zoneId?.length ?? 0) === 0;

  const via: string[] = [];
  if (inParams) via.push("ad-group-whitelist");
  if (adLevelWhitelist) via.push("ad-level-whitelist");
  if (cagMatch) via.push("zone-selection");

  const conflicts: string[] = [];
  if (inParams && inExcept) conflicts.push("targets-and-excepts");
  if (inParams && !cagMatch) conflicts.push("whitelisted-cag-mismatch");

  const reasons: string[] = [];
  let eligible = false;
  if (inExcept) {
    reasons.push("blacklisted");
  } else if (!cagMatch) {
    reasons.push("cag-mismatch");
  } else if (inParams || adLevelWhitelist || targetsZeroZones) {
    eligible = true;
  } else {
    reasons.push("targets-other-zones");
  }

  return { adGroupId: adGroup.id, zoneId, eligible, via, excluded: inExcept, reasons, conflicts };
}

const whitelisted = (e: Eligibility): boolean =>
  e.via.includes("ad-group-whitelist") || e.via.includes("ad-level-whitelist");

/** zone → the eligible ad groups, split into those directly whitelisted and the
 * free radicals (eligible via shared CAG only, no whitelist). */
export function zoneEligibility(
  adGroups: AdGroup[],
  zone: { id: string; creativeAssetGroupId?: string },
  adsByGroup: Record<string, Ad[]>,
): { directlyTargeted: Eligibility[]; freeRadicals: Eligibility[] } {
  const directlyTargeted: Eligibility[] = [];
  const freeRadicals: Eligibility[] = [];
  for (const adGroup of adGroups) {
    const e = eligibility({ adGroup, zone, ads: adsByGroup[adGroup.id] ?? [] });
    if (!e.eligible) continue;
    (whitelisted(e) ? directlyTargeted : freeRadicals).push(e);
  }
  return { directlyTargeted, freeRadicals };
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
