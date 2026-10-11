import { describe, expect, it } from "vitest";
import { rpc } from "./helpers";
import { SERVER_VERSION } from "@/src/branding";

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
