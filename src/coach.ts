/**
 * The coaching layer: MCP prompts (the workflows) and resources (the method).
 * Prompts and resources are fixed text; they never touch athlete data.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { APP_NAME } from "./branding";
import { SETUP, TODAYS_RUN, WEEKLY_REVIEW, RACE_WEEK } from "./content/workflows";
import { METHOD } from "./content/method";
import { PROJECT_INSTRUCTIONS } from "./content/project-instructions";
import { BLUEPRINT_SYSTEM } from "./engine/plan/blueprint";
import { ADAPT_INTRO, ADAPT_THINK, ADAPT_RULES, ADAPT_RESTORATION } from "./engine/policy/coach-text";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
const withToday = (text: string, today?: string) => (today ? `Today is ${today}.\n\n${text}` : text);
const TodayArg = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Today's date, YYYY-MM-DD.") });

const PROMPTS = [
  { name: "velox_setup", title: `Set up ${APP_NAME}`, description: "Your first plan: goal, history from Strava, and a periodised plan built for you.", text: SETUP },
  { name: "velox_todays_run", title: "How did today's run go", description: "Log your latest run with how it felt, and let the coach adjust the plan.", text: TODAYS_RUN },
  { name: "velox_weekly_review", title: "Weekly review", description: "Last week against the plan, and what changes for next week.", text: WEEKLY_REVIEW },
  { name: "velox_race_week", title: "Race week", description: "Taper, pacing plan and race-day details.", text: RACE_WEEK },
];

const RESOURCES = [
  { name: "method", uri: "velox://coach/method", title: `The ${APP_NAME} method`, description: "Coaching principles, safety, voice and the workflows.", text: METHOD },
  { name: "adapting", uri: "velox://coach/adapting", title: "Adapting the plan", description: "How to decide whether and how the plan changes, from the web app's coach.", text: [ADAPT_INTRO, ADAPT_THINK, ADAPT_RULES, ADAPT_RESTORATION].join("\n\n") },
  { name: "blueprint", uri: "velox://coach/blueprint", title: "Writing a blueprint", description: "The coach instructions for shaping a plan (weekly template, quality focus, long-run texture).", text: `${BLUEPRINT_SYSTEM}\n\nvelox-mcp is running only: use sport "run" in every slot.` },
  { name: "project_instructions", uri: "velox://setup/project-instructions", title: "Claude Project instructions", description: "Paste this into your Claude Project's instructions.", text: PROJECT_INSTRUCTIONS },
];

export function registerCoach(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: TodayArg }, ({ today }) => user(withToday(p.text, today)));
  }
  for (const r of RESOURCES) {
    server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: r.text }],
    }));
  }
}

export const PROMPT_NAMES = PROMPTS.map((p) => p.name);
export const RESOURCE_URIS = RESOURCES.map((r) => r.uri);
