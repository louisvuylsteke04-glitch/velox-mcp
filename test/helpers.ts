import { createVeloxHandler } from "@/src/server";

const handler = createVeloxHandler();
let nextId = 1;

/** JSON-RPC over the real Streamable HTTP handler, as a 2025-era client. */
export async function rpc(method: string, params: Record<string, unknown> = {}) {
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
  const json = text.trimStart().startsWith("{")
    ? text
    : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
  return { status: res.status, body: JSON.parse(json) };
}

export async function callTool(name: string, args: Record<string, unknown>) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  return body;
}
