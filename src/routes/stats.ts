/**
 * routes/stats.ts — GET /stats (in-house usage analytics).
 *
 * Gated by STATS_TOKEN (Authorization: Bearer <token>). If STATS_TOKEN is unset
 * the route 404s so it is never accidentally public. Safe to header-gate here:
 * unlike /mcp, /stats is not part of the OAuth discovery path.
 */
import { Router } from "express";
import { STATS_TOKEN, USAGE_EVENT_CAP } from "../constants.js";
import { getEventSink, computeStats } from "../services/usageAnalytics.js";

export const statsRouter: Router = Router();

statsRouter.get("/stats", async (req, res) => {
  if (!STATS_TOKEN) { res.status(404).end(); return; }
  if (req.header("authorization") !== `Bearer ${STATS_TOKEN}`) {
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
