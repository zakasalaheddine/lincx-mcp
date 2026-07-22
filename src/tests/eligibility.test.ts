import { describe, it, expect } from "vitest";
import { eligibility, zoneEligibility, adGroupReach, type EligibilityInput } from "../tools/eligibility.js";
import type { AdGroup, Ad } from "../tools/zoneInventoryTools.js";

const ZONE = "8z7wzb";
const CAG = "0bckt2";
const zone = { id: ZONE, creativeAssetGroupId: CAG };

const input = (adGroup: Partial<AdGroup>, ads: Ad[] = []): EligibilityInput => ({
  adGroup: { id: "ag1", creativeAssetGroupId: CAG, ...adGroup },
  zone,
  ads,
});

describe("eligibility", () => {
  it("free radical: targets zero zones + CAG match → eligible via zone-selection only", () => {
    const e = eligibility(input({ params: {} }));
    expect(e.eligible).toBe(true);
    expect(e.via).toEqual(["zone-selection"]);
    expect(e.excluded).toBe(false);
    expect(e.reasons).toEqual([]);
    expect(e.conflicts).toEqual([]);
  });

  it("directly whitelisted + CAG match → eligible, via ad-group-whitelist + zone-selection", () => {
    const e = eligibility(input({ params: { zoneId: [ZONE] } }));
    expect(e.eligible).toBe(true);
    expect(e.via).toEqual(["ad-group-whitelist", "zone-selection"]);
  });

  it("targets a DIFFERENT zone (same CAG) → not eligible, targets-other-zones", () => {
    const e = eligibility(input({ params: { zoneId: ["other1", "other2"] } }));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["targets-other-zones"]);
    expect(e.via).toEqual(["zone-selection"]); // CAG still matches, just not scoped in
  });

  it("blacklist wins: zone in exceptParams → excluded even with a whitelist", () => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }));
    expect(e.eligible).toBe(false);
    expect(e.excluded).toBe(true);
    expect(e.reasons).toContain("blacklisted");
    expect(e.conflicts).toContain("targets-and-excepts");
  });

  it("CAG mismatch with a whitelist → not eligible, cag-mismatch + whitelisted-cag-mismatch conflict", () => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, creativeAssetGroupId: "other" }));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain("cag-mismatch");
    expect(e.conflicts).toEqual(["whitelisted-cag-mismatch"]);
  });

  it("ad-level whitelist: group targets zero zones, an ad names the zone → via includes ad-level-whitelist", () => {
    const e = eligibility(input({ params: {} }, [{ id: "ad1", params: { zoneId: [ZONE] } }]));
    expect(e.eligible).toBe(true);
    expect(e.via).toEqual(["ad-level-whitelist", "zone-selection"]);
  });

  it("free radical only within its CAG: zero zones but CAG mismatch → not eligible", () => {
    const e = eligibility(input({ params: {}, creativeAssetGroupId: "other" }));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["cag-mismatch"]);
    expect(e.via).toEqual([]);
  });
});

describe("zoneEligibility (zone → eligible groups, split)", () => {
  const groups: AdGroup[] = [
    { id: "direct", creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } },   // directly targeted
    { id: "radical", creativeAssetGroupId: CAG, params: {} },                   // free radical
    { id: "other", creativeAssetGroupId: CAG, params: { zoneId: ["z9"] } },     // scoped out
    { id: "wrongcag", creativeAssetGroupId: "x", params: {} },                  // not eligible
    { id: "blocked", creativeAssetGroupId: CAG, params: {}, exceptParams: { zoneId: [ZONE] } }, // blacklisted
  ];

  it("splits directlyTargeted vs freeRadicals and drops the ineligible", () => {
    const r = zoneEligibility(groups, zone, {});
    expect(r.directlyTargeted.map((e) => e.adGroupId)).toEqual(["direct"]);
    expect(r.freeRadicals.map((e) => e.adGroupId)).toEqual(["radical"]);
  });
});

describe("adGroupReach (group → zones it can serve/leak into)", () => {
  const zones = [
    { id: "za", creativeAssetGroupId: CAG },
    { id: "zb", creativeAssetGroupId: CAG },
    { id: "zc", creativeAssetGroupId: "other" },
  ];

  it("a free-radical group reaches every zone sharing its CAG", () => {
    const r = adGroupReach({ id: "ag", creativeAssetGroupId: CAG, params: {} }, zones, []);
    expect(r.map((e) => e.zoneId)).toEqual(["za", "zb"]);
    expect(r.every((e) => e.via.includes("zone-selection"))).toBe(true);
  });

  it("a whitelisted group reaches only the zone it targets", () => {
    const r = adGroupReach({ id: "ag", creativeAssetGroupId: CAG, params: { zoneId: ["zb"] } }, zones, []);
    expect(r.map((e) => e.zoneId)).toEqual(["zb"]);
  });
});
