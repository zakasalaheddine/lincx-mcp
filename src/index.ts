/**
 * index.ts — Lincx MCP Server entry point
 *
 * Two surfaces on the same Express app:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST|GET|DELETE /mcp)
 *
 * In stdio mode, the MCP server is connected over stdin/stdout instead of /mcp;
 * the Express app still serves the login UI on SERVER_PORT for local dev.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { loginWithCredentials } from "./services/auth.js";
import { createSession, consumeTicket, peekTicket, bindMcpToLincxSession } from "./services/sessionManager.js";
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
import { requireAccessKey } from "./middleware/requireAccessKey.js";
import { loginLimiter, mcpLimiter } from "./middleware/rateLimit.js";
import { SERVER_PORT, TRANSPORT, IDENTITY_SERVER, IS_PRODUCTION } from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);   // behind Fly proxy; needed for correct rate-limit IPs
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── /health (no auth) ────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Login UI (access-key gated) ──────────────────────────────────────────────
app.get("/login", requireAccessKey, async (req, res) => {
  const ticket = typeof req.query.t === "string" ? req.query.t : "";
  const valid = ticket ? await peekTicket(ticket) : false;
  res.setHeader("Content-Type", "text/html");
  if (!valid) {
    res.status(400).send(buildTicketErrorPage());
    return;
  }
  res.send(buildLoginPage(ticket));
});

app.post("/api/login", requireAccessKey, loginLimiter, async (req, res) => {
  const ticket = typeof req.query.t === "string" ? req.query.t : "";
  const { email, password } = req.body as { email?: string; password?: string };

  if (!ticket) {
    res.status(400).json({ success: false, error: "Missing ticket." });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ success: false, error: "Email and password are required." });
    return;
  }

  const mcpSessionId = await consumeTicket(ticket);
  if (!mcpSessionId) {
    res.status(400).json({ success: false, error: "This login link has expired. Return to Claude and run auth_login again." });
    return;
  }

  try {
    const { authToken } = await loginWithCredentials(email, password);
    const session = await createSession({ user_id: email, email, auth_token: authToken });
    await bindMcpToLincxSession(mcpSessionId, session.session_id);
    console.error(`[Auth] Login OK: ${email} → mcp:${mcpSessionId}`);
    res.json({ success: true, email: session.email, networks: session.networks, active_network: session.active_network });
  } catch (err) {
    const upstream = err instanceof Error ? err.message : "Login failed";
    console.error(`[Auth] Login failed for ${email}: ${upstream}`);
    res.status(401).json({
      success: false,
      error: `${upstream} — this login link is single-use. Return to Claude and run auth_login again for a fresh link.`,
    });
  }
});

app.get("/login/success", requireAccessKey, (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildSuccessPage());
});

// ── Dev debug routes (non-production only) ───────────────────────────────────
if (!IS_PRODUCTION) {
  const registeredTools = (server as unknown as { _registeredTools: Record<string, { description?: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;

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

async function getOrCreateTransport(sessionId: string | undefined): Promise<StreamableHTTPServerTransport> {
  if (sessionId && transports.has(sessionId)) return transports.get(sessionId)!;

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
  try {
    await server.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }
  return transport;
}

app.post("/mcp", requireAccessKey, mcpLimiter, async (req, res) => {
  const existingId = req.header("mcp-session-id");
  const transport = await getOrCreateTransport(existingId);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAccessKey, async (req, res) => {
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).json({ error: "Unknown MCP session." });
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

app.delete("/mcp", requireAccessKey, async (req, res) => {
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

  if (TRANSPORT === "http") {
    console.error(`[MCP]    HTTP transport ready`);
  } else {
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    console.error("[MCP]    stdio transport active");
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML templates
// ─────────────────────────────────────────────────────────────────────────────

function buildLoginPage(ticket: string): string {
  const safeTicket = encodeURIComponent(ticket);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Interlincx — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0f;--surface:#111118;--border:#1e1e2e;--text:#e8e8f0;--muted:#6b6b8a;--accent:#6c63ff;--accent-dim:#3d3980;--accent-glow:rgba(108,99,255,.15);--error:#ff6b6b;--success:#63ffb4;--ff:'Syne',sans-serif;--fm:'DM Mono',monospace}
    html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--ff);-webkit-font-smoothing:antialiased}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;position:relative}
    .card{position:relative;z-index:1;width:420px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:48px 44px 44px;box-shadow:0 32px 64px rgba(0,0,0,.5)}
    h1{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin-bottom:6px}
    .sub{font-family:var(--fm);font-size:12px;font-weight:300;color:var(--muted);letter-spacing:.04em;margin-bottom:36px}
    .field{margin-bottom:18px}
    label{display:block;font-family:var(--fm);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
    input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--fm);font-size:14px;padding:13px 16px;outline:none;transition:border-color .15s,box-shadow .15s}
    input:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--accent-glow)}
    .btn{width:100%;margin-top:8px;padding:14px;background:var(--accent);color:#fff;font-family:var(--ff);font-size:14px;font-weight:700;letter-spacing:.04em;border:none;border-radius:8px;cursor:pointer}
    .btn:hover{background:#7c74ff}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .errmsg{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.25);border-radius:8px;color:var(--error);font-family:var(--fm);font-size:12px;padding:12px 14px;margin-top:16px}
    .errmsg.show{display:block}
    hr{border:none;border-top:1px solid var(--border);margin:28px 0 20px}
    .foot{font-family:var(--fm);font-size:11px;color:var(--muted);text-align:center;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p class="sub">// credentials stay server-side — never sent to Claude</p>
    <div class="field">
      <label for="email">Email address</label>
      <input type="email" id="email" autocomplete="email" autofocus/>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" autocomplete="current-password"/>
    </div>
    <button class="btn" id="btn" onclick="go()">Sign in</button>
    <div class="errmsg" id="err"></div>
    <hr/>
    <p class="foot">POST → ${IDENTITY_SERVER}/auth/login</p>
  </div>
  <script>
    const TICKET = "${safeTicket}";
    const KEY = new URLSearchParams(window.location.search).get('key') || '';
    const POST_URL = '/api/login?t=' + encodeURIComponent(TICKET) + (KEY ? '&key=' + encodeURIComponent(KEY) : '');
    document.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    async function go() {
      const email = document.getElementById('email').value.trim();
      const pw = document.getElementById('password').value;
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      err.classList.remove('show');
      if (!email || !pw) { showErr('Please enter email and password.'); return; }
      btn.disabled = true;
      try {
        const r = await fetch(POST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
        const d = await r.json();
        if (d.success) { window.location.href = '/login/success' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''); }
        else { showErr(d.error || 'Login failed.'); document.getElementById('password').value = ''; }
      } catch (e) { showErr('Cannot reach server.'); }
      finally { btn.disabled = false; }
    }
    function showErr(msg) { const el = document.getElementById('err'); el.textContent = msg; el.classList.add('show'); }
  </script>
</body>
</html>`;
}

function buildTicketErrorPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Link expired</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#ff6b6b;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>This login link has expired</h1>
<p>Return to Claude and run <code>auth_login</code> again to get a fresh URL.</p></div></body></html>`;
}

function buildSuccessPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#63ffb4;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>You're signed in</h1>
<p>Close this tab and return to Claude. Run <code>auth_status</code> to confirm, then <code>network_list</code>.</p></div></body></html>`;
}
