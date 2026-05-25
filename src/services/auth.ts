/**
 * services/auth.ts
 *
 * Handles login against the Lincx authentic-server identity service.
 *
 * Flow:
 *   1. User opens http://localhost:PORT/login in browser
 *   2. Submits email + password via the web form
 *   3. Express POST /api/login calls loginWithCredentials()
 *   4. Returns authToken which is stored in session — never seen by Claude
 */

import { IDENTITY_SERVER } from "../constants.js";

export interface LoginResult {
  authToken: string;
  email: string;
}

export async function loginWithCredentials(
  email: string,
  password: string
): Promise<LoginResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  let res: Response;
  try {
    res = await fetch(`${IDENTITY_SERVER}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json() as { success: boolean; error?: string; message?: string; data?: { authToken: string } };

  // The identity server reports failures in `body.error` (observed:
  // { success:false, error:"User Not Found" }). Read that first so the real
  // reason reaches the user/logs — `message` is a forward-compat fallback.
  // Previously every branch read only `body.message`, masking every failure as
  // "Invalid email or password" and making login impossible to diagnose.
  const serverError = body.error ?? body.message;

  if (res.status === 401) {
    throw new Error(serverError ?? "Invalid email or password");
  }
  if (res.status === 403) {
    throw new Error(serverError ?? "Account not confirmed. Check your email for a confirmation link.");
  }
  if (!res.ok) {
    throw new Error(serverError ?? `Login failed with status ${res.status}`);
  }

  const authToken = body.data?.authToken;
  if (!body.success || authToken === undefined) {
    throw new Error(serverError ?? "Login failed — no token returned");
  }

  return { authToken, email: email.toLowerCase().trim() };
}

/**
 * authentic-server has no token revocation endpoint.
 * Logout is purely session destruction — the JWT expires naturally (default 30d).
 */
export async function revokeToken(_token: string): Promise<void> {
  // intentional no-op
}

/**
 * Read the `exp` claim (seconds since epoch) from a JWT WITHOUT verifying the
 * signature. We only need to know whether our stored Lincx token has lapsed so
 * we can prompt a clean re-login instead of letting every Work API call 401 —
 * the Work API still verifies the signature on its side. Returns null when the
 * value isn't a 3-part JWT or carries no numeric `exp`.
 */
export function getJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the token carries an `exp` claim that has already passed. Tokens with
 * no readable expiry return false (fail open — let the Work API be the authority).
 */
export function isJwtExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = getJwtExpiry(token);
  return exp !== null && exp * 1000 <= nowMs;
}
