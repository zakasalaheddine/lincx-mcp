/**
 * fitEligibility — the B5 contract: a zone too big for one response is PAGED,
 * never degraded. Every returned row keeps its full field set (offers,
 * scoped_via, via, reasons, conflicts); rows that don't fit are reachable via
 * offset; summary stays exact over the whole set at every offset/bucket.
 *
 * Scale mirrors the 2026-08-03 review fixture: zone 8z7wzb, 83 directly
 * targeted + 124 free-radical groups, which measured ~118k chars unpaged
 * against a 30k guard.
 */
import { describe, it, expect } from "vitest";
import { fitEligibility, summarizeEligibility, type EnrichedRow, type EligibilityPayload, type Bucket } from "../tools/zoneEligibilityTools.js";
import type { OfferRollup } from "../tools/eligibility.js";

const LIMIT = 30_000;
const ZONE = "8z7wzb";
const CAG = "0bckt2";

const offers = (o: Partial<OfferRollup> = {}): OfferRollup => ({
  total: 3, serving: 3, freeRadical: 0, adLevelTargeted: 0, adLevelBlacklisted: 0,
  confinedElsewhere: 0, freeRadicalAdIds: [], ...o,
});

const row = (id: string, targeted: boolean): EnrichedRow => ({
  id, name: `Some Advertiser — Campaign ${id} (US Desktop)`, archived: false,
  campaign_on: true, adgroup_on: true, has_enabled_ad: true, creative_resolves: true,
  has_live_viable_ad: true, fully_live: true, off_reason: [],
  scoped_via: targeted ? ["ad-group-whitelist", "zone-selection"] : ["zone-selection"],
  eligible: true,
  via: targeted ? ["ad-group-whitelist", "zone-selection"] : ["zone-selection"],
  reasons: [], conflicts: [],
  offers: targeted ? offers() : offers({ freeRadical: 3, freeRadicalAdIds: ["ad000001", "ad000002", "ad000003"] }),
});

const payload = (nDirect: number, nRadical: number, nConflict = 0): EligibilityPayload => {
  const direct = Array.from({ length: nDirect }, (_, i) => row(`d${i}`, true));
  const radicals = Array.from({ length: nRadical }, (_, i) => row(`r${i}`, false));
  const conflict = Array.from({ length: nConflict }, (_, i) => row(`c${i}`, true));
  return {
    zone: { id: ZONE, name: "Some Zone Name", creativeAssetGroupId: CAG, templateId: "tpl1" },
    summary: summarizeEligibility(direct, radicals, conflict),
    directlyTargeted: direct, freeRadicals: radicals, conflicting: conflict,
    scan: { zonesScanned: 300, adGroupsScanned: 900, campaignsScanned: 400, adsScanned: 3000, creativesScanned: 1344 },
  };
};

const parse = (r: { content: { text: string }[] }) => {
  const text = r.content[0].text;
  const body = text.slice(text.indexOf("\n\n") + 2);
  return { header: text.slice(0, text.indexOf("\n\n")), json: JSON.parse(body) as Record<string, any> };
};
const size = (r: unknown) => JSON.stringify(r).length;

/** Walk every page of a bucket, returning the concatenated rows. */
function walk(full: EligibilityPayload, bucket: Bucket) {
  const rows: EnrichedRow[] = [];
  let offset: number | undefined = 0;
  let pages = 0;
  while (offset !== undefined) {
    const { json } = parse(fitEligibility(full, bucket, offset, LIMIT));
    for (const k of ["directlyTargeted", "freeRadicals", "conflicting"]) {
      if (Array.isArray(json[k])) rows.push(...(json[k] as EnrichedRow[]));
    }
    offset = json.page?.next_offset;
    if (++pages > 50) throw new Error("paging did not terminate");
  }
  return { rows, pages };
}

const FIELDS = ["offers", "scoped_via", "via", "reasons", "conflicts", "fully_live", "off_reason", "eligible"] as const;

describe("fitEligibility — small zone fits in one call (B1–B4)", () => {
  const full = payload(5, 4, 1);
  const { header, json } = parse(fitEligibility(full, "all", 0, LIMIT));

  it("returns every bucket in full, complete:true, no next_offset", () => {
    expect(json.complete).toBe(true);
    expect(json.page.next_offset).toBeUndefined();
    expect(json.directlyTargeted).toHaveLength(5);
    expect(json.freeRadicals).toHaveLength(4);
    expect(json.conflicting).toHaveLength(1);
  });

  it("B1/B2 — array lengths match the summary counts one-for-one", () => {
    expect(json.directlyTargeted).toHaveLength(json.summary.directlyTargeted);
    expect(json.freeRadicals).toHaveLength(json.summary.freeRadicalGroups);
    expect(json.conflicting).toHaveLength(json.summary.conflicting);
  });

  it("header states exact counts and no page warning", () => {
    expect(header).toContain("5 targeted");
    expect(header).not.toContain("PARTIAL PAGE");
  });
});

