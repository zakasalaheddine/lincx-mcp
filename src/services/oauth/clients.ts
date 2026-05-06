import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import { OAUTH_CLIENT_TTL_SECONDS } from "../../constants.js";
import type { OauthClient } from "../../types.js";

const PREFIX = "oauth:client:";

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

export async function registerClient(input: {
  redirect_uris: string[];
  client_name?: string;
}): Promise<OauthClient> {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris must be a non-empty array");
  }
  for (const uri of input.redirect_uris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`redirect_uri must be https (or http://localhost): ${uri}`);
    }
  }

  const client: OauthClient = {
    client_id: randomBytes(16).toString("hex"),
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    created_at: Date.now(),
  };

  const kv = await getKvStore();
  await kv.set(PREFIX + client.client_id, JSON.stringify(client), OAUTH_CLIENT_TTL_SECONDS);
  return client;
}

export async function getClient(clientId: string): Promise<OauthClient | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PREFIX + clientId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OauthClient;
  } catch {
    return null;
  }
}
