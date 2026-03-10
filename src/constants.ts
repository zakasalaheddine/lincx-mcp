export const CHARACTER_LIMIT = 25_000;

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// No token refresh buffer needed — authentic JWTs are long-lived (default 30d)
// and there's no refresh endpoint. Re-login is required when they expire.

export const IDENTITY_SERVER = process.env.IDENTITY_SERVER ?? "https://ix-id.lincx.la";

export const WORK_API_BASE_URL = process.env.WORK_API_BASE_URL ?? "https://api.example.com";
export const NETWORK_API_BASE_URL = process.env.NETWORK_API_BASE_URL ?? "https://network.example.com";

export const REDIS_URL = process.env.REDIS_URL ?? "";

export const SERVER_PORT = parseInt(process.env.PORT ?? "3000", 10);

// How long the "pending login" state lives before expiring (user opened browser but didn't submit)
export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
