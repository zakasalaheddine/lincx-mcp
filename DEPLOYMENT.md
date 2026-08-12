# Deploying lincx-mcp-server

Production is **Google App Engine Standard** (`nodejs22`) with **Memorystore for
Redis** and **Secret Manager**. There is no build step and no container: App
Engine uploads `src/` and runs `npm start`.

Users get one URL: `https://mcp.lincx.com/mcp`.

Replace `<PROJECT_ID>`, `<REGION>`, `<CONNECTOR_NAME>` and `mcp.lincx.com` with
your values throughout.

---

## Quick start

Assumes `gcloud` is installed and authenticated (`gcloud auth login`) and that
the App Engine application already exists (`gcloud app create --region=<REGION>`).

```bash
gcloud config set project <PROJECT_ID>

# 1. Memorystore (private IP — reachable only from inside the VPC)
gcloud redis instances create lincx-mcp-redis --region=<REGION> --size=1 --redis-version=redis_7_0
gcloud redis instances describe lincx-mcp-redis --region=<REGION> --format='value(host,port,authString)'

# 2. Serverless VPC connector, so App Engine can reach that private IP
gcloud compute networks vpc-access connectors create <CONNECTOR_NAME> \
  --region=<REGION> --network=default --range=10.8.0.0/28

# 3. The two secrets (never in app.yaml — it is committed to git)
printf '%s' "redis://:<AUTH_STRING>@<REDIS_HOST>:6379" \
  | gcloud secrets create lincx-mcp-redis-url --data-file=-
printf '%s' "$(openssl rand -hex 32)" \
  | gcloud secrets create lincx-mcp-stats-token --data-file=-

for S in lincx-mcp-redis-url lincx-mcp-stats-token; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:<PROJECT_ID>@appspot.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# 4. Fill in app.yaml's vpc_access_connector name and PUBLIC_BASE_URL, then check
#    what will actually be uploaded — src/index.js MUST be in this list
gcloud meta list-files-for-upload . | sort | head -30

# 5. Deploy WITHOUT taking traffic, and smoke it
gcloud app deploy app.yaml --no-promote --version=migration-1
V=https://migration-1-dot-<PROJECT_ID>.<REGION>.r.appspot.com
curl -s $V/health
curl -s -i -X POST $V/mcp | grep -i www-authenticate     # 401 + challenge
curl -s -o /dev/null -w '%{http_code}\n' $V/stats        # 401, NOT 404 (see below)
gcloud app logs tail -s default | grep SessionStore       # must say "Using Redis"

# 6. Take traffic
gcloud app services set-traffic default --splits=migration-1=1

# 7. Custom domain
gcloud app domain-mappings create mcp.lincx.com
# add the DNS records it prints, then wait for the managed certificate:
gcloud app domain-mappings describe mcp.lincx.com   # sslSettings.certificateId set
curl -s https://mcp.lincx.com/.well-known/oauth-authorization-server | grep issuer
```

---

## The two checks that catch the failures that actually happen

**1. `/stats` must return 401, not 404.** A 404 means `STATS_TOKEN` did not resolve
from Secret Manager. `src/config/secrets.js` fails open on purpose — an
unreadable secret must not stop the instance becoming healthy — so the only
signal is this status code and one log line:

```bash
gcloud app logs tail -s default | grep '\[Secrets\]'
```

**2. `[SessionStore] Using Redis` must appear in the logs.** If it says
`No REDIS_URL — using in-memory store`, either the VPC connector or the secret is
wrong. **Do not promote traffic in that state** — in-memory sessions log every
user out on every redeploy, and OAuth tokens vanish with them.

**And one config value worth double-checking:** `PUBLIC_BASE_URL` in `app.yaml`
must equal the URL clients actually hit, with **no trailing slash**. It is echoed
as the OAuth `issuer` and inside the `WWW-Authenticate` challenge; a mismatch
breaks the OAuth redirect with no useful client-side error. It is the single most
common deployment failure for this server.

---

## Configuration split

| Where | What |
|---|---|
| `app.yaml` (committed) | `NODE_ENV`, `WORK_API_BASE_URL`, `PUBLIC_BASE_URL`, `IDENTITY_SERVER`, `RESPONSE_SIZE_LIMIT`, `USAGE_EVENT_CAP`, scaling, VPC connector |
| Secret Manager | `REDIS_URL` (`lincx-mcp-redis-url`), `STATS_TOKEN` (`lincx-mcp-stats-token`) |
| `.env` | local development only — never read in production |

Rotating a secret:

```bash
printf '%s' "<NEW_VALUE>" | gcloud secrets versions add lincx-mcp-stats-token --data-file=-
gcloud app deploy app.yaml --quiet   # boot re-reads "latest"
```

