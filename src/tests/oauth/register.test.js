import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { oauthRegisterRouter } from "../../routes/oauthRegister.js";

describe("POST /oauth/register", () => {
  const app = express();
  app.use(express.json());
  app.use("/oauth", oauthRegisterRouter);

  it("registers a client", async () => {
    const res = await request(app).post("/oauth/register").send({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("rejects missing redirect_uris", async () => {
    const res = await request(app).post("/oauth/register").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });
});
