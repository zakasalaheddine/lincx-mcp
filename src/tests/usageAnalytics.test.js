import { describe, it, expect } from "vitest";
import { classifyResult, getEventSink,                  recordEventAsync } from "../services/usageAnalytics.js";
import { getSessionStore } from "../services/sessionStore.js";
import { bindMcpToLincxSession } from "../services/sessionManager.js";
                                           

describe("classifyResult", () => {
  it("marks a normal result ok", () => {
    expect(classifyResult({ content: [{ type: "text", text: "{\"id\":\"1\"}" }] }))
      .toEqual({ status: "ok" });
  });

  it("detects a returned Error: text result (not just thrown / isError)", () => {
    const r = classifyResult({ content: [{ type: "text", text: "Error: Not authenticated. Use 'auth_login' first." }] });
    expect(r.status).toBe("error");
    expect(r.error_kind).toBe("not_authenticated");
  });

  it("classifies the oversized guard result via isError + body", () => {
    const r = classifyResult({ isError: true, content: [{ type: "text", text: "{\"error\":\"response_too_large\",\"size\":40000}" }] });
    expect(r).toEqual({ status: "error", error_kind: "response_too_large" });
  });

  it("maps known Work API error prefixes", () => {
    expect(classifyResult({ content: [{ type: "text", text: "Error: Your Lincx session has expired. Use 'auth_login'." }] }).error_kind).toBe("auth_expired");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Bad request — must have property" }] }).error_kind).toBe("bad_params");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Resource not found. Double-check the ID." }] }).error_kind).toBe("work_api_4xx");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Work API server error. Try again later." }] }).error_kind).toBe("work_api_5xx");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Request timed out." }] }).error_kind).toBe("timeout");
    expect(classifyResult({ content: [{ type: "text", text: "Error: something weird" }] }).error_kind).toBe("other");
  });
});

const ev = (over                      = {})             => ({
  ts: Date.now(), type: "tool", name: "list_zones", status: "ok",
  duration_ms: 5, response_chars: 100, params_keys: [], ...over,
});

describe("EventSink (in-memory)", () => {
  it("returns most-recent-first and evicts beyond the cap", async () => {
    const sink = await getEventSink();
    for (let i = 0; i < 5; i++) await sink.append(ev({ name: `t${i}` }));
    const recent = await sink.readRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].name).toBe("t4"); // newest first
  });
});

describe("recordEventAsync", () => {
  it("resolves and attaches the real user from the mcp session id", async () => {
    const session          = {
      session_id: "lincx-rec", user_id: "u@x.com", email: "u@x.com",
      auth_token: "t", networks: [{ id: "n1", name: "N" }], active_network: "n1",
    };
    await (await getSessionStore()).set("lincx-rec", session);
    await bindMcpToLincxSession("mcp-rec", "lincx-rec");

    await recordEventAsync({
      type: "tool", name: "get_zone", status: "ok",
      duration_ms: 3, response_chars: 50, params_keys: ["id"], mcp_session_id: "mcp-rec",
    });

    const recent = await (await getEventSink()).readRecent(1);
    expect(recent[0].name).toBe("get_zone");
    expect(recent[0].user_id).toBe("u@x.com");
    expect(recent[0].email).toBe("u@x.com");
  });

  it("never throws when the session can't be resolved", async () => {
    await expect(recordEventAsync({
      type: "tool", name: "list_ads", status: "ok",
      duration_ms: 1, response_chars: 10, params_keys: [], mcp_session_id: "missing",
    })).resolves.toBeUndefined();
  });
});

import { computeStats } from "../services/usageAnalytics.js";

describe("computeStats", () => {
  const base = { duration_ms: 10, response_chars: 100, params_keys: []             };
  const events               = [
    { ts: 100, type: "tool", name: "list_zones", status: "ok",    user_id: "a", email: "a@x", mcp_session_id: "s1", ...base },
    { ts: 200, type: "tool", name: "get_zone",   status: "ok",    user_id: "a", email: "a@x", mcp_session_id: "s1", ...base },
    { ts: 300, type: "tool", name: "report_query", status: "error", error_kind: "auth_expired", user_id: "b", email: "b@x", mcp_session_id: "s2", ...base },
  ];

  it("aggregates tool health, users, errors, and sequences", () => {
    const s = computeStats(events);

    const lz = s.tools.find((t) => t.name === "list_zones") ;
    expect(lz.calls).toBe(1);
    expect(lz.error_rate).toBe(0);

    const rq = s.tools.find((t) => t.name === "report_query") ;
    expect(rq.errors).toBe(1);
    expect(rq.error_rate).toBe(1);

    expect(s.users.find((u) => u.user_id === "a") .distinct_tools).toBe(2);
    expect(s.errors.find((e) => e.kind === "auth_expired") .count).toBe(1);
    expect(s.sequences.transitions["list_zones>get_zone"]).toBe(1);
    expect(s.window.events).toBe(3);
  });
});
