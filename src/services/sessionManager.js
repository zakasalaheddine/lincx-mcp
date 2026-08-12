/**
 * services/sessionManager.ts
 *
 * Session lifecycle — the only place session state is mutated.
 *
 * Security contract:
 *   - session_id lives in MCP server process memory only
 *   - auth_token is injected server-side on every API request
 *   - Claude (the AI client) never sees either value
 */

import { v4 as uuidv4 } from "uuid";
                                                                    
import { getSessionStore, getKvStore } from "./sessionStore.js";
import { SESSION_TTL_SECONDS } from "../constants.js";
import { revokeToken, isJwtExpired } from "./auth.js";
import { fetchUserNetworks } from "./networkService.js";
import { lookupAccessToken } from "./oauth/tokens.js";

// ── Create ───────────────────────────────────────────────────────────────────

export async function createSession(params   
                  
                
                     
 )                   {
  const store = await getSessionStore();
  const networks = await fetchUserNetworks(params.auth_token);

  const session          = {
    session_id: uuidv4(),
    user_id: params.user_id,
    email: params.email,
    auth_token: params.auth_token,
    networks,
    active_network: networks[0]?.id ?? null,
  };

  await store.set(session.session_id, session);
  console.error(`[Session] Created for ${params.email} — id: ${session.session_id}`);
  return session;
}

// ── Validate (runs on every tool call) ───────────────────────────────────────

export async function validateSession(
  sessionId        
)                                   {
  const store = await getSessionStore();
  const session = await store.get(sessionId);

  if (!session) {
    return {
      valid: false,
      error: "Not authenticated. Use 'auth_login' to open the browser login page.",
    };
  }

  // Proactively catch a lapsed Lincx JWT so the user gets one clear re-login
  // prompt instead of every tool call failing with a Work API 401.
  if (isJwtExpired(session.auth_token)) {
    return {
      valid: false,
      error: "Your Lincx session has expired. Use 'auth_login' to sign in again.",
    };
  }

  if (!session.active_network) {
    return {
      valid: false,
      error:
        "No active network selected. Use 'network_list' to see your networks, then 'network_switch' to select one.",
    };
  }

  if (!session.networks.some((n) => n.id === session.active_network)) {
    return {
      valid: false,
      error: `Active network '${session.active_network}' is no longer available. Use 'network_switch' to select a valid one.`,
    };
  }

  return { valid: true, session };
}

// ── Switch network ────────────────────────────────────────────────────────────

export async function switchNetwork(
  sessionId        ,
  networkId        
)                                                                                 {
  const store = await getSessionStore();
  const session = await store.get(sessionId);

  if (!session) return { success: false, error: "Session not found." };

  const target = session.networks.find((n) => n.id === networkId);
  if (!target) {
    const available = session.networks.map((n) => `${n.name} (${n.id})`).join(", ");
    return {
      success: false,
      error: `Network '${networkId}' not found. Available: ${available || "none"}`,
    };
  }

  const previousNetwork = session.active_network;
  session.active_network = networkId;
  await store.set(sessionId, session);
  console.error(`[Session] ${sessionId}: network ${previousNetwork} → ${networkId}`);
  return { success: true, previousNetwork };
}

// ── Refresh network list ──────────────────────────────────────────────────────

export async function refreshNetworks(sessionId        )                   {
  const store = await getSessionStore();
  const session = await store.get(sessionId);
  if (!session) return false;

  const networks = await fetchUserNetworks(session.auth_token);
  session.networks = networks;

  // Keep active_network if it still exists, otherwise reset to first
  if (!networks.some((n) => n.id === session.active_network)) {
    session.active_network = networks[0]?.id ?? null;
  }

  await store.set(sessionId, session);
  return true;
}

// ── Destroy (logout) ──────────────────────────────────────────────────────────

export async function destroySession(sessionId        )                {
  const store = await getSessionStore();
  const session = await store.get(sessionId);
  if (session) {
    await revokeToken(session.auth_token); // no-op for authentic-server
    await store.delete(sessionId);
    console.error(`[Session] Destroyed ${sessionId}`);
  }
}

// ── MCP-session ↔ Lincx-session binding ──────────────────────────────────────

const MCP_PREFIX = "mcp:session:";

/** Resolve an MCP session id to its bound Lincx session id. */
export async function resolveLincxSession(
  mcpSessionId                    
)                         {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  return await kv.get(MCP_PREFIX + id);
}

/** Bind an MCP session id to a Lincx session id. */
export async function bindMcpToLincxSession(
  mcpSessionId                    ,
  lincxSessionId        
)                {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.set(MCP_PREFIX + id, lincxSessionId, SESSION_TTL_SECONDS);
}

/** Unbind (logout) an MCP session. */
export async function unbindMcpSession(
  mcpSessionId                    
)                {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.delete(MCP_PREFIX + id);
}

// ── OAuth bearer → Lincx session ─────────────────────────────────────────────

/**
 * Resolve a bearer token from `Authorization: Bearer <token>` to a Lincx session id.
 * Returns null if the token is missing, expired, or the underlying Lincx session is gone.
 */
export async function resolveLincxSessionFromBearer(
  authorizationHeader                    ,
)                         {
  if (!authorizationHeader) return null;
  const m = authorizationHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const access = await lookupAccessToken(m[1]);
  if (!access) return null;
  return access.lincx_session_id;
}