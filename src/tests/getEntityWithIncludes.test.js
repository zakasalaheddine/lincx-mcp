import { describe, it, expect, beforeEach } from "vitest";
import { on, reset } from "./helpers/mockWorkApi.js";

// Imported after the helper so vi.mock (hoisted) has replaced workApi.js first.
const { getEntityWithIncludes } = await import("../tools/_shared.js");

// getEntityWithIncludes only passes the session through to the (mocked)
// workApiRequest, so a stub is sufficient here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session = {}       ;

describe("getEntityWithIncludes", () => {
  beforeEach(() => reset());

  it("returns the bare entity (no extra call) when include is omitted", async () => {
    on("GET", /\/api\/campaigns\/c1$/, () => ({ id: "c1", name: "Camp" }));
    const r = await getEntityWithIncludes(session, "/api/campaigns", "c1", undefined);
    expect(r).toEqual({ id: "c1", name: "Camp" });
  });

  it("wraps as { entity, parents } when include=['parents']", async () => {
    on("GET", /\/api\/zones\/z1$/, () => ({ id: "z1", name: "Zone" }));
    on("GET", /\/api\/zones\/z1\/parents$/, () => [{ id: "site1" }, { id: "net1" }]);

    const r = await getEntityWithIncludes(session, "/api/zones", "z1", ["parents"]);
    expect(r).toEqual({
      entity: { id: "z1", name: "Zone" },
      parents: [{ id: "site1" }, { id: "net1" }],
    });
  });

  it("uses a stable wrap shape even when the entity comes back wrapped in { data }", async () => {
    on("GET", /\/api\/templates\/t1$/, () => ({ data: { id: "t1", html: "<div/>" } }));
    on("GET", /\/api\/templates\/t1\/parents$/, () => [{ id: "net1" }]);

    const r = await getEntityWithIncludes(session, "/api/templates", "t1", ["parents"]);
    // Entity is nested under `entity` as-is; we never spread the unknown shape.
    expect(r).toEqual({
      entity: { data: { id: "t1", html: "<div/>" } },
      parents: [{ id: "net1" }],
    });
  });
});
