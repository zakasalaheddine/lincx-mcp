import { describe, it, expect } from "vitest";
import { eligibility, adServesInZone, zoneEligibility, adGroupReach, type EligibilityInput } from "../tools/eligibility.js";
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

  it("ad-level params do NOT decide group eligibility (per-ad is a later check): an ad whitelisting the zone can't make a group that targets other zones eligible", () => {
    const e = eligibility(input({ params: { zoneId: ["other"] } }, [{ id: "ad1", params: { zoneId: [ZONE] } }]));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["targets-other-zones"]);
    expect(e.via).toEqual(["zone-selection"]); // no ad-level-whitelist in group via
  });

  it("archived ad group is never eligible (out of service), even if whitelisted + CAG match", () => {
    const e = eligibility(input({ params: { zoneId: [ZONE] }, archived: true }));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["archived"]);
  });

  it("free radical only within its CAG: zero zones but CAG mismatch → not eligible", () => {
    const e = eligibility(input({ params: {}, creativeAssetGroupId: "other" }));
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["cag-mismatch"]);
    expect(e.via).toEqual([]);
  });
});

describe("adServesInZone (per-ad last targeting check)", () => {
  it("ad with no params serves wherever its group is eligible", () => {
    expect(adServesInZone({ id: "a" }, ZONE)).toBe(true);
  });
  it("ad blacklisting the zone does not serve there (its siblings still do)", () => {
    expect(adServesInZone({ id: "a", exceptParams: { zoneId: [ZONE] } }, ZONE)).toBe(false);
  });
  it("ad whitelisting only other zones is confined there → does not serve here", () => {
    expect(adServesInZone({ id: "a", params: { zoneId: ["other"] } }, ZONE)).toBe(false);
  });
  it("ad whitelisting this zone serves here", () => {
    expect(adServesInZone({ id: "a", params: { zoneId: [ZONE] } }, ZONE)).toBe(true);
  });
});

describe("zoneEligibility (zone → groups, bucketed by scoping)", () => {
  const groups: AdGroup[] = [
    { id: "direct", creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } },   // whitelisted, eligible
    { id: "radical", creativeAssetGroupId: CAG, params: {} },                   // free radical
    { id: "other", creativeAssetGroupId: CAG, params: { zoneId: ["z9"] } },     // scoped out → dropped
    { id: "wrongcag", creativeAssetGroupId: "x", params: {} },                  // not eligible → dropped
    { id: "cagmiss", creativeAssetGroupId: "x", params: { zoneId: [ZONE] } },   // whitelisted but CAG mismatch
    { id: "both", creativeAssetGroupId: CAG, params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, // targets+excepts
  ];

  it("directlyTargeted = ad-group-whitelisted & not blacklisted (reconciles to the inventory 83), incl. CAG-mismatch", () => {
    const r = zoneEligibility(groups, zone, {});
    expect(r.directlyTargeted.map((e) => e.adGroupId).sort()).toEqual(["cagmiss", "direct"]);
  });
  it("keeps a whitelisted-but-ineligible group in directlyTargeted with its conflict surfaced (no silent drop)", () => {
    const r = zoneEligibility(groups, zone, {});
    const cm = r.directlyTargeted.find((e) => e.adGroupId === "cagmiss")!;
    expect(cm.eligible).toBe(false);
    expect(cm.conflicts).toEqual(["whitelisted-cag-mismatch"]);
  });
  it("freeRadicals = eligible but not ad-group-whitelisted", () => {
    const r = zoneEligibility(groups, zone, {});
    expect(r.freeRadicals.map((e) => e.adGroupId)).toEqual(["radical"]);
  });
  it("targets-and-excepts goes to conflicting, not directlyTargeted", () => {
    const r = zoneEligibility(groups, zone, {});
    expect(r.conflicting.map((e) => e.adGroupId)).toEqual(["both"]);
    expect(r.conflicting[0].conflicts).toContain("targets-and-excepts");
    expect(r.directlyTargeted.map((e) => e.adGroupId)).not.toContain("both");
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
