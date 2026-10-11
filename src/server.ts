import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "./branding";
import { registerPing } from "./tools/ping";
import { registerAnalyzeTraining } from "./tools/analyze-training";
import { registerZonesAndPaces } from "./tools/zones-and-paces";
import { registerPredictRace } from "./tools/predict-race";
import { registerBuildPlan } from "./tools/build-plan";
import { registerGetSessions } from "./tools/get-sessions";
import { registerLogRun } from "./tools/log-run";
import { registerAdaptPlan } from "./tools/adapt-plan";
import { registerReviewWeek } from "./tools/review-week";
import { registerCoach } from "./coach";
import { SERVER_INSTRUCTIONS } from "./content/workflows";

/**
 * Every tool, prompt and resource is registered here. The server is
 * stateless: nothing is stored between requests and no request body is
 * ever logged.
 */
export function registerVelox(server: McpServer): void {
  registerPing(server);
  registerAnalyzeTraining(server);
  registerZonesAndPaces(server);
  registerPredictRace(server);
  registerBuildPlan(server);
  registerGetSessions(server);
  registerLogRun(server);
  registerAdaptPlan(server);
  registerReviewWeek(server);
  registerCoach(server);
}

export function createVeloxHandler(): (request: Request) => Promise<Response> {
  return createMcpHandler(registerVelox, {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
    verboseLogs: false,
  });
}
