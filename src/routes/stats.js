/**
 * routes/stats.ts — GET /stats (in-house usage analytics).
 *
 * Gated by STATS_TOKEN, accepted EITHER as `Authorization: Bearer <token>`
 * (preferred) OR as a `?token=<token>` query param (so the URL can be opened
 * directly in a browser). If STATS_TOKEN is unset the route 404s so it is never
 * accidentally public. Safe to gate here: unlike /mcp, /stats is not part of the
 * OAuth discovery path.
 *
 * SECURITY NOTE: the `?token=` form puts the secret in the URL, which can land in
 * browser history, proxy/server access logs, and Referer headers. Prefer the
 * Authorization header for anything but quick manual viewing, and rotate the
 * token (change STATS_TOKEN) if a URL leaks.
 */
import { Router } from "express";
import { STATS_TOKEN, USAGE_EVENT_CAP } from "../constants.js";
import { getEventSink, computeStats } from "../services/usageAnalytics.js";

export const statsRouter         = Router();

statsRouter.get("/stats", async (req, res) => {
  if (!STATS_TOKEN) { res.status(404).end(); return; }
  const presented = req.header("authorization") === `Bearer ${STATS_TOKEN}`
    || req.query.token === STATS_TOKEN;
  if (!presented) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, USAGE_EVENT_CAP) : USAGE_EVENT_CAP;
  try {
    const events = await (await getEventSink()).readRecent(limit);
    res.json(computeStats(events));
  } catch (err) {
    console.error("[Stats] read failed:", err instanceof Error ? err.message : String(err));
    res.json(computeStats([])); // degrade to empty, never 500
  }
});