---

## Scaling: exactly one instance, and why

`app.yaml` pins `manual_scaling: instances: 1`. This is a **correctness
requirement, not a cost choice**: MCP transport state lives in an in-process `Map`
in `src/server.js`, and Redis holds auth, not connections. Two instances give
intermittent "session not found" as requests land on the wrong one.

Making this horizontally scalable means moving that map into Redis — it is not a
config flag.

Manual scaling also sends `/_ah/start` on instance startup; a non-200 there means
the instance never becomes healthy and the deploy fails without a clear cause.
`src/http/router.js` answers `/_ah/start`, `/_ah/stop` and `/_ah/warmup`.

---

## Instance class

Left at the runtime default until measured. `get_zone_eligible_ad_groups` and
`get_zone_targeting_inventory` scan a whole network's ad groups, campaigns, ads
and creatives in memory, so that is the peak to size against:

```bash
# run the heaviest tool against the largest network from a real client, then:
gcloud app instances list --service=default
# Cloud Console → App Engine → Instances → Memory Usage
gcloud app logs tail -s default | grep -i 'memory\|exceeded\|killed'
```

Set `instance_class` to the smallest class with headroom above the observed peak,
redeploy, and re-run the same tool to confirm there is no OOM restart. A guessed
tier is either an outage or a bill.

---

## Continuous deployment

`cloudbuild.yaml` runs `npm ci` → `npm run lint` → `npm test` → `gcloud app
deploy`. The deploy step only runs if the suite is green.

```bash
gcloud builds triggers create github \
  --repo-name=<REPO> --repo-owner=<ORG> \
  --branch-pattern='^master$' --build-config=cloudbuild.yaml

PROJECT_NUMBER=$(gcloud projects describe <PROJECT_ID> --format='value(projectNumber)')
for ROLE in roles/appengine.deployer roles/appengine.serviceAdmin \
            roles/cloudbuild.serviceAgent roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="$ROLE"
done
```

Prove the gate before trusting it: merge a commit with a deliberately failing
test and confirm the build stops at the test step without deploying. Then revert.

---

## Rollback

Versions are immutable, so rollback is a traffic split — no rebuild:

```bash
gcloud app versions list --service=default
gcloud app services set-traffic default --splits=<PREVIOUS_VERSION>=1
```

Redis is untouched by a rollback, so sessions and OAuth tokens survive it.

---

## Killing access deploy-wide

There is deliberately **no auth gate in front of `/mcp`** — OAuth 2.1 (DCR +
PKCE) is the only identity layer, and `/mcp` must be able to answer
`401 WWW-Authenticate: Bearer resource_metadata=...` to unauthenticated callers.
That is the entire OAuth discovery path. A query-param "access key" would
suppress the RFC-9728 challenge and is dropped by some clients between the
discovery probe and post-OAuth calls.

To cut off access:

```bash
gcloud app versions stop <VERSION> --service=default   # stop serving entirely
# or invalidate every token by flushing Redis:
gcloud redis instances describe lincx-mcp-redis --region=<REGION>   # get host
# then from a VM/pod inside the VPC:
redis-cli -h <REDIS_HOST> -a <AUTH_STRING> FLUSHALL
```

Flushing Redis invalidates every OAuth access/refresh token and every Lincx
session — all clients must log in again.

---

## Logs

```bash
gcloud app logs tail -s default                     # live
gcloud app logs read -s default --limit=200         # recent
gcloud app logs tail -s default | grep '\[MCP\]'    # sessions
gcloud app logs tail -s default | grep '\[OAuth\]'  # login / token flow
```

All application logging goes to **stderr** (`console.error`) — `console.log` is
banned repo-wide, see CLAUDE.md.

---

## Connecting a client

- **claude.ai / Claude Desktop:** Settings → Connectors → add
  `https://mcp.lincx.com/mcp`.
- **Claude Code** or any stdio-only client: bridge it with `mcp-remote`.

```json
{
  "mcpServers": {
    "lincx": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.lincx.com/mcp"]
    }
  }
}
```

The client drives the OAuth dance in a browser; credentials never pass through
Claude.

---

## Local development

Docker is used for **one** thing locally: Redis.

```bash
npm install
npm run dev:local     # http://localhost:5001 (starts the dev Redis via predev)
npm run dev           # same, behind a cloudflared tunnel (needed for connectors)
npm run redis:stop
```

`docker-compose.dev.yml` is standalone and defines only the `redis` service on
host port **6380** (6379 collides with lincx-core's test stack, whose suite
`FLUSHALL`s it). Blank `REDIS_URL` in `.env` to use the in-memory store instead.
