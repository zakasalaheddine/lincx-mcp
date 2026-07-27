import { describe, it, expect } from "vitest";
import { fitAnalysis } from "../tools/analysisTools.js";

const LIMIT = 30_000;

/** The wire format is `header\n\ncompact JSON` — parse what the model parses. */
function parse(result: { content: { type: "text"; text: string }[] }) {
  const text = result.content[0].text;
  const blank = text.indexOf("\n\n");
  expect(blank).toBeGreaterThan(0);
  return JSON.parse(text.slice(blank + 2));
}

const creatives = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    adGroupId: `ag${i}`,
    adId: `ad${i}`,
    creativeId: `cr${i}`,
    impressions: 1000 + i,
    clicks: 10,
    revenue: 5.5,
    ctr: 1.0,
    cpm: 5.5,
    tierScore: 0.42,
    revenueShare: 0.01,
    isStable: true,
    assignedTier: "TIER_1",
    assignedRank: i,
  }));

const rankRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    adGroupId: `ag${i % 20}`,
    adId: `ad${i % 20}`,
    creativeId: `cr${i % 20}`,
    rank: String(i % 8),
    impressions: 500,
    clicks: 5,
    revenue: 2.5,
    ctr: 1.0,
    cpm: 5.0,
    daysAtRank: 7,
  }));

const succeeded = (opts: { creatives?: number; ranks?: number; localTiers?: number } = {}) => ({
  _id: "cl123",
  status: "succeeded",
  analysisType: "offerTiering",
  networkId: "svce6t",
  request: { zoneId: "abc123", dateStart: "2026-06-01", dateEnd: "2026-06-30", timezone: "UTC", noLLM: true },
  input: {
    summary: { rowCount: 4000, contextDays: 30, noLLM: true },
    zoneMetrics: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${i + 1}`, rpzl: 1.2 })),
    dataQuality: { lowVolumeRows: 10, totalRows: 4000 },
    tieringContext: {
      datasetConfidence: "HIGH",
      creatives: creatives(opts.creatives ?? 5),
      localTiers: creatives(opts.localTiers ?? 5).map((c) => ({ ...c, localTier: "Neutral" })),
      nonMonetizingCreatives: creatives(3),
      defaultTierCreatives: creatives(3),
      rankDistribution: rankRows(opts.ranks ?? 5),
      riskFlags: { rpzlRisk: "NONE" },
    },
  },
  output: {
    json: { tier_grouping: { recommended_tier_count: 3 }, tier_tables: { TIER_1: [{ creativeId: "cr0" }] } },
    rawResponse: "x".repeat(20_000),
  },
  execution: { provider: "deterministic", usage: { totalTokens: 0 } },
});

describe("fitAnalysis", () => {
  it("keeps a queued job intact and tells the caller to keep polling", () => {
    const doc = {
      _id: "cl1",
      status: "queued",
      analysisType: "offerTiering",
      networkId: "svce6t",
      request: { zoneId: "abc123", dateStart: "2026-06-01", dateEnd: "2026-06-30" },
    };
    const parsed = parse(fitAnalysis(doc, LIMIT));

    expect(parsed.status).toBe("queued");
    expect(parsed._id).toBe("cl1");
    expect(parsed.note).toMatch(/Poll get_analysis/);
    expect(parsed.omitted).toBeUndefined();
  });

  it("flags a running job the same way", () => {
    const parsed = parse(fitAnalysis({ _id: "cl2", status: "running" }, LIMIT));
    expect(parsed.note).toMatch(/Poll get_analysis/);
  });

  it("always drops rawResponse and the rendered prompt, whatever the size", () => {
    const doc = succeeded();
    (doc.input as Record<string, unknown>).prompt = { rendered: "you are the lincx analyst..." };
    const parsed = parse(fitAnalysis(doc, LIMIT));

    expect(parsed.output.rawResponse).toBeUndefined();
    expect(parsed.input.prompt).toBeUndefined();
    expect(parsed.output.json.tier_grouping.recommended_tier_count).toBe(3);
    expect(parsed.input.tieringContext.creatives).toHaveLength(5);
  });

  it("sheds rankDistribution first and records what it dropped", () => {
    const doc = succeeded({ creatives: 40, ranks: 400 });
    const parsed = parse(fitAnalysis(doc, 12_000));

    expect(parsed.omitted).toContain("input.tieringContext.rankDistribution");
    expect(parsed.input.tieringContext.rankDistribution).toBeUndefined();
    // The scoring detail and the verdict both survive the first shed.
    expect(parsed.input.tieringContext.creatives).toHaveLength(40);
    expect(parsed.output.json.tier_tables.TIER_1).toHaveLength(1);
  });

  it("sheds localTiers only after the diagnostic lists", () => {
    const doc = succeeded({ creatives: 60, ranks: 600, localTiers: 60 });
    const parsed = parse(fitAnalysis(doc, 6_000));

    const droppedBeforeLocal = ["input.tieringContext.nonMonetizingCreatives", "input.tieringContext.defaultTierCreatives"];
    if (parsed.omitted?.includes("input.tieringContext.localTiers")) {
      for (const path of droppedBeforeLocal) expect(parsed.omitted).toContain(path);
    }
    expect(parsed.output.json).toBeDefined();
  });

  it("falls back to the verdict plus a complete:false flag rather than a silent partial", () => {
    const doc = succeeded({ creatives: 500, ranks: 2000, localTiers: 500 });
    const parsed = parse(fitAnalysis(doc, 3_000));

    expect(parsed.complete).toBe(false);
    expect(parsed.output.json).toBeDefined();
    expect(parsed.request.zoneId).toBe("abc123");
    expect(parsed.note).toMatch(/omitted/i);
  });

  it("emits a header line and parseable JSON for every branch", () => {
    for (const limit of [30_000, 12_000, 6_000, 3_000, 1_000]) {
      const result = fitAnalysis(succeeded({ creatives: 200, ranks: 800 }), limit);
      const text = result.content[0].text;
      expect(text.split("\n")[0]).toMatch(/^analysis cl123 · offerTiering · succeeded zone abc123/);
      expect(() => parse(result)).not.toThrow();
    }
  });

  it("never mutates the caller's document", () => {
    const doc = succeeded();
    fitAnalysis(doc, 1_000);
    expect(doc.output.rawResponse).toHaveLength(20_000);
    expect(doc.input.tieringContext.rankDistribution).toHaveLength(5);
  });
});
