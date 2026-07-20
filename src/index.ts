/**
 * index.ts — Lincx MCP Server entry point
 *
 * Two surfaces on the same Express app:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST|GET|DELETE /mcp)
 *
 * The server is HTTP-only — MCP clients connect over /mcp. There is no stdio
 * transport; everything (Claude Code, Desktop, claude.ai) connects by URL.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { registerAuthTools } from "./tools/authTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerTemplateTools } from "./tools/templateTools.js";
import { registerCreativeAssetGroupTools } from "./tools/creativeAssetGroupTools.js";
import { registerZoneTools } from "./tools/zoneTools.js";
import { registerAdTools } from "./tools/adTools.js";
import { registerAdGroupTools } from "./tools/adGroupTools.js";
import { registerCreativeTools } from "./tools/creativeTools.js";
import { registerCampaignTools } from "./tools/campaignTools.js";
import { registerChannelTools } from "./tools/channelTools.js";
import { registerSiteTools } from "./tools/siteTools.js";
import { registerPublisherTools } from "./tools/publisherTools.js";
import { registerAdvertiserTools } from "./tools/advertiserTools.js";
import { registerExperienceTools } from "./tools/experienceTools.js";
import { registerReportingTools } from "./tools/reportingTools.js";
import { registerZoneInventoryTools } from "./tools/zoneInventoryTools.js";
import { registerResources } from "./tools/resources.js";
import { mcpLimiter } from "./middleware/rateLimit.js";
import { installToolGuards } from "./middleware/toolGuard.js";
import { SERVER_PORT, IS_PRODUCTION, PUBLIC_BASE_URL } from "./constants.js";
import {
  resolveLincxSessionFromBearer,
  bindMcpToLincxSession,
} from "./services/sessionManager.js";
import { wellKnownRouter } from "./routes/wellKnown.js";
import { oauthRegisterRouter } from "./routes/oauthRegister.js";
import { oauthTokenRouter } from "./routes/oauthToken.js";
import { statsRouter } from "./routes/stats.js";
import { loginRouter } from "./routes/login.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

// A single McpServer (Protocol) instance can be bound to exactly ONE transport.
// The Streamable HTTP transport is per-session, so we build a fresh server for
// each session via this factory rather than sharing one across all sessions —
// sharing throws "Already connected to a transport" on the second session.
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "lincx-mcp-server", version: "1.0.0" });

  registerAuthTools(server);
  registerNetworkTools(server);
  registerTemplateTools(server);
  registerCreativeAssetGroupTools(server);
  registerZoneTools(server);
  registerAdTools(server);
  registerAdGroupTools(server);
  registerCreativeTools(server);
  registerCampaignTools(server);
  registerChannelTools(server);
  registerSiteTools(server);
  registerPublisherTools(server);
  registerAdvertiserTools(server);
  registerExperienceTools(server);
  registerReportingTools(server);
  registerZoneInventoryTools(server);
  registerResources(server);

  // Wrap every registered tool handler with the response-size guard + metrics
  // logging. Must run after all register*Tools() calls above.
  installToolGuards(server);

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);   // behind the Coolify (Traefik) proxy; needed for correct rate-limit IPs
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── /health (no auth, fast — used by Coolify healthchecks) ───────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime_s: Math.round(process.uptime()),
    active_sessions: transports.size,
  });
});

// ── OAuth discovery + registration (public, no access-key gate) ──────────────
app.use("/.well-known", wellKnownRouter);
app.use("/oauth", oauthRegisterRouter);
app.use("/oauth", oauthTokenRouter);
app.use(statsRouter);

// ── Login UI + OAuth authorize/token-exchange (public — OAuth handles auth) ──
app.use(loginRouter);

// ── Dev debug routes (non-production only) ───────────────────────────────────
if (!IS_PRODUCTION) {
  const devServer = createMcpServer();
  const registeredTools = (devServer as unknown as { _registeredTools: Record<string, { description?: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;

  app.get("/dev/tools", (_req, res) => {
    const tools = Object.entries(registeredTools).map(([name, t]) => ({ name, description: t.description }));
    res.json({ tools });
  });

  app.post("/dev/tools/:name", async (req, res) => {
    const tool = registeredTools[req.params.name];
    if (!tool) { res.status(404).json({ error: `Tool '${req.params.name}' not found` }); return; }
    try {
      const result = await tool.handler(req.body ?? {}, { sessionId: "stdio" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ── MCP HTTP transport — per-session ────────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

async function createTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transports.set(id, transport);
      console.error(`[MCP]    session initialized: ${id}`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      console.error(`[MCP]    session closed: ${transport.sessionId}`);
    }
  };
  // A dedicated server instance per transport — see createMcpServer().
  const mcpServer = createMcpServer();
  try {
    await mcpServer.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }
  return transport;
}

function bearerChallengeHeader(): string {
  return `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`;
}

app.post("/mcp", mcpLimiter, async (req, res) => {
  try {
    const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
    if (!lincxSessionId) {
      res.setHeader("WWW-Authenticate", bearerChallengeHeader());
      res.status(401).json({ error: "unauthorized", error_description: "Bearer token required." });
      return;
    }

    const existingId = req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport;

    if (existingId && transports.has(existingId)) {
      // Established session — reuse its transport (and its server).
      transport = transports.get(existingId)!;
    } else if (!existingId && isInitializeRequest(req.body)) {
      // New session handshake — stand up a fresh transport + server.
      transport = await createTransport();
    } else {
      // Unknown/stale session id, or a non-initialize request without a session.
      // (Common after a server restart drops in-memory transports — tell the
      // client to re-initialize instead of silently minting a new session.)
      res.status(400).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown })?.id ?? null,
        error: {
          code: -32000,
          message: "Bad Request: unknown or missing MCP session ID. Re-initialize the session.",
        },
      });
      return;
    }

    // Refresh the transport→Lincx binding on every request so reconnects (new
    // transport id) inherit the OAuth-resolved Lincx session immediately.
    if (transport.sessionId) {
      await bindMcpToLincxSession(transport.sessionId, lincxSessionId);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[MCP]    POST /mcp error:", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: "Internal server error." },
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  if (!lincxSessionId) {
    res.setHeader("WWW-Authenticate", bearerChallengeHeader());
    res.status(401).end();
    return;
  }
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).json({ error: "Unknown MCP session." });
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  if (!lincxSessionId) {
    res.setHeader("WWW-Authenticate", bearerChallengeHeader());
    res.status(401).end();
    return;
  }
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).end();
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const httpServer = app.listen(SERVER_PORT);
  httpServer.on("listening", () => {
    console.error(`[HTTP]   Listening on :${SERVER_PORT}`);
    console.error(`[HTTP]   /health, /login, /mcp`);
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[HTTP]   Port ${SERVER_PORT} in use — aborting.`);
      process.exit(1);
    } else {
      console.error("[HTTP]   Server error:", err.message);
      process.exit(1);
    }
  });

  console.error(`[MCP]    HTTP transport ready`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
