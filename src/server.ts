import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./branding";
import { registerPing } from "./tools/ping";

/**
 * Every tool, prompt and resource is registered here. The server is
 * stateless: nothing is stored between requests and no request body is
 * ever logged.
 */
export function registerVelox(server: McpServer): void {
  registerPing(server);
}

export function createVeloxHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler(registerVelox, {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    verboseLogs: false,
  });
}
