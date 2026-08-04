import { describe, it, expect } from "vitest";
import {
  eligibility, adServesInZone, zoneEligibility, adGroupReach, offerEligibility, offerRollup,
  SCOPED_VIA,
  type EligibilityInput, type OfferRollup,
} from "../tools/eligibility.js";
import { rollupZoneTargeting, selectTargeting } from "../tools/zoneInventoryTools.js";
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

  /**
   * The A1 reconciliation with `conflicting` NON-EMPTY — the case production data
   * cannot reach (an exhaustive 1150-group sweep of network 7jdz0n on 2026-08-04
   * found no ad group naming the same zone in params.zoneId and exceptParams.zoneId).
   *
   * Note the exact identity: the two tools bucket a conflicting group the SAME way,
   * so it is in NEITHER tool's targeted set. `directlyTargeted + conflicting ==
   * inventory groups[]` therefore only holds while conflicting is 0 — the honest
   * invariant is per-bucket set equality.
   */
  it("A1 — the two tools agree bucket-for-bucket when conflicting is non-empty", () => {
    const { targeted, conflicting } = selectTargeting(groups, ZONE);
    const r = zoneEligibility(groups, zone, {});

    const ids = (xs: { id?: string; adGroupId?: string }[]) =>
      xs.map((x) => x.id ?? x.adGroupId).sort();

    expect(ids(r.directlyTargeted)).toEqual(ids(targeted));       // same targeted set
    expect(ids(r.conflicting)).toEqual(ids(conflicting));         // same conflicting set
    expect(r.conflicting.length).toBeGreaterThan(0);              // the case prod can't reach
    // Disjoint: a group is never in both buckets.
    expect(ids(r.directlyTargeted).filter((id) => ids(r.conflicting).includes(id))).toEqual([]);
    // And the sum identity as usually stated holds only because the inventory tool
    // reports conflicting separately from groups[] — assert both halves, not the sum.
    expect(r.directlyTargeted.length + r.conflicting.length).toBe(targeted.length + conflicting.length);
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

/**
 * D3 from the 2026-08-03 contract review: an untargeted ad group whose ads are ALL
 * zone-whitelisted yields 0 free-radical OFFERS while still appearing as a host row.
 * The live network had no such config, so the behaviour is pinned here instead.
 * Fixture recipe for a live run: untargeted group (params {}) on the zone's CAG,
 * holding ≥1 untargeted ad and ≥1 ad whose params.zoneId names the zone.
 */
describe("D3 — the host row survives, the offer count does not", () => {
  const untargeted: AdGroup = { id: "host", name: "host", creativeAssetGroupId: CAG, params: {} };
  const allWhitelisted: Ad[] = [
    { id: "wl1", params: { zoneId: [ZONE] } },
    { id: "wl2", params: { zoneId: [ZONE] } },
    { id: "wl3", params: { zoneId: [ZONE, "other"] } },
  ];

  it("group stays in the freeRadicals bucket (host row is never dropped)", () => {
    const b = zoneEligibility([untargeted], zone, { host: allWhitelisted });
    expect(b.freeRadicals.map((e) => e.adGroupId)).toEqual(["host"]);
    expect(b.directlyTargeted).toEqual([]);
  });

  it("all three ads are ad-level-TARGETED, so zero free-radical offers", () => {
    const v = eligibility({ adGroup: untargeted, zone, ads: allWhitelisted });
    const r = offerRollup(v, untargeted, allWhitelisted, zone);
    expect(r.total).toBe(3);
    expect(r.serving).toBe(3);
    expect(r.freeRadical).toBe(0);
    expect(r.adLevelTargeted).toBe(3);
    expect(r.freeRadicalAdIds).toEqual([]);
  });

  it("summary: 1 free-radical GROUP, 0 free-radical OFFERS, 3 ad-level-targeted", () => {
    const v = eligibility({ adGroup: untargeted, zone, ads: allWhitelisted });
    const host: EnrichedRow = {
      id: "host", name: "host", archived: false, campaign_on: true, adgroup_on: true,
      has_enabled_ad: true, creative_resolves: true, has_live_viable_ad: true, fully_live: true,
      off_reason: [], scoped_via: ["ad-level-whitelist", "zone-selection"],
      eligible: true, via: v.via, reasons: v.reasons, conflicts: v.conflicts,
      offers: offerRollup(v, untargeted, allWhitelisted, zone),
    };
    const s = summarizeEligibility([], [host], []);
    expect(s.freeRadicalGroups).toBe(1);
    expect(s.freeRadicalOffers).toBe(0);
    expect(s.adLevelTargetedOffers).toBe(3);
  });

  it("D2/D4 invariants hold on a mixed group", () => {
    const ads: Ad[] = [
      { id: "free1" }, { id: "wl", params: { zoneId: [ZONE] } },
      { id: "bl", exceptParams: { zoneId: [ZONE] } }, { id: "away", params: { zoneId: ["other"] } },
    ];
    const v = eligibility({ adGroup: untargeted, zone, ads });
    const r = offerRollup(v, untargeted, ads, zone);
    // D2: the disjoint-ish buckets never exceed the ad count
    expect(r.freeRadical + r.adLevelTargeted + r.adLevelBlacklisted + r.confinedElsewhere)
      .toBeLessThanOrEqual(r.total);
    // D4: the id list is the free-radical count, not a superset
    expect(r.freeRadicalAdIds).toHaveLength(r.freeRadical);
    // D5 (config side): every listed id is an untargeted, non-blacklisted ad
    for (const id of r.freeRadicalAdIds) {
      const ad = ads.find((a) => a.id === id)!;
      expect(ad.params?.zoneId ?? []).toEqual([]);
      expect(ad.exceptParams?.zoneId ?? []).not.toContain(ZONE);
    }
  });
});

/**
 * Field-found on Adnet (`xvret6`) 2026-08-04: 18 ads across 8 groups whitelist a zone
 * their parent group cannot reach — e.g. group `p3a87b` (Roofing) targets six zones not
 * including `upd39v`, while four of its ads name `upd39v`. filterAdgroups() drops the
 * group before filterAds() is consulted, so the whitelist never fires. Six of the eight
 * groups are live, and the config reads as "this ad is targeted here" while doing nothing.
 *
 * Before this signal those groups were dropped from every bucket — the defect was
 * undiscoverable through the tools that exist to find exactly this.
 */
describe("inert ad-level whitelist (dead config, the Adnet shape)", () => {
  const roofing: AdGroup = {
    id: "p3a87b", name: "Roofing", creativeAssetGroupId: CAG,
    params: { zoneId: ["kbh7fx", "hh4x9w", "bietyv"] },   // does NOT include the zone
  };
  const escaping: Ad = { id: "vk5xdn", params: { zoneId: [ZONE] } }; // names the zone anyway

  it("the offer carries the conflict and does not serve", () => {
    const v = eligibility({ adGroup: roofing, zone, ads: [escaping] });
    const o = offerEligibility(v, roofing, escaping, zone);
    expect(v.eligible).toBe(false);
    expect(o.serves).toBe(false);
    expect(o.conflicts).toEqual(["inert-ad-level-whitelist"]);
    expect(o.scoped_via).toContain("ad-level-whitelist");
    expect(o.reasons).toContain("targets-other-zones");
    expect(o.freeRadical).toBe(false);
  });

  it("a whitelist under an ELIGIBLE group is not inert (narrowing, the common idiom)", () => {
    const targeted: AdGroup = { id: "1oby5f", creativeAssetGroupId: CAG, params: { zoneId: [ZONE, "hh4x9w"] } };
    const narrowing: Ad = { id: "sk868g", params: { zoneId: [ZONE] } };
    const v = eligibility({ adGroup: targeted, zone, ads: [narrowing] });
    const o = offerEligibility(v, targeted, narrowing, zone);
    expect(o.serves).toBe(true);
    expect(o.conflicts).toEqual([]);
  });

  it("the group surfaces in its own bucket instead of being dropped", () => {
    const b = zoneEligibility([roofing], zone, { p3a87b: [escaping] });
    expect(b.inertWhitelists.map((e) => e.adGroupId)).toEqual(["p3a87b"]);
    expect(b.inertWhitelists[0].conflicts).toContain("inert-ad-level-whitelist");
    // …and stays out of every reconciliation bucket.
    expect(b.directlyTargeted).toEqual([]);
    expect(b.conflicting).toEqual([]);
    expect(b.freeRadicals).toEqual([]);
  });

  /**
   * The bucket keys on `!eligible`, NOT on CAG match — so every ineligibility cause can
   * land here, each distinguishable by `reasons[]`. Asked live on 2026-08-04: every inert
   * row on Adnet came back `via: ["zone-selection"]`, which raised the question of whether
   * cag-mismatch was structurally unreachable rather than merely absent. It is reachable;
   * Adnet has none.
   */
  it("admits every ineligibility cause, distinguishable by reasons[]", () => {
    const wrongCag: AdGroup = { id: "othercag", creativeAssetGroupId: "different", params: { zoneId: ["z9"] } };
    const archived: AdGroup = { id: "gone", creativeAssetGroupId: CAG, params: { zoneId: ["z9"] }, archived: true };
    const wl: Ad = { id: "a", params: { zoneId: [ZONE] } };

    const b = zoneEligibility([wrongCag, archived], zone, { othercag: [wl], gone: [wl] });
    expect(b.inertWhitelists.map((e) => e.adGroupId).sort()).toEqual(["gone", "othercag"]);

    const byId = new Map(b.inertWhitelists.map((e) => [e.adGroupId, e]));
    expect(byId.get("othercag")!.reasons).toEqual(["cag-mismatch"]);
    expect(byId.get("othercag")!.via).toEqual([]);          // no zone-selection — the tell
    expect(byId.get("gone")!.reasons).toEqual(["archived"]);
    for (const e of b.inertWhitelists) expect(e.conflicts).toContain("inert-ad-level-whitelist");
  });

  it("an out-of-scope group with no whitelisted ad is still dropped (no noise)", () => {
    const plain: Ad = { id: "ordinary" };
    const b = zoneEligibility([roofing], zone, { p3a87b: [plain] });
    expect(b.inertWhitelists).toEqual([]);
  });

  it("rolls up per group, counting only the dead ads", () => {
    const ads: Ad[] = [
      { id: "vk5xdn", params: { zoneId: [ZONE] } },   // inert
      { id: "2j5j7q", params: { zoneId: [ZONE] } },   // inert
      { id: "elsewhere", params: { zoneId: ["hh4x9w"] } }, // confined to a zone the group does target
      { id: "plain" },                                 // nothing
    ];
    const v = eligibility({ adGroup: roofing, zone, ads });
    const r = offerRollup(v, roofing, ads, zone);
    expect(r.total).toBe(4);
    expect(r.serving).toBe(0);          // group can't reach the zone — nothing serves
    expect(r.inertWhitelisted).toBe(2);
    expect(r.inertWhitelistedAdIds).toEqual(["vk5xdn", "2j5j7q"]);
    expect(r.freeRadical).toBe(0);
  });
});

/** C3 — scoped_via is ONE enum across the tools that emit it. */
describe("C3 — shared scoped_via domain", () => {
  const inventoryRow = (over: Partial<AdGroup>, ads: Ad[]) => rollupZoneTargeting({
    zoneId: ZONE, zoneCag: CAG,
    targeted: [{ id: "ag1", name: "ag1", enabled: true, campaignId: "c1", creativeAssetGroupId: CAG, ...over }],
    conflicting: [], campaigns: { c1: { enabled: true } },
    adsByGroup: { ag1: ads }, creatives: { cr1: {} }, mode: "all",
  }).groups[0];

  it("the group-grain rollup emits ad-group-blacklist (the value that used to be missing)", () => {
    const r = inventoryRow({ params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, []);
    expect(r.scoped_via).toContain("ad-group-blacklist");
  });

  it("group-grain values are all members of SCOPED_VIA", () => {
    const r = inventoryRow(
      { params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } },
      [{ id: "a1", params: { zoneId: [ZONE] } }, { id: "a2", exceptParams: { zoneId: [ZONE] } }],
    );
    expect(r.scoped_via).toHaveLength(5);
    for (const v of r.scoped_via) expect(SCOPED_VIA).toContain(v);
  });

  it("offer-grain values are all members of the same SCOPED_VIA", () => {
    const ag: AdGroup = { id: "ag1", creativeAssetGroupId: CAG, params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } };
    const v = eligibility({ adGroup: ag, zone, ads: [] });
    const o = offerEligibility(v, ag, { id: "a1", params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } }, zone);
    expect(o.scoped_via).toHaveLength(5);
    for (const s of o.scoped_via) expect(SCOPED_VIA).toContain(s);
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

  // E1 as literally worded ("reach(X) ∋ Z ⟺ eligible(Z) ∋ X") does NOT hold on
  // response membership: a whitelisted-but-ineligible group is deliberately RETAINED
  // in directlyTargeted[] (so config breakage surfaces instead of vanishing) while
  // reach() filters to eligible only. The symmetry is over the ELIGIBLE set.
  it("E1 — symmetry holds on eligibility, not on response membership", () => {
    const broken: AdGroup = { id: "mismatch", creativeAssetGroupId: "other", params: { zoneId: ["za"] } };
    const zoneA = { id: "za", creativeAssetGroupId: CAG };
    const b = zoneEligibility([broken], zoneA, {});
    expect(b.directlyTargeted.map((e) => e.adGroupId)).toEqual(["mismatch"]); // retained…
    expect(b.directlyTargeted[0].eligible).toBe(false);                       // …but ineligible
    expect(adGroupReach(broken, [zoneA], []).map((e) => e.zoneId)).toEqual([]); // so not reachable
  });

  it("a whitelisted group reaches only the zone it targets", () => {
    const r = adGroupReach({ id: "ag", creativeAssetGroupId: CAG, params: { zoneId: ["zb"] } }, zones, []);
    expect(r.map((e) => e.zoneId)).toEqual(["zb"]);
  });
});
