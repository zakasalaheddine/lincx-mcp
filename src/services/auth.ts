/**
 * services/auth.ts
 *
 * Authenticates against the Lincx identity server (authentic-server).
 *
 * Flow:
 *  1. User opens browser login page served by MCP server (localhost:3000)
 *  2. Submits email + password via the web form
 *  3. MCP server POSTs to ix-id.lincx.la/auth/login
 *  4. Stores returned authToken in session — never touches the LLM
 */

import axios, { AxiosError } from "axios";
import { IDENTITY_SERVER } from "../constants.js";

export interface LoginResult {
  authToken: string;
  email: string;
}

// ─────────────────────────────────────────────
// LOGIN  (called by the web form POST handler)
// ─────────────────────────────────────────────

export async function loginWithCredentials(
  email: string,
  password: string
): Promise<LoginResult> {
  try {
    const res = await axios.post<{
      success: boolean;
      message?: string;
      data?: { authToken: string };
    }>(
      `${IDENTITY_SERVER}/auth/login`,
      { email: email.toLowerCase().trim(), password },
      { headers: { "Content-Type": "application/json" }, timeout: 8_000 }
    );

    if (!res.data.success || !res.data.data?.authToken) {
      throw new Error(res.data.message ?? "Login failed — no token returned");
    }

    return { authToken: res.data.data.authToken, email: email.toLowerCase().trim() };
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 401) {
      throw new Error("Invalid email or password");
    }
    if (err instanceof AxiosError && err.response?.status === 403) {
      throw new Error("Account not confirmed. Check your email for a confirmation link.");
    }
    if (err instanceof Error) throw err;
    throw new Error("Unexpected error during login");
  }
}

// ─────────────────────────────────────────────
// LOGOUT  (authentic-server has no revoke endpoint — token is a JWT)
// Session is destroyed server-side; the JWT simply expires on its own.
// ─────────────────────────────────────────────

export async function revokeToken(_token: string): Promise<void> {
  // No-op: authentic-server does not expose a token revocation endpoint.
  // Security relies on session destruction + short JWT expiry window.
}
