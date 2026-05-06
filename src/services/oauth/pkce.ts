import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Verify a PKCE code_verifier against a stored S256 code_challenge.
 * Per RFC 7636: verifier is 43–128 chars, base64url-safe; method must be S256.
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: "S256",
): boolean {
  if (method !== "S256") return false;
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = createHash("sha256").update(verifier).digest("base64url");
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}
