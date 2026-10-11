import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { sessionsBetween } from "../block/plan";
import { fmtPace } from "../engine/zones/goal-paces";
import { addDaysYMD } from "../engine/dates";
import { Today, result } from "./common";
import { EDITED_NOTE, PlanBlockText, readBlock } from "./plan-common";

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Input = z.object({
  today: Today,
  plan_block: PlanBlockText,
  from: YMD.nullish().describe("First day, default today."),
  to: YMD.nullish().describe("Last day, default 6 days after `from`. At most 6 weeks."),
});

const ZONE_PACE: Record<string, "easy" | "threshold" | "interval" | null> = {
  zone1: "easy", zone2: "easy", zone3: "threshold", zone4: "threshold", zone5: "interval", race_pace: null,
};

export function registerGetSessions(server: McpServer): void {
  server.registerTool(
    "velox_get_sessions",
    {
      title: "Sessions from the plan",
      description: "The planned sessions for a date range (default: today and the next 6 days) from the athlete's plan block, each with its warm-up, main set and cool-down, target paces and the coach's note for its phase. Read-only: it does not change the plan.",
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const read = readBlock(input.plan_block);
      if ("error" in read) return read.error;
      const { block } = read;
      const from = input.from ?? input.today;
      let to = input.to ?? addDaysYMD(from, 6);
      if (to > addDaysYMD(from, 41)) to = addDaysYMD(from, 41);
      if (to < from) to = from;

      const sessions = sessionsBetween(block, from, to);
      const paces = block.athlete.paces;
      const paceFor = (zone: string | null) => {
        const key = zone ? ZONE_PACE[zone] : null;
        const v = key ? paces[key] : null;
        return v != null ? fmtPace(v) : null;
      };
      const view = sessions.map((s) => ({ ...s, target_pace: paceFor(s.zone) }));

      const lines: string[] = [];
      if (read.edited) lines.push(EDITED_NOTE);
      if (!view.length) lines.push(`No sessions planned between ${from} and ${to}.`);
      for (const s of view) {
        lines.push(`${s.date} (week ${s.week}${s.phase ? `, ${s.phase}` : ""}) ${s.title}${s.km ? `, ${s.km} km` : s.min ? `, ${s.min} min` : ""}${s.target_pace ? ` around ${s.target_pace}` : ""}${s.status !== "planned" ? ` [${s.status}]` : ""}`);
        for (const g of s.segments ?? []) lines.push(`  ${g.label}${g.notes ? `. ${g.notes}` : ""}`);
        if (s.coach_cue) lines.push(`  Coach: ${s.coach_cue}`);
      }
      return result(lines.join("\n"), { from, to, sessions: view, edited: read.edited });
    },
  );
}
