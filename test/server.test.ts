import { describe, expect, it } from "vitest";
import { createVeloxHandler } from "@/src/server";
import { SERVER_VERSION } from "@/src/branding";

/**
 * Drives the real HTTP handler the way a 2025-era client (Claude.ai, Claude
 * Desktop, ChatGPT today) does: JSON-RPC over Streamable HTTP, statelessly.
 */
const handler = createVeloxHandler();
let nextId = 1;

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await handler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  const text = await res.text();
  // Responses may come back as plain JSON or as a single SSE event.
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
  return { status: res.status, body: JSON.parse(json) };
}

describe("velox MCP server", () => {
  it("initializes with the server name and version", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.result.serverInfo).toMatchObject({ name: "velox", version: SERVER_VERSION });
  });

  it("lists velox_ping as a read-only tool", async () => {
    const { body } = await rpc("tools/list");
    const ping = body.result.tools.find((t: { name: string }) => t.name === "velox_ping");
    expect(ping).toBeDefined();
    expect(ping.annotations.readOnlyHint).toBe(true);
  });

  it("answers velox_ping with text and structured content", async () => {
    const { body } = await rpc("tools/call", { name: "velox_ping", arguments: {} });
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent).toEqual({ ok: true, name: "Vēlox", version: SERVER_VERSION });
    expect(body.result.content[0].text).toContain("reachable");
  });

  it("rejects an unknown tool without a stack trace", async () => {
    const { body } = await rpc("tools/call", { name: "nope", arguments: {} });
    const message = JSON.stringify(body);
    expect(message).not.toMatch(/at .*\.(ts|js):\d+/);
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});
