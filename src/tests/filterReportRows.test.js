import { describe, it, expect } from "vitest";
import { filterReportRows, aggregateReport } from "../tools/reportingTools.js";

const rows = [
  { advertiser: "Acme", zone: "Primary", date: "2026-07-14", hour: "00", loads: 100, revenue: 1.0 },
  { advertiser: "Acme", zone: "Primary", date: "2026-07-14", hour: "15", loads: 50, revenue: 2.0 },
  { advertiser: "Globex", zone: "Primary", date: "2026-07-14", hour: "00", loads: 20, revenue: 0.5 },
]                             ;

describe("filterReportRows", () => {
  it("passes everything through when no filter", () => {
    const r = filterReportRows(rows, undefined);
    expect(r.rows).toHaveLength(3);
    expect(r.missingKeys).toEqual([]);
  });

  it("keeps only matching rows, case-insensitively", () => {
    const r = filterReportRows(rows, { advertiser: "acme" });
    expect(r.rows).toHaveLength(2);
    expect(r.missingKeys).toEqual([]);
    // filtered rows aggregate to just Acme's totals
    expect(aggregateReport(r.rows, []).total.loads).toBe(150);
  });

  it("flags a filter key that is not a dimension of any row (guards silent empty)", () => {
    const r = filterReportRows(rows, { campaign: "X" });
    expect(r.missingKeys).toEqual(["campaign"]);
    expect(r.rows).toHaveLength(0);
  });

  it("returns value hints when key exists but no value matches (typo recovery)", () => {
    const r = filterReportRows(rows, { advertiser: "Acmee" });
    expect(r.missingKeys).toEqual([]);
    expect(r.rows).toHaveLength(0);
    expect(r.valueHints).toContain("advertiser=Acme");
    expect(r.valueHints).toContain("advertiser=Globex");
  });

  it("supports multi-key AND filters", () => {
    const r = filterReportRows(rows, { advertiser: "Acme", zone: "Primary" });
    expect(r.rows).toHaveLength(2);
  });
});
