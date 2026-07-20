import { describe, it, expect } from "vitest";
import { capGroups } from "../tools/reportingTools.js";

const base = { dimensionSet: "ds", range: { startDate: "2026-07-01", endDate: "2026-07-07" }, groupBy: ["zone"], rowsScanned: 100 };
const total = { loads: 1000, revenue: 50 };

describe("capGroups", () => {
  it("returns groups untouched when undefined (grand-total mode)", () => {
    expect(capGroups(base, total, undefined)).toEqual({});
  });

  it("keeps all groups when they fit", () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({ zone: `z${i}`, loads: 10 - i }));
    const r = capGroups(base, total, groups);
    expect(r.groups).toHaveLength(10);
    expect(r.groupsTruncated).toBeUndefined();
  });

  it("caps and annotates when groups exceed the budget, keeping the top-ranked", () => {
    // Fat payload per group forces truncation well under 30k chars.
    const groups = Array.from({ length: 5000 }, (_, i) => ({ zone: `zone-${i}`, blob: "x".repeat(200), loads: 5000 - i }));
    const r = capGroups(base, total, groups);
    expect(r.groupsTruncated).toBeDefined();
    expect(r.groupsTruncated!.total).toBe(5000);
    expect(r.groups!.length).toBe(r.groupsTruncated!.returned);
    expect(r.groups!.length).toBeLessThan(5000);
    // The serialized result stays under the guard.
    expect(JSON.stringify({ ...base, total, groups: r.groups }).length).toBeLessThan(30_000);
    // Top-ranked group (input is pre-sorted desc) survives.
    expect((r.groups![0] as { zone: string }).zone).toBe("zone-0");
  });
});
