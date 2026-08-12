// Hard ceiling (in CHARACTERS of serialized JSON) on a single tool response,
// enforced by the toolGuard middleware. Responses above this are dropped and
// replaced with a structured `response_too_large` error so one heavy payload can't
// wedge the event loop / saturate the SSE stream. Tunable via RESPONSE_SIZE_LIMIT
// (e.g. raise it if your client tolerates larger tool results); floored at 5k so it
// can't be set uselessly small. Character count is a rough token proxy (~3–4 chars/token).
export const RESPONSE_SIZE_LIMIT = Math.max(5_000, Number(process.env.RESPONSE_SIZE_LIMIT) || 30_000);

// Soft per-response budget the serializers (listEnvelopeToText / fitEntityToText)
// aim to stay under by dropping items / eliding fields — derived to sit ~5k below
// the hard ceiling so well-formed responses never trip the guard.
export const CHARACTER_LIMIT = Math.max(1_000, RESPONSE_SIZE_LIMIT - 5_000);

// 7-day session TTL in Redis / in-memory store
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// How often the in-memory store sweeps expired entries (dev only; Redis expires
// keys itself). Each key already carries an absolute TTL — the sweep evicts past
// expiry proactively instead of only lazily on the next access.
export const MEMORY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Lincx identity server (authentic-server)
export const IDENTITY_SERVER =
  process.env.IDENTITY_SERVER ?? "https://ix-id.lincx.la";

// Work API base URL — all requests go here, including network discovery
// Networks are multi-tenant via ?networkId=<id> query param on every request
export const WORK_API_BASE_URL =
  process.env.WORK_API_BASE_URL ?? "http://localhost:3050";

// Redis connection string — leave empty to use in-memory store (dev only)
export const REDIS_URL = process.env.REDIS_URL ?? "";

// Port for the Express HTTP server (login UI + MCP HTTP transport)
export const SERVER_PORT = parseInt(process.env.PORT ?? "5001", 10);

// NODE_ENV — "production" disables the /dev/* debug routes
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_PRODUCTION = NODE_ENV === "production";

// Public base URL used when building login links returned to Claude
// In dev, defaults to http://localhost:<PORT>; in prod, set to the Coolify domain.
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${SERVER_PORT}`;

// ── OAuth TTLs ───────────────────────────────────────────────────────────────
export const OAUTH_AUTH_CODE_TTL_SECONDS = 60;
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const OAUTH_CLIENT_TTL_SECONDS = 60 * 60 * 24 * 90;

// ── Usage analytics ──────────────────────────────────────────────────────────
// Shared secret guarding GET /stats. Empty → /stats returns 404 (disabled).
export const STATS_TOKEN = process.env.STATS_TOKEN ?? "";

// Retention: max UsageEvents kept in the capped log (also the default /stats window).
export const USAGE_EVENT_CAP = parseInt(process.env.USAGE_EVENT_CAP ?? "50000", 10);
