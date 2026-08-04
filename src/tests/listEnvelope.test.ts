import { describe, it, expect } from "vitest";
import { buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";

describe("buildListEnvelope", () => {
  it("slices the window client-side when upstream returns the full set (no total)", () => {
    // Real Work API behavior: ignores limit/offset, returns every row, no total.
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `n${i}` }));

    const page1 = buildListEnvelope(items, { limit: 25, offset: 0 });
    expect(page1.items).toHaveLength(25);
    expect((page1.items[0] as { id: string }).id).toBe("0");
    expect(page1.total).toBe(100);
    expect(page1.has_more).toBe(true);
    expect(page1.next_offset).toBe(25);

    const page2 = buildListEnvelope(items, { limit: 25, offset: 25 });
    // The bug: offset was ignored so page2 === page1. It must now differ.
    expect((page2.items[0] as { id: string }).id).toBe("25");
    expect(page2.total).toBe(100);
  });

  it("sets has_more false / next_offset null on the last partial page", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `n${i}` }));
    const env = buildListEnvelope(items, { limit: 25, offset: 25 });
    expect(env.items).toHaveLength(5);
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("returns an empty page (no more) when offset is past the end", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `n${i}` }));
    const env = buildListEnvelope(items, { limit: 25, offset: 50 });
    expect(env.items).toHaveLength(0);
    expect(env.total).toBe(10);
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeNull();
  });

  it("uses the upstream total when present", () => {
    const env = buildListEnvelope({ items: [{ id: "1", name: "a" }], total: 99 }, { limit: 25, offset: 0 });
    expect(env.total).toBe(99);
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(1);
  });

  it("projects to { id, name } + status by default; ['*'] returns full rows minus heavy fields", () => {
    const row = { id: "1", name: "a", status: "active", note: "keep-me", html: "<huge/>" };
    const projected = buildListEnvelope([row], { limit: 25, offset: 0 }).items[0] as Record<string, unknown>;
    expect(projected).toEqual({ id: "1", name: "a", status: "active" });
    expect(projected).not.toHaveProperty("note");

    const full = buildListEnvelope([row], { limit: 25, offset: 0, fields: ["*"] }).items[0] as Record<string, unknown>;
    // '*' keeps non-heavy fields like `note` but still drops content blobs like `html`.
    expect(full).toEqual({ id: "1", name: "a", status: "active", note: "keep-me" });
    expect(full).not.toHaveProperty("html");
  });
});

/**
 * Field-found 2026-08-04: fields:["params.zoneId"] returned NEITHER field and no
 * error — the row came back looking clean with the data silently absent, and the
 * only way to shrink a page (the whole point on a collection holding a 232KB row)
 * was unavailable.
 */
describe("dotted field paths", () => {
  const rows = [
    { id: "a", name: "A", params: { zoneId: ["z1", "z2"], other: 1 }, exceptParams: {} },
    { id: "b", name: "B", params: {}, exceptParams: { zoneId: ["z9"] } },
  ];

  it("projects the leaf under its dotted key, not the whole parent object", () => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ["params.zoneId", "exceptParams.zoneId"] });
    const [a, b] = env.items as Record<string, unknown>[];
    expect(a["params.zoneId"]).toEqual(["z1", "z2"]);
    expect(a.params).toBeUndefined();          // the heavy parent is NOT included
    expect(a["exceptParams.zoneId"]).toBeUndefined(); // absent on this row, fine
    expect(b["exceptParams.zoneId"]).toEqual(["z9"]);
  });

  it("dotted selection is dramatically smaller than pulling the parent", () => {
    const fat = [{ id: "x", name: "X", params: { zoneId: ["z1"], junk: Array.from({ length: 5000 }, (_, i) => `j${i}`) } }];
    const dotted = JSON.stringify(buildListEnvelope(fat, { limit: 25, offset: 0, fields: ["params.zoneId"] })).length;
    const parent = JSON.stringify(buildListEnvelope(fat, { limit: 25, offset: 0, fields: ["params"] })).length;
    expect(dotted).toBeLessThan(parent / 10);
  });

  it("flags a requested field that matched no row instead of failing silently", () => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ["params.zoneId", "nope", "params.missing"] });
    expect(env.unknown_fields).toEqual(["nope", "params.missing"]);
  });

  it("omits unknown_fields entirely when every requested field matched", () => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ["params.zoneId"] });
    expect(env.unknown_fields).toBeUndefined();
  });

  it("judges paths against the whole collection, not the page — a sparse field is not 'unknown'", () => {
    // exceptParams.zoneId exists on exactly one row, far outside the first page.
    const sparse = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, params: { zoneId: ["z"] } })),
      { id: "rare", params: { zoneId: ["z"] }, exceptParams: { zoneId: ["z9"] } },
    ];
    const page1 = buildListEnvelope(sparse, { limit: 100, offset: 0, fields: ["params.zoneId", "exceptParams.zoneId"] });
    // No row on page 1 carries it, but it is real — flagging it would abort a sweep.
    expect(page1.unknown_fields).toBeUndefined();

    const bogus = buildListEnvelope(sparse, { limit: 100, offset: 0, fields: ["exceptParams.nope"] });
    expect(bogus.unknown_fields).toEqual(["exceptParams.nope"]); // genuinely absent everywhere
  });
});

