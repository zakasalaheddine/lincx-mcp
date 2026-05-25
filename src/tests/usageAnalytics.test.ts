import { describe, it, expect } from "vitest";
import { classifyResult } from "../services/usageAnalytics.js";

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
