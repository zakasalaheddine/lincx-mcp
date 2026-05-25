import { describe, it, expect } from "vitest";
import { fitEntityToText } from "../services/workApi.js";

const LIMIT = 25_000;
const huge = (n: number) => "x".repeat(n);

describe("fitEntityToText", () => {
  it("returns small entities unchanged and parseable", () => {
    const e = { id: "c1", name: "Camp", status: "active" };
    const text = fitEntityToText(e);
    expect(JSON.parse(text)).toEqual(e);
  });

  it("elides the largest string field (html) and keeps valid JSON + metadata", () => {
    const tpl = { id: "tpl1", name: "Hero", html: huge(40_000), css: huge(2_000) };
    const text = fitEntityToText(tpl);

    expect(text.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text); // must not throw
    expect(parsed.id).toBe("tpl1");
    expect(parsed.name).toBe("Hero");
    expect(parsed.html).toMatch(/^\[elided: 40000 chars\]$/);
    expect(parsed._truncated.elided).toContain("html");
    // css was small enough to survive once html was elided.
    expect(parsed.css).toBe(huge(2_000));
  });

  it("tracks nested paths for the include:['parents'] shape", () => {
    const wrapped = { entity: { id: "t1", html: huge(40_000) }, parents: [{ id: "net1", name: "N" }] };
    const text = fitEntityToText(wrapped);

    const parsed = JSON.parse(text);
    expect(parsed.entity.id).toBe("t1");
    expect(parsed.entity.html).toMatch(/^\[elided/);
    expect(parsed._truncated.elided).toContain("entity.html");
    expect(parsed.parents[0].id).toBe("net1");
  });

  // The contract: parseable JSON for ANY input, oversized or not.
  it("never produces unparseable JSON across object / array / primitive / null", () => {
    const inputs: unknown[] = [
      { id: "a", blob: huge(60_000) },
      [{ id: "1", body: huge(40_000) }, { id: "2", body: huge(40_000) }],
      huge(40_000),
      42,
      null,
      { nested: { deep: { s: huge(50_000) } } },
    ];
    for (const input of inputs) {
      const text = fitEntityToText(input);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text.length).toBeLessThanOrEqual(LIMIT);
    }
  });
});
