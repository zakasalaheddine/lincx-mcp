import { describe, it, expect, vi, afterEach } from "vitest";
import { loginWithCredentials } from "../services/auth.js";

// Stub global fetch with a canned identity-server response.
function stubFetch(status        , body         ) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("loginWithCredentials — surfaces the identity server's real error", () => {
  // Real observed shape from ix-id.lincx.la/auth/login: { success:false, error:"..." }
  it("propagates body.error (not a generic mask) on 401", async () => {
    stubFetch(401, { success: false, error: "User Not Found" });
    await expect(loginWithCredentials("x@y.com", "pw")).rejects.toThrow(/User Not Found/);
  });

  it("propagates body.error on a 403 (e.g. unconfirmed account)", async () => {
    stubFetch(403, { success: false, error: "Email not confirmed" });
    await expect(loginWithCredentials("x@y.com", "pw")).rejects.toThrow(/Email not confirmed/);
  });

  it("returns the token on success", async () => {
    stubFetch(200, { success: true, data: { authToken: "jwt-123" } });
    const r = await loginWithCredentials("x@y.com", "pw");
    expect(r.authToken).toBe("jwt-123");
    expect(r.email).toBe("x@y.com");
  });
});
