import { describe, it, expect } from "vitest";
import { buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";

describe("buildListEnvelope", () => {
  it("derives next_offset from a full page when upstream gives no total", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `n${i}` }));
    const env = buildListEnvelope(items, { limit: 25, offset: 0 });
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(25);
  });

  it("sets next_offset to null on the last page", () => {
    const env = buildListEnvelope([{ id: "1", name: "a" }], { limit: 25, offset: 0 });
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
