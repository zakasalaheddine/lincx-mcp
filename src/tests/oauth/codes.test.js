import { describe, it, expect } from "vitest";
import { issueAuthCode, consumeAuthCode } from "../../services/oauth/codes.js";

describe("OAuth auth codes", () => {
  it("issues, consumes once, then fails on reuse", async () => {
    const code = await issueAuthCode({
      client_id: "c1",
      redirect_uri: "https://x/cb",
      code_challenge: "ch",
      lincx_session_id: "lsid",
    });
    expect(code).toMatch(/^[a-f0-9]{64}$/);

    const first = await consumeAuthCode(code);
    expect(first?.lincx_session_id).toBe("lsid");

    const second = await consumeAuthCode(code);
    expect(second).toBeNull();
  });

  it("returns null for unknown code", async () => {
    expect(await consumeAuthCode("nope")).toBeNull();
  });
});
