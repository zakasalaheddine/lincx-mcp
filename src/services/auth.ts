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

import axios, { AxiosError } from "axios";
import { IDENTITY_SERVER } from "../constants.js";

export interface LoginResult {
  authToken: string;
  email: string;
}

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

    return {
      authToken: res.data.data.authToken,
      email: email.toLowerCase().trim(),
    };
  } catch (err) {
    if (err instanceof AxiosError) {
      if (err.response?.status === 401) throw new Error("Invalid email or password");
      if (err.response?.status === 403) throw new Error("Account not confirmed. Check your email for a confirmation link.");
      const msg = (err.response?.data as { message?: string })?.message ?? err.message;
      throw new Error(msg);
    }
    if (err instanceof Error) throw err;
    throw new Error("Unexpected error during login");
  }
}

/**
 * authentic-server has no token revocation endpoint.
 * Logout is purely session destruction — the JWT expires naturally (default 30d).
 */
export async function revokeToken(_token: string): Promise<void> {
  // intentional no-op
}
