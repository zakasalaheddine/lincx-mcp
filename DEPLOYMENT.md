# Deploying lincx-mcp-server

## Quick start (GCE VM, ~30 min)

Replace `<PROJECT>`, `mcp.lincx.com`, `https://api.lincx.com`. Run in order.

```bash
# 1. VM + static IP + firewall
gcloud config set project <PROJECT>
gcloud compute addresses create lincx-mcp-ip --region=us-central1
gcloud compute instances create lincx-mcp \
  --zone=us-central1-a --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB --address=lincx-mcp-ip --tags=lincx-mcp
gcloud compute firewall-rules create lincx-mcp-web --allow=tcp:80,tcp:443 --target-tags=lincx-mcp

# 2. Get the IP, create an A record for mcp.lincx.com pointing at it, wait for:
gcloud compute addresses describe lincx-mcp-ip --region=us-central1 --format='value(address)'
dig +short mcp.lincx.com

# 3. Install Docker on the VM
gcloud compute ssh lincx-mcp --zone=us-central1-a
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit

# 4. Clone + configure (back on the VM)
gcloud compute ssh lincx-mcp --zone=us-central1-a
git clone https://github.com/Interlincx/lincx-mcp.git && cd lincx-mcp
cat > .env <<EOF
WORK_API_BASE_URL=https://api.lincx.com
PUBLIC_BASE_URL=https://mcp.lincx.com
REDIS_PASSWORD=$(openssl rand -hex 24)
STATS_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 .env

# 5. Start
docker compose up -d --build
curl http://127.0.0.1:3000/health

# 6. TLS
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
printf 'mcp.lincx.com {\n    reverse_proxy 127.0.0.1:3000\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 7. Verify — /health returns ok, /mcp returns 401, issuer matches the domain
curl https://mcp.lincx.com/health
curl -i https://mcp.lincx.com/mcp | head -3
curl -s https://mcp.lincx.com/.well-known/oauth-authorization-server | jq .issuer

# 8. Redeploy later
cd lincx-mcp && git pull && docker compose up -d --build
```

Done. Give clients `https://mcp.lincx.com/mcp`.

Three rules that must hold on any platform: **one instance only**, **`PUBLIC_BASE_URL`
= the exact public URL**, **no auth gate in front of `/mcp`**. Why, and every other
target, below.

---

This service is a single Node.js container that speaks HTTP on one port. It runs
anywhere Docker runs — a VM, Cloud Run, GKE, ECS, Render, Coolify. Nothing in the
code is tied to a platform.

