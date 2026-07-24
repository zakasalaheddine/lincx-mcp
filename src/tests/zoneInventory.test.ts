import { describe, it, expect } from "vitest";
import { selectTargeting, rollupZoneTargeting, fitZoneInventory, type AdGroup, type Inventory, type Row } from "../tools/zoneInventoryTools.js";

const ZONE = "8z7wzb";
const CAG = "0bckt2";

const ag = (over: Partial<AdGroup> = {}): AdGroup => ({
  id: "ag1", name: "AG1", enabled: true,
  params: { zoneId: [ZONE] }, campaignId: "c1", creativeAssetGroupId: CAG,
  ...over,
});

describe("selectTargeting", () => {
  it("keeps groups whose params.zoneId includes the zone", () => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: "a" }), ag({ id: "b", params: { zoneId: ["other"] } })], ZONE);
    expect(targeted.map((g) => g.id)).toEqual(["a"]);
    expect(conflicting).toEqual([]);
  });
  it("ignores a group with the zone only in exceptParams", () => {
    const { targeted } = selectTargeting(
      [ag({ id: "x", params: { zoneId: ["other"] }, exceptParams: { zoneId: [ZONE] } })], ZONE);
    expect(targeted).toEqual([]);
  });
  it("flags zone-in-both as conflicting, not targeted", () => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: "y", params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } })], ZONE);
    expect(targeted).toEqual([]);
    expect(conflicting.map((g) => g.id)).toEqual(["y"]);
  });
});

const base = (over: Partial<Parameters<typeof rollupZoneTargeting>[0]> = {}) =>
  rollupZoneTargeting({
    zoneId: ZONE,
    zoneCag: CAG,
    targeted: [ag()],
    conflicting: [],
    campaigns: { c1: { enabled: true } },
    adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }] },
    creatives: { cr1: {} },
    mode: "all",
    ...over,
  });

describe("rollupZoneTargeting", () => {
  it("fully_live when campaign, ad group, and a live+viable ad are all on", () => {
    const { groups, summary } = base();
    expect(groups[0].fully_live).toBe(true);
    expect(groups[0].off_reason).toEqual([]);
    expect(summary).toMatchObject({ targeted: 1, live: 1, off: 0 });
  });
  it("campaign off → off_reason names campaign", () => {
    const { groups } = base({ campaigns: { c1: { enabled: false } } });
    expect(groups[0].campaign_on).toBe(false);
    expect(groups[0].fully_live).toBe(false);
    expect(groups[0].off_reason).toEqual(["campaign"]);
  });
  it("ad group enabled but archived → forced off, off_reason names archived", () => {
    const { groups, summary } = base({ targeted: [ag({ enabled: true, archived: true })] });
    expect(groups[0].archived).toBe(true);
    expect(groups[0].adgroup_on).toBe(false);
    expect(groups[0].off_reason).toEqual(["archived"]);
    expect(summary.archived).toBe(1);
  });
  it("per-ad conjunction: enabled ad w/ dangling creative + disabled ad w/ valid creative → NOT live-viable", () => {
    const { groups } = base({
      adsByGroup: { ag1: [
        { id: "ad1", enabled: true, creativeId: "missing" },
        { id: "ad2", enabled: false, creativeId: "cr1" },
      ] },
      creatives: { cr1: {} },
    });
    expect(groups[0].has_enabled_ad).toBe(true);
    expect(groups[0].creative_resolves).toBe(true);
    expect(groups[0].has_live_viable_ad).toBe(false);
    expect(groups[0].off_reason).toEqual(["no_live_viable_ad"]);
  });
  it("archived creative does not count as viable", () => {
    const { groups } = base({ creatives: { cr1: { archived: true } } });
    expect(groups[0].has_live_viable_ad).toBe(false);
  });
  it("archived ad is not a live ad", () => {
    const { groups } = base({ adsByGroup: { ag1: [{ id: "ad1", enabled: true, archived: true, creativeId: "cr1" }] } });
    expect(groups[0].has_live_viable_ad).toBe(false);
  });
  it("mode 'off' returns only not-fully-live rows", () => {
    const { groups } = base({
      targeted: [ag({ id: "ag1" }), ag({ id: "ag2", campaignId: "c2" })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }],
        ag2: [{ id: "ad2", enabled: true, creativeId: "cr1" }],
      },
      mode: "off",
    });
    expect(groups.map((g) => g.id)).toEqual(["ag2"]);
  });
  it("scoped_via: a plain whitelisted group (different CAG, no ad-level whitelist) is ad-group-whitelist only", () => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: "other" })],
      adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }] },
    });
    expect(groups[0].scoped_via).toEqual(["ad-group-whitelist"]);
  });
  it("scoped_via: an ad in the group also whitelisting the zone adds ad-level-whitelist", () => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: "other" })],
      adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1", params: { zoneId: [ZONE] } }] },
    });
    expect(groups[0].scoped_via).toEqual(["ad-group-whitelist", "ad-level-whitelist"]);
  });
  it("scoped_via: a group sharing the zone's CAG adds zone-selection", () => {
    const { groups } = base({ targeted: [ag({ creativeAssetGroupId: CAG })] });
    expect(groups[0].scoped_via).toEqual(["ad-group-whitelist", "zone-selection"]);
  });
  it("scoped_via: all three when ad-level whitelist and CAG both apply", () => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: CAG })],
      adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1", params: { zoneId: [ZONE] } }] },
    });
    expect(groups[0].scoped_via).toEqual(["ad-group-whitelist", "ad-level-whitelist", "zone-selection"]);
  });
  it("scoped_via: an ad excluding the zone adds ad-level-blacklist", () => {
    const { groups } = base({
      targeted: [ag({ creativeAssetGroupId: "other" })],
      adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1", exceptParams: { zoneId: [ZONE] } }] },
    });
    expect(groups[0].scoped_via).toEqual(["ad-group-whitelist", "ad-level-blacklist"]);
  });

  it("per-ad zone check: an enabled+viable ad blacklisted from the zone does NOT make the group live there", () => {
    const { groups } = base({
      adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1", exceptParams: { zoneId: [ZONE] } }] },
    });
    expect(groups[0].has_live_viable_ad).toBe(false);
    expect(groups[0].off_reason).toContain("no_live_viable_ad");
  });
  it("per-ad zone check: a sibling ad that DOES serve keeps the group live", () => {
    const { groups } = base({
      adsByGroup: { ag1: [
        { id: "ad1", enabled: true, creativeId: "cr1", exceptParams: { zoneId: [ZONE] } }, // hidden here
        { id: "ad2", enabled: true, creativeId: "cr1" },                                    // serves
      ] },
    });
    expect(groups[0].has_live_viable_ad).toBe(true);
    expect(groups[0].fully_live).toBe(true);
  });

  it("summary counts are over the full targeted set regardless of mode filter", () => {
    const { summary } = base({
      targeted: [ag({ id: "ag1" }), ag({ id: "ag2", campaignId: "c2" })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }],
        ag2: [{ id: "ad2", enabled: true, creativeId: "cr1" }],
      },
      mode: "live",
    });
    expect(summary).toMatchObject({ targeted: 2, live: 1, off: 1 });
  });
});

