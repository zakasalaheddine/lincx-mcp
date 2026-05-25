import { describe, it, expect } from "vitest";
import request from "supertest";

// Set the token BEFORE importing constants/route (constants read env at load).
process.env.STATS_TOKEN = "secret-xyz";

const { buildTestApp } = await import("./helpers/testApp.js");
const { statsRouter } = await import("../routes/stats.js");

function app() {
  const a = buildTestApp();
  a.use(statsRouter);
  return a;
}

describe("GET /stats", () => {
  it("401s without the right bearer token", async () => {
    const res = await request(app()).get("/stats");
    expect(res.status).toBe(401);
  });

  it("returns the stats payload with the right token", async () => {
    const res = await request(app()).get("/stats").set("Authorization", "Bearer secret-xyz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("window");
    expect(res.body).toHaveProperty("tools");
    expect(res.body).toHaveProperty("users");
    expect(res.body).toHaveProperty("errors");
    expect(res.body).toHaveProperty("sequences");
  });
});
