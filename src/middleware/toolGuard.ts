/**
 * middleware/toolGuard.ts
 *
 * Central wrapper installed over every registered MCP tool handler. It runs on
 * every tool invocation and provides two stability protections:
 *
 *   1. Response size guard — measures JSON.stringify(result).length and, if it
 *      exceeds RESPONSE_SIZE_LIMIT, drops the payload and returns a structured
 *      `response_too_large` error instead. This stops a single oversized response
 *      from blocking the event loop / saturating the SSE stream.
 *
 *   2. Per-tool timing + size logging — a one-line JSON metrics record per call
 *      (tool name, duration, response bytes, param KEYS only, status).
 *
 * NOTE ON LOGGING CHANNEL: all logging here goes to stderr via console.error,
 * never console.log (the project-wide rule — see CLAUDE.md). Param VALUES
 * are never logged (PII / secret risk); only Object.keys(params).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESPONSE_SIZE_LIMIT } from "../constants.js";
import { recordEvent, classifyResult, classifyErrorKind } from "../services/usageAnalytics.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; [k: string]: unknown };
type ToolHandler = (...args: unknown[]) => Promise<unknown>;

interface RegisteredTool {
  handler: ToolHandler;
}

function oversizedResult(size: number): ToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "response_too_large",
        size,
        limit: RESPONSE_SIZE_LIMIT,
        hint: "Use pagination (limit/offset), field selection, or narrower filters to reduce response size.",
      }),
    }],
    isError: true,
  };
}

function logMetrics(record: {
  tool: string;
  duration_ms: number;
  response_chars: number;
  params_keys: string[];
  status: "ok" | "error";
}): void {
  // stderr only — see file header.
  console.error(JSON.stringify(record));
}

/**
 * Wrap every handler in server._registeredTools with the size guard + metrics.
 * Call once, after all register*Tools(server) calls have run.
 */
export function installToolGuards(server: McpServer): void {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

  for (const [name, tool] of Object.entries(registered)) {
    const original = tool.handler;
    if (typeof original !== "function") continue; // skip task-style handlers

    tool.handler = async (...handlerArgs: unknown[]): Promise<unknown> => {
      // The SDK calls handler(args, extra) for tools with an input schema (all of
      // ours use z.object). The first arg is the validated params object.
      const first = handlerArgs[0];
      const params = (handlerArgs.length > 1 && first && typeof first === "object")
        ? (first as Record<string, unknown>)
        : {};
      const paramsKeys = Object.keys(params);
      const extra = handlerArgs[1] as { sessionId?: string } | undefined;
      const mcpSessionId = extra?.sessionId;
      const start = Date.now();

      let result: unknown;
      try {
        result = await original(...handlerArgs);
      } catch (err) {
        const duration = Date.now() - start;
        logMetrics({ tool: name, duration_ms: duration, response_chars: 0, params_keys: paramsKeys, status: "error" });
        recordEvent({ type: "tool", name, status: "error", error_kind: classifyErrorKind(err instanceof Error ? err.message : String(err)), duration_ms: duration, response_chars: 0, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
        throw err;
      }

      let serialized = "";
      try {
        serialized = JSON.stringify(result) ?? "";
      } catch {
        serialized = "";
      }
      const bytes = serialized.length;
      const duration = Date.now() - start;

      if (bytes > RESPONSE_SIZE_LIMIT) {
        console.error(`[ToolGuard] ${name} response too large: ${bytes} chars (limit ${RESPONSE_SIZE_LIMIT}); params=[${paramsKeys.join(",")}]`);
        logMetrics({ tool: name, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, status: "error" });
        recordEvent({ type: "tool", name, status: "error", error_kind: "response_too_large", duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
        return oversizedResult(bytes);
      }

      const { status, error_kind } = classifyResult(result);
      logMetrics({ tool: name, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, status });
      recordEvent({ type: "tool", name, status, error_kind, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
      return result;
    };
  }
}
