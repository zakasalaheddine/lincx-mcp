import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
} from "../../constants.js";
import type { AccessToken, RefreshToken } from "../../types.js";

const ACCESS_PREFIX = "oauth:access:";
const REFRESH_PREFIX = "oauth:refresh:";

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

export async function issueTokens(input: {
  client_id: string;
  lincx_session_id: string;
}): Promise<TokenBundle> {
  const access_token = randomBytes(32).toString("hex");
  const refresh_token = randomBytes(32).toString("hex");

  const accessRecord: AccessToken = {
    token: access_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
  };
  const refreshRecord: RefreshToken = {
    token: refresh_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
  };

  const kv = await getKvStore();
  await kv.set(
    ACCESS_PREFIX + access_token,
    JSON.stringify(accessRecord),
    OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  );
  await kv.set(
    REFRESH_PREFIX + refresh_token,
    JSON.stringify(refreshRecord),
    OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  );

  return {
    access_token,
    refresh_token,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function lookupAccessToken(token: string): Promise<AccessToken | null> {
  const kv = await getKvStore();
  const raw = await kv.get(ACCESS_PREFIX + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AccessToken;
  } catch {
    return null;
  }
}

export async function refreshTokens(
  refreshTokenValue: string,
  clientId: string,
): Promise<TokenBundle | null> {
  const kv = await getKvStore();
  const raw = await kv.get(REFRESH_PREFIX + refreshTokenValue);
  if (!raw) return null;

  let record: RefreshToken;
  try {
    record = JSON.parse(raw) as RefreshToken;
  } catch {
    return null;
  }

  if (record.client_id !== clientId) return null;

  // Rotate: invalidate old refresh, issue new pair tied to same Lincx session
  await kv.delete(REFRESH_PREFIX + refreshTokenValue);
  return issueTokens({
    client_id: record.client_id,
    lincx_session_id: record.lincx_session_id,
  });
}

export async function revokeRefreshToken(refreshTokenValue: string): Promise<void> {
  const kv = await getKvStore();
  await kv.delete(REFRESH_PREFIX + refreshTokenValue);
}
