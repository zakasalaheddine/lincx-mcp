export const CHARACTER_LIMIT = 25_000;

// 7-day session TTL in Redis / in-memory store
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

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

// Transport: "stdio" (default, Claude Code) or "http" (remote)
export const TRANSPORT = process.env.TRANSPORT ?? "stdio";

// NODE_ENV — "production" disables the /dev/* debug routes and enforces MCP_ACCESS_KEY
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_PRODUCTION = NODE_ENV === "production";

// Public base URL used when building login links returned to Claude
// In dev, defaults to http://localhost:<PORT>; in prod, set to the Fly hostname.
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${SERVER_PORT}`;

// Shared access key guarding /mcp and /login in multi-tenant deploys.
// REQUIRED in production. In dev, optional — absence means no gate.
export const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY ?? "";

if (IS_PRODUCTION && !MCP_ACCESS_KEY) {
  console.error("[FATAL] MCP_ACCESS_KEY is required when NODE_ENV=production");
  process.exit(1);
}
