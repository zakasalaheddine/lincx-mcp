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
import type { Session, SessionValidationResult } from "../types.js";
import { getSessionStore } from "./sessionStore.js";
import { revokeToken } from "./auth.js";
import { fetchUserNetworks } from "./networkService.js";

// ── Create ───────────────────────────────────────────────────────────────────

export async function createSession(params: {
  user_id: string;
  email: string;
  auth_token: string;
}): Promise<Session> {
  const store = await getSessionStore();
  const networks = await fetchUserNetworks(params.auth_token);

  const session: Session = {
    session_id: uuidv4(),
    user_id: params.user_id,
    email: params.email,
    auth_token: params.auth_token,
    networks,
    active_network: networks[0]?.id ?? null,
  };

  await store.set(session.session_id, session);
  console.log(`[Session] Created for ${params.email} — id: ${session.session_id}`);
  return session;
}

// ── Validate (runs on every tool call) ───────────────────────────────────────

export async function validateSession(
  sessionId: string
): Promise<SessionValidationResult> {
  const store = await getSessionStore();
  const session = await store.get(sessionId);

  if (!session) {
    return {
      valid: false,
      error: "Not authenticated. Use 'auth_login' to open the browser login page.",
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
  sessionId: string,
  networkId: string
): Promise<{ success: boolean; error?: string; previousNetwork?: string | null }> {
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
  console.log(`[Session] ${sessionId}: network ${previousNetwork} → ${networkId}`);
  return { success: true, previousNetwork };
}

// ── Refresh network list ──────────────────────────────────────────────────────

export async function refreshNetworks(sessionId: string): Promise<boolean> {
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

export async function destroySession(sessionId: string): Promise<void> {
  const store = await getSessionStore();
  const session = await store.get(sessionId);
  if (session) {
    await revokeToken(session.auth_token); // no-op for authentic-server
    await store.delete(sessionId);
    console.log(`[Session] Destroyed ${sessionId}`);
  }
}
