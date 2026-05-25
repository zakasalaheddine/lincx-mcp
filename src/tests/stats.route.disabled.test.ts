import { describe, it, expect } from "vitest";
import request from "supertest";

// Unset BEFORE importing constants/route (constants read env at load).
delete process.env.STATS_TOKEN;

const { buildTestApp } = await import("./helpers/testApp.js");
const { statsRouter } = await import("../routes/stats.js");

describe("GET /stats when STATS_TOKEN is unset", () => {
  it("404s (endpoint disabled, never accidentally public)", async () => {
    const app = buildTestApp();
    app.use(statsRouter);
    const res = await request(app).get("/stats").set("Authorization", "Bearer anything");
    expect(res.status).toBe(404);
  });
});
