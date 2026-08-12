import { describe, it, expect } from "vitest";
import { aggregateReport } from "../tools/reportingTools.js";

// Two zones across two hourly rows each — mirrors the real report shape.
const rows = [
  { zone: "Primary", date: "2026-05-19", hour: "00", loads: 100, clicks: 10, revenue: 1.1, level: "date-hour-zone" },
  { zone: "Primary", date: "2026-05-19", hour: "01", loads: 50, clicks: 5, revenue: 2.2, level: "date-hour-zone" },
  { zone: "Expired", date: "2026-05-19", hour: "00", loads: 20, clicks: 1, revenue: 0.1, level: "date-hour-zone" },
]                             ;

describe("aggregateReport", () => {
  it("returns a grand total (no group rows) when groupBy is empty", () => {
    const { total, groups } = aggregateReport(rows, []);
    expect(groups).toBeUndefined();
    expect(total.loads).toBe(170);
    expect(total.clicks).toBe(16);
    expect(total.revenue).toBe(3.4); // 1.1 + 2.2 + 0.1, rounded to cents
  });

  it("sums numeric metrics grouped by a field, sorted by loads desc", () => {
    const { total, groups } = aggregateReport(rows, ["zone"]);
    expect(total.loads).toBe(170);
    expect(groups).toHaveLength(2);
    // Primary first (more loads)
    expect(groups [0]).toMatchObject({ zone: "Primary", loads: 150, clicks: 15, _rows: 2 });
    expect(groups [1]).toMatchObject({ zone: "Expired", loads: 20, clicks: 1, _rows: 1 });
  });

  it("rounds money fields to cents (no float drift)", () => {
    // 0.1 + 0.2 would be 0.30000000000000004 without rounding
    const drift = [
      { zone: "Z", revenue: 0.1, loads: 1 },
      { zone: "Z", revenue: 0.2, loads: 1 },
    ]                             ;
    const { total } = aggregateReport(drift, []);
    expect(total.revenue).toBe(0.3);
  });

  it("buckets rows missing a groupBy field under (n/a)", () => {
    const mixed = [
      { zone: "A", loads: 5 },
      { loads: 3 }, // no zone
    ]                             ;
    const { groups } = aggregateReport(mixed, ["zone"]);
    const naBucket = groups .find((g) => g.zone === "(n/a)");
    expect(naBucket).toMatchObject({ loads: 3 });
  });
});