Read **[1. The deployment contract](#1-the-deployment-contract)** once. It is the
whole spec: satisfy those seven requirements on any platform and the service works.
Sections 2–4 are copy-paste recipes for the common targets.

| Path | When |
|------|------|
| **[2. GCE VM + Docker Compose](#2-recommended-gce-vm--docker-compose)** ← recommended | Default. One VM, app + Redis + TLS, ~30 min, no VPC plumbing. |
| **[3. Cloud Run](#3-cloud-run-managed-alternative)** | You want managed/no-VM-to-patch. Costs more and needs the single-instance flags below. |
| **[4. Any other platform](#4-any-other-platform)** | GKE, ECS, Coolify, Render, on-prem — the contract as a checklist. |

---

## 1. The deployment contract

### R1 — Exactly one running instance (or guaranteed sticky routing)

**This is the requirement that breaks deployments silently. Read it.**

MCP transport state lives in process memory (`transports = new Map()`,
`src/index.ts:137`). Redis holds *authentication* — OAuth tokens and Lincx sessions —
but **not** the live MCP connection. So with two instances behind a round-robin load
balancer, a client's `mcp-session-id` resolves on instance A and 404s on instance B:
tools fail intermittently, and a smoke test of one request will not catch it.

Run **one** instance. Every recipe below pins that explicitly. If you ever need
more, the fix is guaranteed session affinity on `mcp-session-id` (not best-effort
cookie stickiness) or moving the transport map into Redis — a code change, not a
config change.

Corollary: a restart or redeploy drops live MCP connections. Clients re-initialize
automatically (they are told to, `src/index.ts:189`) and stay logged in — OAuth
tokens are in Redis. It is a blip, not a re-auth. But it means **scale-to-zero is a
bad fit**: every cold start is that blip.

### R2 — Redis, and it must persist

Sessions, OAuth clients, access/refresh tokens and the usage log all live in Redis.
Without `REDIS_URL` the server falls back to an in-memory store — fine for local dev,
**never in production**: every restart logs out every user and invalidates every
registered MCP client.

Use AOF persistence on a durable volume (the bundled `redis:7-alpine` service already
does: `--appendonly yes` + the `redis-data` volume). Any Redis ≥ 6 works — bundled,
Memorystore, Upstash, Redis Cloud. TLS URLs (`rediss://`) are supported.

### R3 — HTTPS, and `PUBLIC_BASE_URL` must equal the URL clients hit

The app serves plain HTTP. Terminate TLS in front of it (Caddy, nginx, a cloud LB,
the platform's built-in proxy). MCP clients require `https`.

`PUBLIC_BASE_URL` is what the server stamps into OAuth redirects and the
`/.well-known/oauth-*` discovery documents. If it does not exactly match the public
URL, login redirects land on the wrong host and the OAuth dance fails with no useful
error. No trailing slash.

> **Chicken-and-egg:** on platforms that generate the URL at deploy time (Cloud Run,
> Coolify), you cannot know it before the first deploy. Either map a custom domain
> first, or deploy → read the URL → set `PUBLIC_BASE_URL` → redeploy. See
> [§3 step 5](#3-cloud-run-managed-alternative).

### R4 — Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `WORK_API_BASE_URL` | **Yes** | — | Base URL for every Work API call, e.g. `https://api.lincx.com`. |
| `PUBLIC_BASE_URL` | **Yes** in prod | `http://localhost:<PORT>` | Public https URL of this service. See R3. |
| `REDIS_URL` | **Yes** in prod | *(empty → in-memory)* | e.g. `redis://default:<pass>@redis:6379`. See R2. |
| `NODE_ENV` | Recommended | `development` | Set to `production` — disables the `/dev/*` debug routes. |
| `PORT` | No | `5001` (`3000` in the containers) | HTTP port. Cloud platforms usually inject this. |
| `IDENTITY_SERVER` | No | `https://ix-id.lincx.la` | Lincx login server. Override only if it moves. |
| `STATS_TOKEN` | No | *(unset)* | Gates `GET /stats`. **Unset → `/stats` returns 404** and analytics are unreadable — by design, so it is never accidentally public. Generate with `openssl rand -hex 32`. |
| `USAGE_EVENT_CAP` | No | `50000` | Usage events kept in Redis (~10–15 MB). |
| `RESPONSE_SIZE_LIMIT` | No | `30000` | Per-response character ceiling. |

`.env.example` documents all of them with inline notes.

### R5 — Health check: `GET /health`

Unauthenticated, returns `200 {"status":"ok",...}`. Use it for liveness/readiness/startup
probes. Everything else requires auth.

### R6 — Exactly one proxy hop

`app.set("trust proxy", 1)` (`src/index.ts:92`) tells Express to trust one
`X-Forwarded-For` hop. That is correct for the recipes below (one reverse proxy in
front). With **zero** proxies or **two** (e.g. Cloudflare → LB → app), rate limiting
keys on the wrong IP — adjust that number to the real hop count.

### R7 — One port, HTTP only

No stdio transport, no second port, no background workers, no writable filesystem
needed (the container runs as non-root `USER node`). Outbound access required to
`WORK_API_BASE_URL` and `IDENTITY_SERVER`. The service must be **publicly reachable**
without platform-level auth in front — MCP clients authenticate themselves via OAuth
against this server (`/mcp` answers `401 + WWW-Authenticate` to start that dance).
Putting IAM/basic-auth/an access key in front breaks every browser-based client.

---

## 2. Recommended: GCE VM + Docker Compose

One `e2-small` VM runs the app, Redis and TLS. Satisfies R1 by construction (one
container), no VPC connectors, no cold starts. ~30 minutes.

### 2.1 Create the VM and a static IP

```bash
gcloud config set project <YOUR_PROJECT>

gcloud compute addresses create lincx-mcp-ip --region=us-central1

gcloud compute instances create lincx-mcp \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --address=lincx-mcp-ip \
  --tags=lincx-mcp

gcloud compute firewall-rules create lincx-mcp-web \
  --allow=tcp:80,tcp:443 \
  --target-tags=lincx-mcp \
  --description="HTTP/HTTPS to lincx-mcp"

gcloud compute addresses describe lincx-mcp-ip --region=us-central1 --format='value(address)'
```

Port 3000 is **not** opened — the app binds to `127.0.0.1` and only the local reverse
proxy reaches it.

### 2.2 Point DNS at it

Create an `A` record for the hostname you will use (e.g. `mcp.lincx.com`) pointing at
the static IP above. Wait for it to resolve — Caddy needs it for the certificate:

```bash
dig +short mcp.lincx.com
```

### 2.3 Install Docker on the VM

```bash
gcloud compute ssh lincx-mcp --zone=us-central1-a

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit    # re-login for the group to take effect
```

### 2.4 Clone and configure

```bash
gcloud compute ssh lincx-mcp --zone=us-central1-a

git clone https://github.com/Interlincx/lincx-mcp.git
cd lincx-mcp

cat > .env <<EOF
WORK_API_BASE_URL=https://api.lincx.com
PUBLIC_BASE_URL=https://mcp.lincx.com
REDIS_PASSWORD=$(openssl rand -hex 24)
STATS_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

`docker-compose.yml` reads those four values. Everything else has a sane default,
and a missing required value fails the deploy immediately instead of booting a broken
server.

> Private repo? Use a [GitHub deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
> for the VM, or build the image elsewhere and pull it.

### 2.5 Start the stack

```bash
docker compose up -d --build
docker compose ps           # both services healthy
curl http://127.0.0.1:3000/health
```

> `docker-compose.dev.yml` is a local-dev overlay and is **not** auto-merged — plain
> `docker compose up` on the server uses only `docker-compose.yml`, which is what you
> want. (It is deliberately not named `docker-compose.override.yml`: that name
> auto-merges and would silently replace `PUBLIC_BASE_URL` and `REDIS_URL` with
> localhost literals.)

### 2.6 TLS with Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile <<'EOF'
mcp.lincx.com {
    reverse_proxy 127.0.0.1:3000
}
EOF

sudo systemctl reload caddy
```

Caddy fetches and renews the Let's Encrypt certificate on its own. That is the whole
TLS story — one hop in front of the app, matching R6.

### 2.7 Verify → [§5](#5-verify-any-platform)

### 2.8 Redeploying

```bash
gcloud compute ssh lincx-mcp --zone=us-central1-a
cd lincx-mcp && git pull && docker compose up -d --build
```

Sessions survive: Redis writes to the `redis-data` volume, which the rebuild does not
touch. Live MCP connections re-initialize (R1).

---

## 3. Cloud Run (managed alternative)

Managed, but three things need care: the single-instance pin (R1), no scale-to-zero,
and Redis is a separate paid service. Expect a higher standing cost than §2.

### 3.1 Build and push the image

```bash
gcloud config set project <YOUR_PROJECT>
gcloud artifacts repositories create lincx --repository-format=docker --location=us-central1

gcloud builds submit --tag us-central1-docker.pkg.dev/<YOUR_PROJECT>/lincx/lincx-mcp:latest
```

### 3.2 Provide Redis (pick one)

**A — External managed Redis** (Upstash, Redis Cloud, …). Simplest: no VPC config at
all, just a `rediss://` URL. Use a provider region close to the Cloud Run region.

**B — Memorystore for Redis.** Private-IP only, so Cloud Run needs Direct VPC egress
(or a Serverless VPC Access connector). This is a standing hourly cost plus extra
setup:

```bash
gcloud redis instances create lincx-mcp-redis --size=1 --region=us-central1 --tier=basic
gcloud redis instances describe lincx-mcp-redis --region=us-central1 --format='value(host)'
```

Then add `--network=<vpc> --subnet=<subnet> --vpc-egress=private-ranges-only` to the
deploy below. Enable AUTH on the instance and put the credential in the URL.

### 3.3 First deploy

```bash
gcloud run deploy lincx-mcp \
  --image us-central1-docker.pkg.dev/<YOUR_PROJECT>/lincx/lincx-mcp:latest \
  --region us-central1 \
  --port 3000 \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --no-cpu-throttling \
  --timeout 3600 \
  --set-env-vars '^|^NODE_ENV=production|WORK_API_BASE_URL=https://api.lincx.com|REDIS_URL=rediss://default:<pass>@<host>:6379|PUBLIC_BASE_URL=https://placeholder.invalid'
```

`--set-env-vars` is a **dict** flag, not a repeatable one — passing it twice keeps
only the last, silently dropping the rest. Set every variable in one flag. The
`^|^` prefix switches the separator to `|` so a comma inside a Redis password or URL
does not split the list.

Why each non-obvious flag:

- `--min-instances 1 --max-instances 1` — R1. **Do not raise `max-instances`.** One
  instance is the correctness bound, not a cost setting; `min 1` avoids cold-start
  churn on every idle period.
- `--no-cpu-throttling` — CPU stays allocated between requests, so the long-lived
  `GET /mcp` stream is not frozen mid-response.
- `--timeout 3600` — MCP streams are long-lived; the default 5 minutes cuts them.
  (Verify the current maximum for your region — it has changed over time.)
- `--allow-unauthenticated` — R7. Cloud Run IAM in front breaks the MCP OAuth flow.
  The service authenticates its own callers.

Note: a Cloud Run revision rollout briefly runs the old and new revisions together —
the same two-instance window R1 warns about, for a few seconds per deploy.

Secrets (`REDIS_URL`, `STATS_TOKEN`) are better held in Secret Manager and mounted
with `--set-secrets` than passed as plain env vars.

### 3.4 Read the URL and fix `PUBLIC_BASE_URL`

```bash
gcloud run services describe lincx-mcp --region us-central1 --format='value(status.url)'
# → https://lincx-mcp-xxxxxxxx-uc.a.run.app

gcloud run services update lincx-mcp --region us-central1 \
  --update-env-vars PUBLIC_BASE_URL=https://lincx-mcp-xxxxxxxx-uc.a.run.app
```

`--update-env-vars` (not `--set-env-vars`) — the latter **replaces** the whole env
map and would drop `WORK_API_BASE_URL` and `REDIS_URL`.

R3 in practice: it must be the *exact* URL clients use. If you later map a custom
domain (`gcloud beta run domain-mappings create`), update `PUBLIC_BASE_URL` to that
domain and tell clients to use it — one canonical URL, not both.

### 3.5 Verify → [§5](#5-verify-any-platform)

---

## 4. Any other platform

The contract as a checklist. Anything satisfying all seven works — GKE, ECS, Fly,
Render, Coolify, a bare VM elsewhere.

- [ ] Build `Dockerfile` (multi-stage, non-root, `HEALTHCHECK` included). Container
      listens on `PORT`, default `3000`.
- [ ] **Exactly one replica** — k8s `replicas: 1` with `strategy: Recreate`, ECS
      `desiredCount: 1`, no autoscaler. (R1)
- [ ] Redis reachable at `REDIS_URL`, with persistence. (R2)
- [ ] TLS terminated in front; `PUBLIC_BASE_URL` = the public https URL, no trailing
      slash. (R3)
- [ ] Env vars from the R4 table set.
- [ ] Liveness/readiness probe on `GET /health`. (R5)
- [ ] Proxy hop count matches `trust proxy` — one by default. (R6)
- [ ] No platform-level auth in front of `/mcp`. (R7)

**Kubernetes note:** a `Deployment` with `replicas: 1` and the default `RollingUpdate`
briefly runs two pods, which violates R1 during rollouts — use
`strategy: { type: Recreate }`.

**Coolify:** already supported — deploy `docker-compose.coolify.yml` (set the compose
file path on the resource). It uses Coolify's `SERVICE_FQDN_APP_3000` /
`SERVICE_PASSWORD_REDIS` magic variables to generate the domain, wire
`PUBLIC_BASE_URL`, and provision the Redis password automatically; you set only
`WORK_API_BASE_URL`. The domain is set **per service** on a Compose resource (the
`app` service's Domains field), not in a top-level field.

---

## 5. Verify (any platform)

```bash
curl https://mcp.lincx.com/health
# {"status":"ok","active_sessions":0,...}

curl -i https://mcp.lincx.com/mcp
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer resource_metadata="https://mcp.lincx.com/.well-known/oauth-protected-resource"

curl -s https://mcp.lincx.com/.well-known/oauth-authorization-server | jq .issuer
# "https://mcp.lincx.com"        ← must match the URL you just called
```

The `401` is **success**, not a failure — it is the OAuth challenge clients discover
from. The `issuer` check is the real test of R3.

Then connect a client: point Claude Desktop / claude.ai / Claude Code at
`https://mcp.lincx.com/mcp`, sign in with Lincx credentials in the browser window it
opens, and run `network_list` → `network_switch`.

---

## 6. Day-two operations

**Redeploy.** Rebuild and restart the single instance (§2.8 / `gcloud run deploy`).
Users stay logged in; live MCP connections re-initialize.

**Revoke everyone's access.** Stop the app, or flush Redis — every OAuth access and
refresh token dies with it:

```bash
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" FLUSHALL   # nuclear: all sessions
```

**Count active sessions.**

```bash
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'lincx:session:*' | wc -l
```

**Usage analytics.** `GET /stats` with `Authorization: Bearer $STATS_TOKEN`. Prefer
the header over `?token=` — the query form leaks the secret into logs and Referer
headers. Rotate `STATS_TOKEN` if a URL leaks.

**Logs.** `docker compose logs -f app`, or Cloud Logging. All application logging goes
to **stderr** by design.

**Backups.** The only durable state is Redis (`redis-data` volume) — sessions and
OAuth tokens. Losing it logs everyone out; nothing business-critical is stored there,
so a snapshot schedule is optional.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Login redirect lands on the wrong host, or "invalid redirect_uri" | `PUBLIC_BASE_URL` ≠ the URL clients hit (R3) | Set it to the exact public URL, no trailing slash, and redeploy. Check with the `issuer` curl in §5. |
| Tools fail *intermittently*, "session not found", clients keep re-initializing | More than one instance (R1) | Pin to one instance. Cloud Run: `--max-instances 1`. k8s: `replicas: 1` + `strategy: Recreate`. |
| Everyone logged out after a restart | No `REDIS_URL`, or Redis has no persistent volume (R2) | Set `REDIS_URL`; mount a durable volume. |
| "Unknown client_id" on every authorize | The Redis holding `oauth:client:*` was flushed or swapped | Clients re-register automatically; if it recurs, another workload is sharing/flushing that Redis. Give this service its own. |
| `/mcp` returns 200 HTML or a platform login page instead of `401` | Platform auth in front (R7) | Remove IAM / access-key / basic-auth gating on `/mcp`. |
| `/stats` returns 404 | `STATS_TOKEN` unset — intended (R4) | Set `STATS_TOKEN` and redeploy. |
| Rate limiting blocks everyone, or never triggers | Proxy hop count ≠ `trust proxy` value (R6) | Set the number in `src/index.ts:92` to the real hop count. |
| Deploy fails: `WORK_API_BASE_URL is required` | Compose guard did its job | Set it in `.env` / the platform's env config. |
| Tools return auth errors after ~30 days | Lincx JWT expired (not the OAuth token) | Re-run `auth_login` — the Lincx JWT does not auto-refresh. |
