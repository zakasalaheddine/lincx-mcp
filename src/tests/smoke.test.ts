import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "./helpers/testApp.js";

describe("smoke", () => {
  it("test harness boots", async () => {
    const app = buildTestApp();
    app.get("/ok", (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