describe("listEnvelopeToText", () => {
  it("returns compact (non-indented) JSON when under the limit", () => {
    const env = buildListEnvelope([{ id: "1", name: "a" }], { limit: 25, offset: 0 });
    const text = listEnvelopeToText(env);
    expect(text).not.toContain("\n");
    expect(JSON.parse(text).items).toHaveLength(1);
  });

  it("drops items instead of slicing — output stays valid JSON when oversized", () => {
    // Each item ~1KB of name → 200 items blows past the 25k char limit.
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: "x".repeat(1000) }));
    const env = buildListEnvelope(items, { limit: 200, offset: 0 });
    const text = listEnvelopeToText(env);

    // The whole point of the fix: never emit unparseable JSON.
    const parsed = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(parsed.items.length).toBeLessThan(200);
    expect(parsed.has_more).toBe(true);
    // next_offset points at the first dropped item so the caller can continue.
    expect(parsed.next_offset).toBe(parsed.items.length);
    expect(parsed.truncated.fetched).toBe(200);
  });

  /**
   * Field-found 2026-08-04: ad group `ducqqp` serializes to 232KB on its own, so no
   * full item fit, kept.length hit 0, and next_offset came back EQUAL to the requested
   * offset. "Page until next_offset is absent" then loops forever on that row and the
   * rest of the collection is unreachable. The walk must always advance.
   */
  describe("a single row bigger than the whole budget", () => {
    const poison = (id: string) => ({ id, name: "n", params: { zoneId: Array.from({ length: 20_000 }, (_, i) => `z${i}`) } });

    it("advances next_offset past the poison row instead of stalling", () => {
      // Exactly the field shape: the poison row sits AT the requested offset.
      const items = [{ id: "first", name: "a" }, poison("ducqqp"), { id: "next", name: "b" }];
      const env = buildListEnvelope(items, { limit: 100, offset: 1, fields: ["params"] });
      const parsed = JSON.parse(listEnvelopeToText(env));
      expect(parsed.next_offset).toBe(2);          // was 1 — the stall
      expect(parsed.next_offset).toBeGreaterThan(env.offset);
    });

    it("names the skipped row rather than swallowing it, and stays under the limit", () => {
      const env = buildListEnvelope([poison("ducqqp")], { limit: 100, offset: 0, fields: ["params"] });
      const text = listEnvelopeToText(env);
      const parsed = JSON.parse(text);
      expect(text.length).toBeLessThanOrEqual(25_000);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].id).toBe("ducqqp");
      expect(parsed.items[0]._omitted).toBeDefined();
      expect(parsed.truncated.returned).toBe(0);   // no FULL row was returned
      expect(parsed.truncated.skipped_oversized).toBe("ducqqp");
    });

    it("a full walk terminates even when the collection is all poison rows", () => {
      const items = [poison("a"), poison("b"), poison("c")];
      const seen: string[] = [];
      let offset: number | null = 0;
      let guard = 0;
      while (offset !== null) {
        if (++guard > 10) throw new Error("walk did not terminate");
        const parsed = JSON.parse(listEnvelopeToText(buildListEnvelope(items, { limit: 100, offset, fields: ["params"] })));
        for (const it of parsed.items) seen.push(it.id);
        offset = parsed.has_more ? parsed.next_offset : null;
      }
      expect(seen).toEqual(["a", "b", "c"]); // every id reachable, none repeated
    });
  });
});
