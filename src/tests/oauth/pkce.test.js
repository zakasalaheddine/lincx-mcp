import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { verifyPkce } from "../../services/oauth/pkce.js";

function challengeFromVerifier(verifier        )         {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("verifyPkce", () => {
  it("accepts a correct S256 verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = challengeFromVerifier(verifier);
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const verifier = "a".repeat(64);
    const challenge = challengeFromVerifier("b".repeat(64));
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });

  it("rejects an unsupported method (plain)", () => {
    expect(verifyPkce("a".repeat(64), "a".repeat(64), "plain"          )).toBe(false);
  });

  it("rejects too-short verifier (< 43 chars per RFC)", () => {
    expect(verifyPkce("short", "anything", "S256")).toBe(false);
  });

  it("rejects too-long verifier (> 128 chars per RFC)", () => {
    expect(verifyPkce("a".repeat(129), "anything", "S256")).toBe(false);
  });
});
