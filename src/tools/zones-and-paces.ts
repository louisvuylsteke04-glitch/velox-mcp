import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { computeHRZones, normaliseHRZoneMaxPcts, resolveMaxHR } from "../engine/zones/hr-zones";
import { derivePacesFromGoal, fmtPace, pacesFromEasyPace, pacesFromRaceTime, type GoalPaces } from "../engine/zones/goal-paces";
import { Today, result } from "./common";

const GoalType = z.enum(["5k", "10k", "half_marathon", "marathon", "ultra", "improve_fitness"]);

const Input = z.object({
  today: Today,
  max_hr: z.number().int().min(120).max(230).nullish().describe("Measured max HR. Wins over every estimate."),
  peak_hr: z.number().int().min(100).max(240).nullish().describe("Highest heart rate seen in recent runs (Strava max_heartrate). Max is estimated as 5% above it."),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("YYYY-MM-DD, for a 220 minus age estimate when nothing better exists."),
  zone_max_pcts: z.array(z.number().int()).length(5).nullish().describe("Optional custom upper bounds of zones 1-5 as % of max HR, e.g. [62,72,82,91,100]."),
  race_result: z.object({
    distance_km: z.number().min(1).max(250),
    time_s: z.number().int().min(180).max(200_000),
  }).nullish().describe("A recent race or all-out effort. The best anchor for training paces."),
  goal: z.object({
    goal_type: GoalType,
    goal_time_s: z.number().int().min(600).max(200_000),
    event_distance_km: z.number().min(1).max(250).nullish().describe("Only for ultra or other non-standard distances."),
  }).nullish().describe("Goal race and target time. Used for paces when there is no race result."),
  easy_pace_s_per_km: z.number().min(180).max(900).nullish().describe("Typical easy pace, the last-resort pace anchor."),
});

function paceView(p: GoalPaces) {
  return {
    easy: fmtPace(p.easyPaceSecPerKm), long_run: fmtPace(p.longRunPaceSecPerKm), threshold: fmtPace(p.thresholdPaceSecPerKm),
    interval: fmtPace(p.intervalPaceSecPerKm), race: fmtPace(p.goalRacePaceSecPerKm),
  };
}

export function registerZonesAndPaces(server: McpServer): void {
  server.registerTool(
    "velox_zones_and_paces",
    {
      title: "Heart-rate zones and training paces",
      description: [
        "Five heart-rate zones and the training paces (easy, long run, threshold, interval, race) a coach would prescribe.",
        "Pace anchor, best first: a recent race_result, else the goal time, else the athlete's easy pace.",
        "Strava get_athlete_zones already returns the athlete's own zones; prefer those when the athlete set them, and use this tool when they did not, or to turn a race into paces.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const maxHr = resolveMaxHR(input.max_hr ?? null, input.birth_date ?? null, input.peak_hr ?? null, input.today);
      const custom = normaliseHRZoneMaxPcts(input.zone_max_pcts ?? null);
      const zones = maxHr.maxHR
        ? computeHRZones(maxHr.maxHR, custom).map((zn) => ({ zone: zn.zone, name: zn.name, min_bpm: zn.minBpm, max_bpm: zn.maxBpm, min_pct: zn.minPct, max_pct: zn.maxPct, purpose: zn.benefit }))
        : null;

      let paces: GoalPaces | null = null;
      let anchor: "race_result" | "goal" | "easy_pace" | null = null;
      if (input.race_result) {
        paces = pacesFromRaceTime(input.race_result.time_s, input.race_result.distance_km);
        if (paces) anchor = "race_result";
      }
      if (!paces && input.goal) {
        paces = derivePacesFromGoal(input.goal.goal_time_s, input.goal.goal_type, input.goal.event_distance_km);
        if (paces) anchor = "goal";
      }
      if (!paces && input.easy_pace_s_per_km) {
        paces = pacesFromEasyPace(input.easy_pace_s_per_km);
        anchor = "easy_pace";
      }

      const structured = {
        max_hr: maxHr.maxHR, max_hr_source: maxHr.source,
        hr_zones: zones,
        paces_s_per_km: paces ? {
          easy: paces.easyPaceSecPerKm, long_run: paces.longRunPaceSecPerKm, threshold: paces.thresholdPaceSecPerKm,
          interval: paces.intervalPaceSecPerKm, race: paces.goalRacePaceSecPerKm,
        } : null,
        paces: paces ? paceView(paces) : null,
        pace_anchor: anchor,
      };

      const lines: string[] = [];
      if (zones) {
        lines.push(`Max HR ${maxHr.maxHR} (${maxHr.source}).`);
        for (const zn of zones) lines.push(`Z${zn.zone} ${zn.name}: ${zn.min_bpm}-${zn.max_bpm} bpm`);
      } else {
        lines.push("No max HR available. Ask for a measured max, a birth date, or the highest HR from a hard recent run.");
      }
      if (paces) {
        const v = paceView(paces);
        lines.push(`Paces (from ${anchor?.replace("_", " ")}): easy ${v.easy}, long run ${v.long_run}, threshold ${v.threshold}, interval ${v.interval}, race ${v.race}.`);
      } else {
        lines.push("No pace anchor given. Pass a recent race, a goal time, or an easy pace.");
      }
      return result(lines.join("\n"), structured);
    },
  );
}
