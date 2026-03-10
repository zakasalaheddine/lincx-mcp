export const CHARACTER_LIMIT = 25_000;

// 7-day session TTL in Redis / in-memory store
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// Lincx identity server (authentic-server)
export const IDENTITY_SERVER =
  process.env.IDENTITY_SERVER ?? "https://ix-id.lincx.la";

// Your internal Work API base URL
export const WORK_API_BASE_URL =
  process.env.WORK_API_BASE_URL ?? "https://api.example.com";

// Network Service base URL (used to fetch user networks after login)
export const NETWORK_API_BASE_URL =
  process.env.NETWORK_API_BASE_URL ?? "https://network.example.com";

// Redis connection string — leave empty to use in-memory store (dev only)
export const REDIS_URL = process.env.REDIS_URL ?? "";

// Port for the Express HTTP server (login UI + health check)
export const SERVER_PORT = parseInt(process.env.PORT ?? "3000", 10);

// Transport: "stdio" (default, Claude Code) or "http" (remote)
export const TRANSPORT = process.env.TRANSPORT ?? "stdio";
