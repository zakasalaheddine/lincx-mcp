/**
 * middleware/requireAccessKey.ts
 *
 * Checks `?key=<token>` against the MCP_ACCESS_KEY env var.
 * Applied to /mcp and /login endpoints in production.
 *
 * In dev (MCP_ACCESS_KEY empty), the middleware is a no-op — useful for local
 * Docker runs without having to set a key.
 */

import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { MCP_ACCESS_KEY } from "../constants.js";

function keyMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function requireAccessKey(req: Request, res: Response, next: NextFunction): void {
  if (!MCP_ACCESS_KEY) {
    // No key configured — gate disabled (dev mode only; prod refuses to boot without it)
    next();
    return;
  }
  const provided = typeof req.query.key === "string" ? req.query.key : undefined;
  if (!provided || !keyMatches(provided, MCP_ACCESS_KEY)) {
    res.status(401).json({ error: "Invalid or missing access key." });
    return;
  }
  next();
}
