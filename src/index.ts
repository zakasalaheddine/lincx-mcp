/**
 * index.ts — Lincx MCP Server entry point
 *
 * Starts two things:
 *  1. Express HTTP server (port 3000) — serves the browser login UI
 *  2. MCP Server — connects via stdio (default) or HTTP
 *
 * Auth flow:
 *   Claude calls auth_login  →  returns http://localhost:3000/login
 *   User opens URL           →  fills in email + password
 *   Browser POSTs to         →  POST /api/login
 *   Server calls             →  ix-id.lincx.la/auth/login
 *   On success               →  session created, browser shows /login/success
 *   Claude calls auth_status →  confirms session, sees available networks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { loginWithCredentials } from "./services/auth.js";
import { createSession } from "./services/sessionManager.js";
import { registerAuthTools } from "./tools/authTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerTemplateTools } from "./tools/templateTools.js";
import { SERVER_PORT, TRANSPORT, IDENTITY_SERVER } from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// SESSION CONTEXT
// session_id lives here — never sent to Claude
// Persisted to .sessions/session_id so dev restarts don't require re-login
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve project root from this file's location (src/index.ts → project root)
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_DIR = join(PROJECT_ROOT, ".sessions");
const SESSION_ID_FILE = join(SESSION_DIR, "session_id");

function loadSessionId(): string | null {
  try { return readFileSync(SESSION_ID_FILE, "utf-8").trim() || null; } catch { return null; }
}

function persistSessionId(id: string | null): void {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(SESSION_ID_FILE, id ?? "");
  } catch { /* best-effort */ }
}

let currentSessionId: string | null = loadSessionId();
if (currentSessionId) console.error(`[Session] Restored session: ${currentSessionId}`);
const getSessionId = (): string | null => currentSessionId;
const setSessionId = (id: string | null): void => { currentSessionId = id; persistSessionId(id); };

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "lincx-mcp-server", version: "1.0.0" });

registerAuthTools(server, getSessionId, setSessionId);
registerNetworkTools(server, getSessionId);
registerTemplateTools(server, getSessionId);
// Add more tool groups here: registerCampaignTools(server, getSessionId), etc.

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS — Login UI + health check
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/** Login page — user opens this in their browser */
app.get("/login", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildLoginPage(currentSessionId !== null));
});

/** Form submission — credentials go directly to ix-id.lincx.la, never to Claude */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ success: false, error: "Email and password are required." });
    return;
  }

  try {
    const { authToken } = await loginWithCredentials(email, password);
    const session = await createSession({ user_id: email, email, auth_token: authToken });
    setSessionId(session.session_id);
    console.error(`[Auth] Login successful: ${email}`);
    res.json({ success: true, email: session.email, networks: session.networks, active_network: session.active_network });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    console.warn(`[Auth] Login failed for ${email}: ${message}`);
    res.status(401).json({ success: false, error: message });
  }
});

/** Post-login success screen */
app.get("/login/success", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildSuccessPage());
});

/** Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", authenticated: currentSessionId !== null });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEV — Test tools without Claude Desktop
//
//   GET  /dev/tools                → list all registered tools
//   POST /dev/tools/:name          → call a tool with JSON body as args
//
//   Examples:
//     curl http://localhost:3000/dev/tools
//     curl -X POST http://localhost:3000/dev/tools/auth_login
//     curl -X POST http://localhost:3000/dev/tools/auth_status
//     curl -X POST http://localhost:3000/dev/tools/network_list
// ─────────────────────────────────────────────────────────────────────────────

const registeredTools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown; description?: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;

app.get("/dev/tools", (_req, res) => {
  const tools = Object.entries(registeredTools).map(([name, t]) => ({
    name,
    description: t.description,
  }));
  res.json({ tools, session: currentSessionId ? "active" : "none" });
});

app.post("/dev/tools/:name", async (req, res) => {
  const tool = registeredTools[req.params.name];
  if (!tool) {
    res.status(404).json({ error: `Tool '${req.params.name}' not found` });
    return;
  }
  try {
    const result = await tool.handler(req.body ?? {}, {});
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** MCP over HTTP — single shared transport, connected once */
let httpTransport: StreamableHTTPServerTransport | null = null;

