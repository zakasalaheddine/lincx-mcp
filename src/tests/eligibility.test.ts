import { describe, it, expect } from "vitest";
import {
  eligibility, adServesInZone, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  type EligibilityInput, type OfferRollup,
} from "../tools/eligibility.js";
import { summarizeEligibility, type EnrichedRow } from "../tools/zoneEligibilityTools.js";
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

describe("offerEligibility (ad group × ad grain)", () => {
  const untargeted: AdGroup = { id: "ag", creativeAssetGroupId: CAG, params: {} };
  const verdict = (adGroup: AdGroup) => eligibility({ adGroup, zone, ads: [] });

  it("untargeted ad under an untargeted group → free radical (serves via shared CAG only)", () => {
    const o = offerEligibility(verdict(untargeted), untargeted, { id: "ad1" }, zone);
    expect(o.serves).toBe(true);
    expect(o.freeRadical).toBe(true);
    expect(o.scoped_via).toEqual(["zone-selection"]);
  });

  it("zone-whitelisted ad under an untargeted group → ad-level-TARGETED, NOT a free radical", () => {
    const ad: Ad = { id: "ad1", params: { zoneId: [ZONE] } };
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone);
    expect(o.serves).toBe(true);
    expect(o.freeRadical).toBe(false);
    expect(o.scoped_via).toEqual(["ad-level-whitelist", "zone-selection"]);
  });

  it("ad-level blacklist excludes the offer even under an eligible untargeted group", () => {
    const ad: Ad = { id: "ad1", exceptParams: { zoneId: [ZONE] } };
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone);
    expect(o.serves).toBe(false);
    expect(o.freeRadical).toBe(false);
    expect(o.scoped_via).toContain("ad-level-blacklist");
    expect(o.reasons).toContain("ad-blacklisted");
  });

  it("ad confined to other zones → does not serve, not a free radical", () => {
    const ad: Ad = { id: "ad1", params: { zoneId: ["other"] } };
    const o = offerEligibility(verdict(untargeted), untargeted, ad, zone);
    expect(o.serves).toBe(false);
    expect(o.reasons).toContain("ad-targets-other-zones");
  });

  it("group ineligible → no offer serves, even if the ad whitelists the zone (filterAdgroups runs first)", () => {
    const scopedOut: AdGroup = { id: "ag", creativeAssetGroupId: CAG, params: { zoneId: ["other"] } };
    const o = offerEligibility(verdict(scopedOut), scopedOut, { id: "ad1", params: { zoneId: [ZONE] } }, zone);
    expect(o.serves).toBe(false);
    expect(o.reasons).toEqual(["targets-other-zones"]);
  });

  it("offer under a directly-targeted group is never a free radical", () => {
    const direct: AdGroup = { id: "ag", creativeAssetGroupId: CAG, params: { zoneId: [ZONE] } };
    const o = offerEligibility(verdict(direct), direct, { id: "ad1" }, zone);
    expect(o.serves).toBe(true);
    expect(o.freeRadical).toBe(false);
    expect(o.scoped_via).toEqual(["ad-group-whitelist", "zone-selection"]);
  });
});

describe("offerRollup (the over-count the group grain hides)", () => {
  const untargeted: AdGroup = { id: "ag", creativeAssetGroupId: CAG, params: {} };
  const v = eligibility({ adGroup: untargeted, zone, ads: [] });

  it("untargeted group whose ONLY ad is zone-whitelisted → free-radical GROUP but 0 free-radical offers", () => {
    const r = offerRollup(v, untargeted, [{ id: "ad1", params: { zoneId: [ZONE] } }], zone);
    expect(v.eligible).toBe(true); // group grain still counts it
    expect(r.freeRadical).toBe(0);
    expect(r.adLevelTargeted).toBe(1);
    expect(r.serving).toBe(1);
    expect(r.freeRadicalAdIds).toEqual([]);
  });

  it("mixed group: counts each offer at its own grain", () => {
    const ads: Ad[] = [
      { id: "free1" },                                   // free radical
      { id: "free2" },                                   // free radical
      { id: "wl", params: { zoneId: [ZONE] } },          // ad-level targeted
      { id: "bl", exceptParams: { zoneId: [ZONE] } },    // ad-level blacklisted
      { id: "elsewhere", params: { zoneId: ["other"] } },// confined elsewhere
    ];
    const r = offerRollup(v, untargeted, ads, zone);
    expect(r.total).toBe(5);
    expect(r.serving).toBe(3);
    expect(r.freeRadical).toBe(2);
    expect(r.freeRadicalAdIds).toEqual(["free1", "free2"]);
    expect(r.adLevelTargeted).toBe(1);
    expect(r.adLevelBlacklisted).toBe(1);
    expect(r.confinedElsewhere).toBe(1);
  });
});

describe("summarizeEligibility (bucket grain in the tool summary)", () => {
  const rollup = (o: Partial<OfferRollup>): OfferRollup => ({
    total: 0, serving: 0, freeRadical: 0, adLevelTargeted: 0, adLevelBlacklisted: 0,
    confinedElsewhere: 0, freeRadicalAdIds: [], ...o,
  });
  const row = (id: string, offers: Partial<OfferRollup>, over: Partial<EnrichedRow> = {}): EnrichedRow => ({
    id, name: id, archived: false, campaign_on: true, adgroup_on: true, has_enabled_ad: true,
    creative_resolves: true, has_live_viable_ad: true, fully_live: true, off_reason: [], scoped_via: [],
    eligible: true, via: [], reasons: [], conflicts: [], offers: rollup(offers), ...over,
  });

  it("free-radical offers come from the free-radical bucket only; ad-level totals span both serving buckets", () => {
    const direct = [row("d1", { adLevelTargeted: 2, adLevelBlacklisted: 1, freeRadical: 99 })]; // freeRadical impossible here
    const radicals = [row("r1", { freeRadical: 3, adLevelTargeted: 1 }), row("r2", { freeRadical: 0 })];
    const conflict = [row("c1", { adLevelTargeted: 7 }, { eligible: false, fully_live: false })];
    const s = summarizeEligibility(direct, radicals, conflict);
    expect(s.freeRadicalOffers).toBe(3);
    expect(s.adLevelTargetedOffers).toBe(3);   // 2 direct + 1 radical, conflicting excluded
    expect(s.adLevelBlacklistedOffers).toBe(1);
    expect(s.freeRadicalGroups).toBe(2);       // group grain still counts r2
    expect(s.directlyTargeted).toBe(1);
    expect(s.conflicting).toBe(1);
  });

  it("config-broken targeted groups stay counted in directlyTargeted and are flagged ineligible", () => {
    const direct = [row("ok", {}), row("broken", {}, { eligible: false, fully_live: false })];
    const s = summarizeEligibility(direct, [], []);
    expect(s.directlyTargeted).toBe(2);
    expect(s.directlyTargetedIneligible).toBe(1);
    expect(s.directlyTargetedLive).toBe(1);
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
