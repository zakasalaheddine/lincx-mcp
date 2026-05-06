import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "./helpers/testApp.js";
import { wellKnownRouter } from "../routes/wellKnown.js";

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

  it("serves authorization-server metadata", async () => {
    const app = buildTestApp();
    app.use("/.well-known", wellKnownRouter);
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.body.code_challenge_methods_supported).toContain("S256");
  });

  it("serves protected-resource metadata", async () => {
    const app = buildTestApp();
    app.use("/.well-known", wellKnownRouter);
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.body.resource).toMatch(/\/mcp$/);
    expect(res.body.authorization_servers).toBeInstanceOf(Array);
  });
});
