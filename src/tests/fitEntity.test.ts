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

  /**
   * Field-found 2026-08-04: get_ad_group("ducqqp") returned NO usable data — 232KB
   * of params.zoneId, an array of 20k SHORT strings. No single string leaf was big
   * enough to shed, so the string-only pass could not shrink it and the caller fell
   * through to a bare _truncated note. The readable fields must survive.
   */
  it("elides a huge array of small strings and keeps the rest of the entity", () => {
    const ag = {
      id: "ducqqp", name: "EasyKnock - click_to_post_direct [Exchange]", archived: true,
      creativeAssetGroupId: "0bckt2",
      params: { zoneId: Array.from({ length: 20_000 }, (_, i) => `zone${i}`) },
      exceptParams: {},
    };
    const text = fitEntityToText(ag);

    expect(text.length).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text);
    // The fields the caller actually needed are intact.
    expect(parsed.id).toBe("ducqqp");
    expect(parsed.name).toBe("EasyKnock - click_to_post_direct [Exchange]");
    expect(parsed.creativeAssetGroupId).toBe("0bckt2");
    expect(parsed.exceptParams).toEqual({});
    // The runaway array is shed as a unit, with its size still visible.
    expect(parsed.params.zoneId).toMatch(/^\[elided: 20000 items, \d+ chars\]$/);
    expect(parsed._truncated.elided).toContain("params.zoneId");
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
