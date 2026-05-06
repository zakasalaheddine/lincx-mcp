import { describe, it, expect } from "vitest";
import { registerClient, getClient } from "../../services/oauth/clients.js";

describe("OAuth clients", () => {
  it("registers and retrieves a client", async () => {
    const c = await registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    expect(c.client_id).toMatch(/^[a-f0-9]{32}$/);
    const fetched = await getClient(c.client_id);
    expect(fetched?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("requires at least one redirect_uri", async () => {
    await expect(registerClient({ redirect_uris: [] })).rejects.toThrow(/redirect_uris/);
  });

  it("rejects non-https redirect_uris (except localhost)", async () => {
    await expect(
      registerClient({ redirect_uris: ["http://example.com/cb"] }),
    ).rejects.toThrow(/https/);
    await expect(
      registerClient({ redirect_uris: ["http://localhost:6274/cb"] }),
    ).resolves.toBeTruthy();
  });

  it("returns null for unknown client_id", async () => {
    expect(await getClient("nope")).toBeNull();
  });
});
