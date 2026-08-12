import { IDENTITY_SERVER } from "../constants.js";

export function buildLoginPage(requestId        )         {
  const safeReq = encodeURIComponent(requestId);
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
    const REQ = "${safeReq}";
    const KEY = new URLSearchParams(window.location.search).get('key') || '';
    const POST_URL = '/api/login?req=' + encodeURIComponent(REQ) + (KEY ? '&key=' + encodeURIComponent(KEY) : '');
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
        if (d.success && d.redirect) { window.location.href = d.redirect; }
        else { showErr(d.error || 'Login failed.'); document.getElementById('password').value = ''; }
      } catch (e) { showErr('Cannot reach server.'); }
      finally { btn.disabled = false; }
    }
    function showErr(msg) { const el = document.getElementById('err'); el.textContent = msg; el.classList.add('show'); }
  </script>
</body>
</html>`;
}

export function buildSuccessPage()         {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#63ffb4;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>You're signed in</h1>
<p>Close this tab and return to your MCP client. Run <code>auth_status</code> to confirm.</p></div></body></html>`;
}

export function buildErrorPage(message        )         {
  const safeMsg = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Login error</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#ff6b6b;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>${safeMsg}</h1>
<p>Return to your MCP client and try again.</p></div></body></html>`;
}
