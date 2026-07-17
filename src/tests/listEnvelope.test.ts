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
});