describe("fitEligibility — review fixture scale, 83 + 124 (B5)", () => {
  const full = payload(83, 124);

  it("stays under the response guard", () => {
    expect(size(fitEligibility(full, "all", 0, LIMIT))).toBeLessThanOrEqual(LIMIT);
  });

  it("B5 — every returned row keeps its FULL field set (no id-string degradation)", () => {
    const { json } = parse(fitEligibility(full, "all", 0, LIMIT));
    const rows = [...json.directlyTargeted, ...json.freeRadicals];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r).toBe("object");
      for (const f of FIELDS) expect(r[f]).toBeDefined();
      expect(Object.keys(r.offers)).toContain("freeRadical");
    }
  });

  it("signals the partial page in both the body and the header", () => {
    const { header, json } = parse(fitEligibility(full, "all", 0, LIMIT));
    expect(json.complete).toBe(false);
    expect(json.page.next_offset).toBe(json.page.returned);
    expect(json.page.total).toBe(207);
    expect(header).toContain("PARTIAL PAGE");
    expect(header).toContain("offset:");
  });

  it("summary is exact over the WHOLE set at every offset", () => {
    for (const offset of [0, 40, 150, 206]) {
      const { json } = parse(fitEligibility(full, "all", offset, LIMIT));
      expect(json.summary).toEqual(full.summary);
      expect(json.summary.directlyTargeted).toBe(83);
      expect(json.summary.freeRadicalGroups).toBe(124);
      expect(json.summary.freeRadicalOffers).toBe(372); // 124 radical groups × 3 free-radical ads
    }
  });

  it("paging is lossless — each row exactly once, no gaps, no duplicates", () => {
    const { rows, pages } = walk(full, "all");
    expect(pages).toBeGreaterThan(1);
    expect(rows).toHaveLength(207);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(207);
    expect(ids).toEqual([...full.directlyTargeted, ...full.freeRadicals].map((r) => r.id));
  });

  it("bucket:'freeRadicals' returns only free radicals, still fully paged and lossless", () => {
    const { json } = parse(fitEligibility(full, "freeRadicals", 0, LIMIT));
    expect(json.directlyTargeted).toBeUndefined();
    expect(json.conflicting).toBeUndefined();
    expect(json.page.total).toBe(124);
    expect(json.summary.directlyTargeted).toBe(83); // summary unaffected by the bucket filter
    const { rows } = walk(full, "freeRadicals");
    expect(rows.map((r) => r.id)).toEqual(full.freeRadicals.map((r) => r.id));
    for (const r of rows) expect(r.offers.freeRadical).toBe(3);
  });

  it("every page stays under the guard", () => {
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = fitEligibility(full, "all", offset, LIMIT);
      expect(size(result)).toBeLessThanOrEqual(LIMIT);
      offset = parse(result).json.page?.next_offset;
    }
  });

  it("an offset past the end returns an empty page (never an error), and never claims complete", () => {
    const { json } = parse(fitEligibility(full, "all", 999, LIMIT));
    expect(json.page.returned).toBe(0);
    expect(json.directlyTargeted).toEqual([]);
    expect(json.complete).toBe(false); // 0 rows is not the whole answer
  });

  it("a TAIL page never claims complete — complete means this one response holds everything", () => {
    // Walk to the last page: it has no next_offset but is only a slice of 207.
    let offset = 0, last: Record<string, any> | undefined;
    while (true) {
      const { json } = parse(fitEligibility(full, "all", offset, LIMIT));
      last = json;
      if (json.page.next_offset === undefined) break;
      offset = json.page.next_offset;
    }
    expect(offset).toBeGreaterThan(0);
    expect(last!.page.returned).toBeLessThan(last!.page.total);
    expect(last!.complete).toBe(false);
  });

  it("complete:true implies the arrays equal the full selected slice (the B1/B2 key)", () => {
    for (const bucket of ["all", "directlyTargeted", "freeRadicals", "conflicting"] as Bucket[]) {
      for (const offset of [0, 5, 90, 999]) {
        const { json } = parse(fitEligibility(full, bucket, offset, LIMIT));
        if (!json.complete) continue;
        expect(json.page.offset).toBe(0);
        expect(json.page.returned).toBe(json.page.total);
      }
    }
  });
});

describe("fitEligibility — pathological single oversize row", () => {
  it("falls back to ids-only with complete:false and a re-run note, never a silent partial", () => {
    const full = payload(1, 0);
    full.directlyTargeted[0].offers.freeRadicalAdIds = Array.from({ length: 5000 }, (_, i) => `ad${i}`);
    const { json } = parse(fitEligibility(full, "all", 0, LIMIT));
    expect(json.complete).toBe(false);
    expect(json.ids).toEqual(["d0"]);
    expect(json.note).toContain("bucket");
    expect(json.summary.directlyTargeted).toBe(1);
  });
});
