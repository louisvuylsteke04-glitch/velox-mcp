import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { APP_NAME, SERVER_VERSION } from "../branding";

const PingOutput = z.object({
  ok: z.literal(true),
  name: z.string(),
  version: z.string(),
});

/**
 * Health check. Proves the connector is reachable and reports the server
 * version, so a user (or Claude) can tell which engine answered.
 */
export function registerPing(server: McpServer): void {
  server.registerTool(
    "velox_ping",
    {
      title: `${APP_NAME} status`,
      description: `Check that the ${APP_NAME} coaching server is reachable and see its version. Takes no input and touches no data.`,
      inputSchema: z.object({}),
      outputSchema: PingOutput,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const output = { ok: true as const, name: APP_NAME, version: SERVER_VERSION };
      return {
        content: [{ type: "text", text: `${APP_NAME} is reachable. Engine version ${SERVER_VERSION}.` }],
        structuredContent: output,
      };
    },
  );
}
