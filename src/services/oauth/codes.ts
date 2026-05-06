import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import { OAUTH_AUTH_CODE_TTL_SECONDS } from "../../constants.js";
import type { AuthCode } from "../../types.js";

const PREFIX = "oauth:code:";

export async function issueAuthCode(input: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  lincx_session_id: string;
}): Promise<string> {
  const code = randomBytes(32).toString("hex");
  const record: AuthCode = {
    code,
    ...input,
    expires_at: Date.now() + OAUTH_AUTH_CODE_TTL_SECONDS * 1000,
  };
  const kv = await getKvStore();
  await kv.set(PREFIX + code, JSON.stringify(record), OAUTH_AUTH_CODE_TTL_SECONDS);
  return code;
}

/** Single-use: deletes the code on retrieval. Returns null if missing/expired. */
export async function consumeAuthCode(code: string): Promise<AuthCode | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PREFIX + code);
  if (!raw) return null;
  await kv.delete(PREFIX + code);
  try {
    return JSON.parse(raw) as AuthCode;
  } catch {
    return null;
  }
}

// ── Pending authorization-request store ─────────────────────────────────────
// Used by /oauth/authorize → /login → /api/login to carry OAuth context across
// the user-driven login redirect.

export interface PendingAuthRequest {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
  expires_at: number;
}

const PENDING_PREFIX = "oauth:pending:";
const PENDING_TTL_SECONDS = 600;

export async function storePendingAuthRequest(
  req: Omit<PendingAuthRequest, "expires_at">,
): Promise<void> {
  const kv = await getKvStore();
  const record: PendingAuthRequest = {
    ...req,
    expires_at: Date.now() + PENDING_TTL_SECONDS * 1000,
  };
  await kv.set(PENDING_PREFIX + req.request_id, JSON.stringify(record), PENDING_TTL_SECONDS);
}

export async function consumePendingAuthRequest(
  requestId: string,
): Promise<PendingAuthRequest | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PENDING_PREFIX + requestId);
  if (!raw) return null;
  await kv.delete(PENDING_PREFIX + requestId);
  try {
    return JSON.parse(raw) as PendingAuthRequest;
  } catch {
    return null;
  }
}

export async function peekPendingAuthRequest(
  requestId: string,
): Promise<PendingAuthRequest | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PENDING_PREFIX + requestId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAuthRequest;
  } catch {
    return null;
  }
}
