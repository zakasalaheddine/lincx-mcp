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

  const body = await res.json() as { success: boolean; message?: string; data?: { authToken: string } };

  if (res.status === 401) {
    throw new Error(body.message ?? "Invalid email or password");
  }
  if (res.status === 403) {
    throw new Error(body.message ?? "Account not confirmed. Check your email for a confirmation link.");
  }
  if (!res.ok) {
    throw new Error(body.message ?? `Login failed with status ${res.status}`);
  }

  const authToken = body.data?.authToken;
  if (!body.success || authToken === undefined) {
    throw new Error(body.message ?? "Login failed — no token returned");
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
