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
import { getSessionStore, getKvStore } from "./sessionStore.js";
import { SESSION_TTL_SECONDS } from "../constants.js";
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
  console.error(`[Session] Created for ${params.email} — id: ${session.session_id}`);
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
  console.error(`[Session] ${sessionId}: network ${previousNetwork} → ${networkId}`);
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
    console.error(`[Session] Destroyed ${sessionId}`);
  }
}

// ── MCP-session ↔ Lincx-session binding ──────────────────────────────────────

const MCP_PREFIX = "mcp:session:";
const TICKET_PREFIX = "ticket:";
const TICKET_TTL_SECONDS = 600;   // 10 min

/** Resolve an MCP session id to its bound Lincx session id. */
export async function resolveLincxSession(
  mcpSessionId: string | undefined
): Promise<string | null> {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  return await kv.get(MCP_PREFIX + id);
}

/** Bind an MCP session id to a Lincx session id. */
export async function bindMcpToLincxSession(
  mcpSessionId: string | undefined,
  lincxSessionId: string
): Promise<void> {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.set(MCP_PREFIX + id, lincxSessionId, SESSION_TTL_SECONDS);
}

/** Unbind (logout) an MCP session. */
export async function unbindMcpSession(
  mcpSessionId: string | undefined
): Promise<void> {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.delete(MCP_PREFIX + id);
}

// ── Login tickets (single-use, short-lived) ──────────────────────────────────

/** Mint a ticket that correlates a browser login back to an MCP session. */
export async function mintTicket(
  mcpSessionId: string | undefined
): Promise<string> {
  const id = mcpSessionId ?? "stdio";
  const ticket = uuidv4();
  const kv = await getKvStore();
  await kv.set(TICKET_PREFIX + ticket, id, TICKET_TTL_SECONDS);
  return ticket;
}

/** Consume a ticket (single-use). Returns the MCP session id it was minted for, or null. */
export async function consumeTicket(ticket: string): Promise<string | null> {
  const kv = await getKvStore();
  const mcpSessionId = await kv.get(TICKET_PREFIX + ticket);
  if (!mcpSessionId) return null;
  await kv.delete(TICKET_PREFIX + ticket);
  return mcpSessionId;
}

/** Peek a ticket without consuming — used by GET /login to pre-validate. */
export async function peekTicket(ticket: string): Promise<boolean> {
  const kv = await getKvStore();
  const v = await kv.get(TICKET_PREFIX + ticket);
  return v !== null;
}