app.post("/mcp", async (req, res) => {
  if (!httpTransport) {
    httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(httpTransport);
    console.error("[MCP]    HTTP transport connected");
  }
  await httpTransport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  if (!httpTransport) {
    res.status(503).json({ error: "MCP HTTP transport not yet initialised — send a POST first." });
    return;
  }
  await httpTransport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  if (!httpTransport) { res.status(404).end(); return; }
  await httpTransport.handleRequest(req, res);
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start HTTP server for login UI — non-fatal if port is busy
  const httpServer = app.listen(SERVER_PORT);
  httpServer.on("listening", () => {
    console.error(`[HTTP]   Login UI → http://localhost:${SERVER_PORT}/login`);
    console.error(`[HTTP]   Health   → http://localhost:${SERVER_PORT}/health`);
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[HTTP]   Port ${SERVER_PORT} in use — login UI unavailable. MCP tools still work.`);
    } else {
      console.error("[HTTP]   Server error:", err.message);
    }
  });

  if (TRANSPORT === "http") {
    console.error(`[MCP]    HTTP transport → http://localhost:${SERVER_PORT}/mcp`);
    // transport handled by the /mcp express route above
  } else {
    // stdio — default for Claude Code / local IDE
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
// HTML — Login page
// ─────────────────────────────────────────────────────────────────────────────

function buildLoginPage(alreadyLoggedIn: boolean): string {
  const banner = alreadyLoggedIn
    ? `<div class="already-banner">Already authenticated — log in again to refresh your session</div>`
    : "";

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
    :root{
      --bg:#0a0a0f;--surface:#111118;--border:#1e1e2e;
      --text:#e8e8f0;--muted:#6b6b8a;
      --accent:#6c63ff;--accent-dim:#3d3980;--accent-glow:rgba(108,99,255,.15);
      --error:#ff6b6b;--success:#63ffb4;
      --ff:'Syne',sans-serif;--fm:'DM Mono',monospace;
    }
    html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--ff);-webkit-font-smoothing:antialiased}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;position:relative}
    .orb{position:fixed;border-radius:50%;filter:blur(80px);pointer-events:none;z-index:0}
    .orb-1{width:500px;height:500px;top:-150px;left:-100px;background:radial-gradient(circle,rgba(108,99,255,.12),transparent 70%);animation:d1 18s ease-in-out infinite alternate}
    .orb-2{width:400px;height:400px;bottom:-100px;right:-80px;background:radial-gradient(circle,rgba(99,255,180,.07),transparent 70%);animation:d2 22s ease-in-out infinite alternate}
    .grid{position:fixed;inset:0;z-index:0;background-image:linear-gradient(rgba(255,255,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.015) 1px,transparent 1px);background-size:40px 40px;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black,transparent)}
    @keyframes d1{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,30px) scale(1.1)}}
    @keyframes d2{from{transform:translate(0,0)}to{transform:translate(-30px,-20px) scale(1.05)}}
    .card{position:relative;z-index:1;width:420px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:48px 44px 44px;box-shadow:0 0 0 1px rgba(108,99,255,.08),0 32px 64px rgba(0,0,0,.5),0 0 80px rgba(108,99,255,.06);animation:ci .5s cubic-bezier(.16,1,.3,1) both}
    @keyframes ci{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
    .logo-row{display:flex;align-items:center;gap:10px;margin-bottom:32px}
    .logo-mark{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),#a78bfa);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;flex-shrink:0}
    .logo-name{font-size:15px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    .logo-tag{font-family:var(--fm);font-size:10px;font-weight:300;color:var(--muted);letter-spacing:.12em;text-transform:uppercase;margin-left:auto;border:1px solid var(--border);padding:2px 7px;border-radius:4px}
    h1{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin-bottom:6px}
    .sub{font-family:var(--fm);font-size:12px;font-weight:300;color:var(--muted);letter-spacing:.04em;margin-bottom:36px}
    .already-banner{background:rgba(99,255,180,.06);border:1px solid rgba(99,255,180,.2);border-radius:8px;padding:14px 16px;font-family:var(--fm);font-size:12px;color:var(--success);margin-bottom:24px;display:flex;align-items:center;gap:8px}
    .already-banner::before{content:'◉';font-size:10px}
    .field{margin-bottom:18px}
    label{display:block;font-family:var(--fm);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
    input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--fm);font-size:14px;padding:13px 16px;outline:none;transition:border-color .15s,box-shadow .15s}
    input::placeholder{color:var(--muted);opacity:.5}
    input:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--accent-glow)}
    input.err{border-color:var(--error)}
    .btn{width:100%;margin-top:8px;padding:14px;background:var(--accent);color:#fff;font-family:var(--ff);font-size:14px;font-weight:700;letter-spacing:.04em;border:none;border-radius:8px;cursor:pointer;transition:background .15s,transform .1s,box-shadow .15s;position:relative;overflow:hidden}
    .btn:hover{background:#7c74ff;box-shadow:0 0 24px rgba(108,99,255,.4)}
    .btn:active{transform:scale(.98)}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-inner{position:relative;height:20px}
    .btn-text,.btn-spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity .15s}
    .btn-spin{opacity:0}
    .btn.loading .btn-text{opacity:0}
    .btn.loading .btn-spin{opacity:1}
    .spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .errmsg{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.25);border-radius:8px;color:var(--error);font-family:var(--fm);font-size:12px;padding:12px 14px;margin-top:16px;align-items:center;gap:8px}
    .errmsg.show{display:flex}
    .errmsg::before{content:'✕';font-size:10px;flex-shrink:0}
    hr{border:none;border-top:1px solid var(--border);margin:28px 0 20px}
    .foot{font-family:var(--fm);font-size:11px;color:var(--muted);text-align:center;line-height:1.6}
    .foot strong{color:rgba(255,255,255,.2);font-weight:400}
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="grid"></div>
  <div class="card">
    <div class="logo-row">
      <div class="logo-mark">IX</div>
      <span class="logo-name">Interlincx</span>
      <span class="logo-tag">MCP Agent</span>
    </div>
    <h1>Sign in</h1>
    <p class="sub">// credentials stay local — never sent to Claude</p>
    ${banner}
    <div class="field">
      <label for="email">Email address</label>
      <input type="email" id="email" placeholder="you@lincx.la" autocomplete="email" autofocus/>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" placeholder="••••••••••" autocomplete="current-password"/>
    </div>
    <button class="btn" id="btn" onclick="go()">
      <div class="btn-inner">
        <span class="btn-text">Sign in</span>
        <span class="btn-spin"><span class="spinner"></span></span>
      </div>
    </button>
    <div class="errmsg" id="err"></div>
    <hr/>
    <p class="foot">Served locally by the MCP server.<br/><strong>POST → ${IDENTITY_SERVER ?? "https://ix-id.lincx.la"}/auth/login</strong></p>
  </div>
  <script>
    document.addEventListener('keydown',e=>{ if(e.key==='Enter') go(); });
    async function go(){
      const email=document.getElementById('email').value.trim();
      const pw=document.getElementById('password').value;
      const btn=document.getElementById('btn');
      const err=document.getElementById('err');
      err.classList.remove('show');
      document.getElementById('email').classList.remove('err');
      document.getElementById('password').classList.remove('err');
      if(!email||!pw){
        showErr('Please enter your email and password.');
        if(!email) document.getElementById('email').classList.add('err');
        if(!pw) document.getElementById('password').classList.add('err');
        return;
      }
      btn.disabled=true; btn.classList.add('loading');
      try{
        const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw})});
        const d=await r.json();
        if(d.success){ window.location.href='/login/success'; }
        else{ showErr(d.error||'Login failed. Please try again.'); document.getElementById('password').value=''; document.getElementById('password').focus(); }
      }catch(e){ showErr('Cannot reach MCP server. Is it still running?'); }
      finally{ btn.disabled=false; btn.classList.remove('loading'); }
    }
    function showErr(msg){ const el=document.getElementById('err'); el.textContent=msg; el.classList.add('show'); }
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML — Success page
// ─────────────────────────────────────────────────────────────────────────────

function buildSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Interlincx — Authenticated</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0f;--surface:#111118;--border:#1e1e2e;--text:#e8e8f0;--muted:#6b6b8a;--success:#63ffb4;--accent:#6c63ff}
    html,body{height:100%;background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;-webkit-font-smoothing:antialiased}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}
    .orb{position:fixed;border-radius:50%;filter:blur(80px);pointer-events:none;z-index:0;width:500px;height:500px;top:-150px;left:-100px;background:radial-gradient(circle,rgba(99,255,180,.08),transparent 70%);animation:d 20s ease-in-out infinite alternate}
    @keyframes d{from{transform:translate(0,0)}to{transform:translate(30px,20px)}}
    .card{position:relative;z-index:1;width:400px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:48px 44px;box-shadow:0 32px 64px rgba(0,0,0,.5);text-align:center;animation:ci .5s cubic-bezier(.16,1,.3,1) both}
    @keyframes ci{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
    .ring{width:72px;height:72px;border-radius:50%;background:rgba(99,255,180,.08);border:1px solid rgba(99,255,180,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;animation:pop .4s .1s cubic-bezier(.16,1,.3,1) both}
    @keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
    .check{font-size:28px;color:var(--success)}
    h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
    .body{font-family:'DM Mono',monospace;font-size:13px;font-weight:300;color:var(--muted);line-height:1.7;margin-bottom:32px}
    .body strong{color:rgba(255,255,255,.35);font-weight:400}
    .box{background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:10px;padding:16px 18px;font-family:'DM Mono',monospace;font-size:12px;color:rgba(255,255,255,.5);line-height:1.7;text-align:left}
    .cmd{color:#a78bfa;font-weight:500}
  </style>
</head>
<body>
  <div class="orb"></div>
  <div class="card">
    <div class="ring"><span class="check">✓</span></div>
    <h1>You're signed in</h1>
    <p class="body">Session established.<br/><strong>Close this tab</strong> and return to Claude.</p>
    <div class="box">
      Back in Claude, run:<br/>
      <span class="cmd">auth_status</span> → confirm session is active<br/>
      <span class="cmd">network_list</span> → see your networks<br/>
      <span class="cmd">network_switch</span> → select one to start
    </div>
  </div>
</body>
</html>`;
}