/**
 * middleware/rateLimit.ts
 *
 * Two configs:
 *   loginLimiter — /api/login — 10 req/min per IP
 *   mcpLimiter   — /mcp       — 120 req/min per mcp-session-id (IP fallback)
 */

import rateLimit from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again in a minute." },
});

export const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.header("mcp-session-id") ?? req.ip ?? "unknown";
  },
  message: { error: "Rate limit exceeded for this MCP session." },
});
