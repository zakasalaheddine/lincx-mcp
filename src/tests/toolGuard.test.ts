import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installToolGuards } from "../middleware/toolGuard.js";
import { RESPONSE_SIZE_LIMIT } from "../constants.js";

// The guard logs one JSON metrics line per call to stderr — silence it in tests.
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function guardedTool(result: unknown): any {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  server.registerTool(
    "x",
    { description: "test", inputSchema: z.object({}).strict() },
    async () => result as never,
  );
  installToolGuards(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools["x"];
}

describe("installToolGuards (T2-4 response-size guard)", () => {
  it("passes a normal-sized response through untouched", async () => {
    const tool = guardedTool({ content: [{ type: "text", text: "small" }] });
    const r = await tool.handler({}, { sessionId: "s" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("small");
  });

  it("replaces an oversized response with a structured response_too_large error", async () => {
    const big = "x".repeat(RESPONSE_SIZE_LIMIT + 100);
    const tool = guardedTool({ content: [{ type: "text", text: big }] });
    const r = await tool.handler({}, { sessionId: "s" });

    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe("response_too_large");
    expect(body.limit).toBe(RESPONSE_SIZE_LIMIT);
    expect(body.size).toBeGreaterThan(RESPONSE_SIZE_LIMIT);
    expect(body.hint).toMatch(/pagination|field|filter/i);
  });

  it("propagates handler errors (and does not swallow them as oversized)", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.registerTool(
      "boom",
      { description: "test", inputSchema: z.object({}).strict() },
      async () => { throw new Error("kaboom"); },
    );
    installToolGuards(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools["boom"];
    await expect(tool.handler({}, { sessionId: "s" })).rejects.toThrow("kaboom");
  });
});
