/**
 * index.ts
 *
 * Entry point. Two responsibilities:
 *
 * 1. MCP Server — registers all tools, connects via stdio or HTTP
 * 2. Express HTTP Server — serves the browser login UI on localhost:PORT
 *
 * Authentication flow:
 *   Claude calls auth_login → returns http://localhost:3000/login
 *   User opens URL in browser → sees polished login form
 *   User submits credentials → POST /api/login → ix-id.lincx.la/auth/login
 *   On success → session created server-side → /login/success page shown
 *   Claude calls auth_status → confirms session is active
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { loginWithCredentials } from "./services/auth.js";
import { createSession } from "./services/sessionManager.js";
import { registerAuthTools } from "./tools/authTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerProjectTools } from "./tools/projectTools.js";
import { SERVER_PORT } from "./constants.js";

// ─────────────────────────────────────────────
// SESSION CONTEXT — server-side only, never sent to Claude
// ─────────────────────────────────────────────

let currentSessionId: string | null = null;
const getSessionId = () => currentSessionId;
const setSessionId = (id: string | null) => { currentSessionId = id; };

// ─────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────

const server = new McpServer({ name: "work-mcp-server", version: "1.0.0" });

registerAuthTools(server, getSessionId, setSessionId);
registerNetworkTools(server, getSessionId);
registerProjectTools(server, getSessionId);

// ─────────────────────────────────────────────
// EXPRESS — Login UI + API
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── GET /login ── Serve the login page ────────
app.get("/login", (_req, res) => {
  const alreadyLoggedIn = currentSessionId !== null;
  res.setHeader("Content-Type", "text/html");
  res.send(buildLoginPage(alreadyLoggedIn));
});

// ── POST /api/login ── Handle form submission ──
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ success: false, error: "Email and password are required." });
    return;
  }

  try {
    const { authToken } = await loginWithCredentials(email, password);
    const userId = decodeUserIdFromJwt(authToken);
    const session = await createSession({ user_id: userId, email, auth_token: authToken });
    setSessionId(session.session_id);

    console.log(`[Auth] Login successful: ${email}`);

    res.json({
      success: true,
      email: session.email,
      active_network: session.active_network,
      networks: session.networks,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    console.warn(`[Auth] Login failed for ${email}: ${message}`);
    res.status(401).json({ success: false, error: message });
  }
});

// ── GET /login/success ── Post-login confirmation ──
app.get("/login/success", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildSuccessPage());
});

// ── GET /health ────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", authenticated: currentSessionId !== null });
});

// ── POST /mcp ── MCP HTTP transport (optional) ─
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

async function main() {
  app.listen(SERVER_PORT, () => {
    console.log(`[Server] Login UI → http://localhost:${SERVER_PORT}/login`);
    console.log(`[Server] Health   → http://localhost:${SERVER_PORT}/health`);
  });

  const transport = process.env.TRANSPORT ?? "stdio";
  if (transport === "http") {
    console.log(`[Server] MCP HTTP → http://localhost:${SERVER_PORT}/mcp`);
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error("[Server] MCP stdio transport active");
  }
}

main().catch((err) => {
  console.error("[Server] Fatal:", err);
  process.exit(1);
});

// ─────────────────────────────────────────────
// JWT DECODE HELPER
// ─────────────────────────────────────────────

function decodeUserIdFromJwt(token: string): string {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return decoded.sub ?? decoded.user_id ?? decoded.email ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─────────────────────────────────────────────
// HTML TEMPLATES
// ─────────────────────────────────────────────

function buildLoginPage(alreadyLoggedIn: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Interlincx — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0f;
      --surface: #111118;
      --border: #1e1e2e;
      --border-glow: #2d2d4e;
      --text: #e8e8f0;
      --muted: #6b6b8a;
      --accent: #6c63ff;
      --accent-dim: #3d3980;
      --accent-glow: rgba(108, 99, 255, 0.15);
      --error: #ff6b6b;
      --success: #63ffb4;
      --font-display: 'Syne', sans-serif;
      --font-mono: 'DM Mono', monospace;
    }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-display);
      -webkit-font-smoothing: antialiased;
    }

    body {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
      position: relative;
    }

    /* Ambient background orbs */
    .bg-orb {
      position: fixed;
      border-radius: 50%;
      filter: blur(80px);
      pointer-events: none;
      z-index: 0;
    }
    .bg-orb-1 {
      width: 500px; height: 500px;
      top: -150px; left: -100px;
      background: radial-gradient(circle, rgba(108,99,255,0.12) 0%, transparent 70%);
      animation: drift1 18s ease-in-out infinite alternate;
    }
    .bg-orb-2 {
      width: 400px; height: 400px;
      bottom: -100px; right: -80px;
      background: radial-gradient(circle, rgba(99,255,180,0.07) 0%, transparent 70%);
      animation: drift2 22s ease-in-out infinite alternate;
    }
    .bg-grid {
      position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
      background-size: 40px 40px;
      mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black, transparent);
    }

    @keyframes drift1 {
      from { transform: translate(0, 0) scale(1); }
      to   { transform: translate(40px, 30px) scale(1.1); }
    }
    @keyframes drift2 {
      from { transform: translate(0, 0) scale(1); }
      to   { transform: translate(-30px, -20px) scale(1.05); }
    }

    .card {
      position: relative; z-index: 1;
      width: 420px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 48px 44px 44px;
      box-shadow:
        0 0 0 1px rgba(108,99,255,0.08),
        0 32px 64px rgba(0,0,0,0.5),
        0 0 80px rgba(108,99,255,0.06);
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes cardIn {
      from { opacity: 0; transform: translateY(24px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .logo-row {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 32px;
    }
    .logo-mark {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, var(--accent), #a78bfa);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 800; color: white;
      flex-shrink: 0;
    }
    .logo-name {
      font-size: 15px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text);
    }
    .logo-tag {
      font-family: var(--font-mono);
      font-size: 10px; font-weight: 300;
      color: var(--muted);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-left: auto;
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 4px;
    }

    h1 {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.2;
      color: var(--text);
      margin-bottom: 6px;
    }
    .subtitle {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 300;
      color: var(--muted);
      letter-spacing: 0.04em;
      margin-bottom: 36px;
    }

    /* Already logged in banner */
    .already-banner {
      background: rgba(99,255,180,0.06);
      border: 1px solid rgba(99,255,180,0.2);
      border-radius: 8px;
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--success);
      margin-bottom: 24px;
      display: flex; align-items: center; gap: 8px;
    }
    .already-banner::before { content: '◉'; font-size: 10px; }

    .field {
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }
    input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 400;
      padding: 13px 16px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input::placeholder { color: var(--muted); opacity: 0.5; }
    input:focus {
      border-color: var(--accent-dim);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    input.error-field { border-color: var(--error); }

    .btn {
      width: 100%;
      margin-top: 8px;
      padding: 14px;
      background: var(--accent);
      color: #fff;
      font-family: var(--font-display);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.04em;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
      position: relative;
      overflow: hidden;
    }
    .btn:hover {
      background: #7c74ff;
      box-shadow: 0 0 24px rgba(108,99,255,0.4);
    }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.loading .btn-text { opacity: 0; }
    .btn.loading .btn-spinner { opacity: 1; }

    .btn-inner { position: relative; height: 20px; }
    .btn-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transition: opacity 0.15s; }
    .btn-spinner {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
    }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .error-msg {
      display: none;
      background: rgba(255,107,107,0.08);
      border: 1px solid rgba(255,107,107,0.25);
      border-radius: 8px;
      color: var(--error);
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 12px 14px;
      margin-top: 16px;
    }
    .error-msg.visible { display: flex; align-items: center; gap: 8px; }
    .error-msg::before { content: '✕'; font-size: 10px; flex-shrink: 0; }

    .divider {
      border: none;
      border-top: 1px solid var(--border);
      margin: 28px 0 20px;
    }
    .footer-note {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      text-align: center;
      line-height: 1.6;
    }
    .footer-note strong { color: rgba(255,255,255,0.25); font-weight: 400; }
  </style>
</head>
<body>
  <div class="bg-orb bg-orb-1"></div>
  <div class="bg-orb bg-orb-2"></div>
  <div class="bg-grid"></div>

  <div class="card">
    <div class="logo-row">
      <div class="logo-mark">IX</div>
      <span class="logo-name">Interlincx</span>
      <span class="logo-tag">MCP Agent</span>
    </div>

    <h1>Sign in</h1>
    <p class="subtitle">// credentials stay local — never sent to Claude</p>

    ${alreadyLoggedIn ? `<div class="already-banner">Already authenticated — you can log in again to refresh your session</div>` : ""}

    <div class="field">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" placeholder="you@lincx.la" autocomplete="email" autofocus />
    </div>

    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••••••" autocomplete="current-password" />
    </div>

    <button class="btn" id="submitBtn" onclick="handleLogin()">
      <div class="btn-inner">
        <span class="btn-text">Sign in</span>
        <span class="btn-spinner"><span class="spinner"></span></span>
      </div>
    </button>

    <div class="error-msg" id="errorMsg"></div>

    <hr class="divider" />
    <p class="footer-note">
      This login is served locally by the MCP server.<br/>
      <strong>POST → https://ix-id.lincx.la/auth/login</strong>
    </p>
  </div>

  <script>
    // Allow Enter key to submit
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    async function handleLogin() {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const btn = document.getElementById('submitBtn');
      const errEl = document.getElementById('errorMsg');

      errEl.classList.remove('visible');
      document.getElementById('email').classList.remove('error-field');
      document.getElementById('password').classList.remove('error-field');

      if (!email || !password) {
        showError('Please enter your email and password.');
        if (!email) document.getElementById('email').classList.add('error-field');
        if (!password) document.getElementById('password').classList.add('error-field');
        return;
      }

      btn.disabled = true;
      btn.classList.add('loading');

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const data = await res.json();

        if (data.success) {
          window.location.href = '/login/success';
        } else {
          showError(data.error ?? 'Login failed. Please try again.');
          document.getElementById('password').value = '';
          document.getElementById('password').focus();
        }
      } catch {
        showError('Cannot reach the MCP server. Is it still running?');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }

    function showError(msg) {
      const el = document.getElementById('errorMsg');
      el.textContent = msg;
      el.classList.add('visible');
      // re-add the ::before pseudo-element by keeping the class
      el.style.setProperty('--msg', JSON.stringify(msg));
    }
  </script>
</body>
</html>`;
}

function buildSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Interlincx — Authenticated</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0f; --surface: #111118; --border: #1e1e2e;
      --text: #e8e8f0; --muted: #6b6b8a;
      --success: #63ffb4; --success-dim: rgba(99,255,180,0.08);
      --accent: #6c63ff;
    }
    html, body {
      height: 100%; background: var(--bg); color: var(--text);
      font-family: 'Syne', sans-serif; -webkit-font-smoothing: antialiased;
    }
    body {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; overflow: hidden;
    }
    .bg-orb {
      position: fixed; border-radius: 50%; filter: blur(80px);
      pointer-events: none; z-index: 0;
    }
    .bg-orb-1 {
      width: 500px; height: 500px; top: -150px; left: -100px;
      background: radial-gradient(circle, rgba(99,255,180,0.08) 0%, transparent 70%);
      animation: drift 20s ease-in-out infinite alternate;
    }
    @keyframes drift {
      from { transform: translate(0,0); } to { transform: translate(30px, 20px); }
    }
    .card {
      position: relative; z-index: 1;
      width: 400px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 48px 44px;
      box-shadow: 0 32px 64px rgba(0,0,0,0.5);
      text-align: center;
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes cardIn {
      from { opacity: 0; transform: scale(0.95); }
      to   { opacity: 1; transform: scale(1); }
    }
    .check-ring {
      width: 72px; height: 72px;
      border-radius: 50%;
      background: var(--success-dim);
      border: 1px solid rgba(99,255,180,0.3);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 28px;
      animation: popIn 0.4s 0.1s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes popIn {
      from { opacity: 0; transform: scale(0.6); }
      to   { opacity: 1; transform: scale(1); }
    }
    .check-icon {
      font-size: 28px; color: var(--success);
    }
    h1 {
      font-size: 24px; font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 10px;
    }
    .body-text {
      font-family: 'DM Mono', monospace;
      font-size: 13px; font-weight: 300;
      color: var(--muted); line-height: 1.7;
      margin-bottom: 32px;
    }
    .body-text strong { color: rgba(255,255,255,0.35); font-weight: 400; }
    .instruction-box {
      background: rgba(108,99,255,0.06);
      border: 1px solid rgba(108,99,255,0.2);
      border-radius: 10px;
      padding: 16px 18px;
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      color: rgba(255,255,255,0.5);
      line-height: 1.7;
      text-align: left;
    }
    .instruction-box .cmd {
      color: #a78bfa;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="bg-orb bg-orb-1"></div>
  <div class="card">
    <div class="check-ring">
      <span class="check-icon">✓</span>
    </div>
    <h1>You're signed in</h1>
    <p class="body-text">
      Session established.<br/>
      <strong>You can close this tab</strong> and return to Claude.
    </p>
    <div class="instruction-box">
      Back in Claude, run:<br/>
      <span class="cmd">auth_status</span> → confirm session is active<br/>
      <span class="cmd">network_list</span> → see your networks<br/>
      <span class="cmd">network_switch</span> → select one to start
    </div>
  </div>
</body>
</html>`;
}