// N off rows with realistic-length names.
const makeInventory = (n: number): Inventory => {
  const groups: Row[] = Array.from({ length: n }, (_, i) => ({
    id: `adg${String(i).padStart(4, "0")}`,
    name: `Some Advertiser ${i} - Refinance - QL LRE Match [Exchange]`,
    archived: false, campaign_on: false, adgroup_on: true, has_enabled_ad: true,
    creative_resolves: true, has_live_viable_ad: true, fully_live: false, off_reason: ["campaign"],
  }));
  return {
    zone: { id: "8z7wzb", name: "Quicken Loans Refinance - Match", creativeAssetGroupId: "0bckt2", templateId: "ayf1pr" },
    mode: "all",
    summary: { targeted: n, live: 0, off: n, archived: 0, conflicting: 0 },
    groups, conflicting: [],
    scan: { adGroupsScanned: 1150, campaignsScanned: 664, adsScanned: 1331, creativesScanned: 1343 },
  };
};

// The rollup rides in content text: "<header>\n\n<compact JSON>". Parse the JSON
// the way the model must — this is the model-visible channel (structuredContent is
// not surfaced by MCP hosts).
const payload = (r: { content: { type: "text"; text: string }[] }): {
  groups?: Row[]; groupIds?: string[]; complete: boolean; namesOmitted?: boolean;
} => JSON.parse(r.content[0].text.split("\n\n").slice(1).join("\n\n"));

describe("fitZoneInventory (never drops ad groups, data in text)", () => {
  it("carries the rollup in content text, not structuredContent", () => {
    const r = fitZoneInventory(makeInventory(3), 30_000) as Record<string, unknown>;
    expect(r.structuredContent).toBeUndefined(); // hosts don't surface it
    const s = payload(r as { content: { type: "text"; text: string }[] });
    expect(s.groups).toHaveLength(3);
  });

  it("returns every row with names when it fits, complete:true", () => {
    const r = fitZoneInventory(makeInventory(83), 30_000);
    const s = payload(r);
    expect(s.complete).toBe(true);
    expect(s.namesOmitted).toBeUndefined();
    expect(s.groups).toHaveLength(83);
    expect(s.groups![0].name).toBeTruthy();
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(30_000);
  });

  it("83 rows fit under the 30k guard — the reported truncation is gone", () => {
    const r = fitZoneInventory(makeInventory(83), 30_000);
    const s = payload(r);
    expect(s.namesOmitted).toBeUndefined();
    expect(s.groups).toHaveLength(83);
    expect(JSON.stringify(r).length).toBeLessThan(30_000);
  });

  it("sheds names (not rows) when the full form overflows but ids+flags still fit", () => {
    const inv = makeInventory(83);
    const full = JSON.stringify(fitZoneInventory(inv, 10_000_000)).length; // uncapped size
    const limit = full - 1; // just below full → sheds names (stripped is smaller, fits)
    const r = fitZoneInventory(inv, limit);
    const s = payload(r);
    expect(s.complete).toBe(true);
    expect(s.namesOmitted).toBe(true);
    expect(s.groups).toHaveLength(83); // every ad group still present
    expect((s.groups![0] as Record<string, unknown>).name).toBeUndefined();
    expect(s.groups![0].id).toBeTruthy();
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(limit);
  });

  it("only as a last resort returns ids-only with complete:false — never a silent partial", () => {
    const r = fitZoneInventory(makeInventory(2000), 5_000);
    const s = payload(r);
    expect(s.complete).toBe(false);
    expect(s.groups).toBeUndefined();
    expect(s.groupIds).toHaveLength(2000); // every id accounted for
    expect(r.content[0].text).toMatch(/INCOMPLETE/);
  });
});
