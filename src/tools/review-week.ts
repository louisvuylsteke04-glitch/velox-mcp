import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { computeRunFeatures } from "../engine/load/run-features";
import { hrSettings } from "../engine/load/athlete";
import { addDaysYMD, daysBetweenYMD } from "../engine/dates";
import { logRuns } from "../block/log";
import { health, missedDecision, restoration, checkin } from "../block/signals";
import type { PlanBlock } from "../block/schema";
import { Run, Today } from "./common";
import { EDITED_NOTE, PlanBlockText, blockContent, readBlock } from "./plan-common";
import { adaptBrief, type Trigger } from "./adapt-common";

const Input = z.object({
  today: Today,
  plan_block: PlanBlockText,
  runs: z.array(Run).max(60).nullish().describe("Strava runs from the last 14 days. Any not yet logged are added (without feelings) so the review is complete."),
});

function weekView(block: PlanBlock, n: number, today: string) {
  const start = addDaysYMD(block.plan.start, (n - 1) * 7);
  const end = addDaysYMD(start, 6);
  const sessions = block.sessions.filter((s) => s.week === n);
  const runs = block.log.filter((e) => e.date >= start && e.date <= end);
  const feelings = runs.map((e) => e.feeling).filter((x): x is number => x != null);
  const rpes = runs.map((e) => e.rpe).filter((x): x is number => x != null);
  const w = block.plan.weeks.find((x) => x.n === n);
  return {
    week: n, starts: start, phase: w ? (w.recovery ? "recovery" : w.phase) : null, complete: end < today,
    target_km: w?.km ?? null,
    planned_km: Math.round(sessions.reduce((a, s) => a + (s.km ?? 0), 0) * 10) / 10,
    run_km: Math.round(runs.reduce((a, e) => a + e.km, 0) * 10) / 10,
    sessions: sessions.length,
    completed: sessions.filter((s) => s.status === "completed").length,
    skipped: sessions.filter((s) => s.status === "skipped").map((s) => `${s.date} ${s.type.replace("_", " ")}`),
    unplanned_runs: runs.filter((e) => !e.session).length,
    avg_feeling: feelings.length ? Math.round(feelings.reduce((a, b) => a + b, 0) / feelings.length * 10) / 10 : null,
    avg_rpe: rpes.length ? Math.round(rpes.reduce((a, b) => a + b, 0) / rpes.length * 10) / 10 : null,
    low_days: feelings.filter((f) => f <= 2).length,
  };
}

export function registerReviewWeek(server: McpServer): void {
  server.registerTool(
    "velox_review_week",
    {
      title: "Review the week",
      description: [
        "The weekly review: last week and this week, planned against done (sessions, km, how the athlete felt), plus what the coach should act on: health flags, missed sessions under the missed-session policy (adapt, one re-entry rebuild after a structural absence, or leave it), restoration back toward the original plan once targets are met again, and the week-1 and two-week check-ins.",
        "Pass recent Strava runs to catch any that were not logged. Returns the updated block when runs were added, and the adaptation rules and NET POSITION table when the plan should change.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const read = readBlock(input.plan_block);
      if ("error" in read) return read.error;
      const { today } = input;
      let block = read.block;

      // Catch up runs that were never logged.
      const known = new Set(block.log.map((e) => e.activity).filter(Boolean));
      const a = block.athlete;
      const hr = hrSettings({ maxHr: a.max_hr, restHr: a.rest_hr, birthDate: a.birth_date, sex: a.sex }, today);
      const fresh = (input.runs ?? [])
        .filter((r) => (!r.sport_type || ["Run", "TrailRun", "VirtualRun"].includes(r.sport_type)) && r.start_local.slice(0, 10) <= today)
        .filter((r) => !r.id || !known.has(r.id))
        .filter((r) => r.id || !block.log.some((e) => e.date === r.start_local.slice(0, 10) && Math.abs(e.km - r.distance / 1000) < 0.2));
      const before = JSON.stringify(block.sessions.map((s) => s.status));
      const result = logRuns(block, fresh.map((r) => ({
        activity: r.id ?? null, rpe: r.rpe ?? null, feeling: null, note: null, pain: null,
        features: computeRunFeatures({ name: r.name, start_local: r.start_local, distance_m: r.distance, moving_time_s: r.moving_time, elapsed_time_s: r.elapsed_time, elevation_gain_m: r.elevation_gain, avg_speed_mps: r.avg_speed, average_heartrate: r.average_heartrate, workout_type: r.workout_type }, hr.maxHr, hr.restHr, hr.sex),
      })), today);
      const changed = fresh.length > 0 || JSON.stringify(result.block.sessions.map((s) => s.status)) !== before;
      block = result.block;

      const currentWeek = Math.floor(daysBetweenYMD(block.plan.start, today) / 7) + 1;
      const weeks = [currentWeek - 1, currentWeek].filter((n) => n >= 1 && n <= block.plan.total_weeks).map((n) => weekView(block, n, today));

      const h = health(block, today);
      const lastMissed = block.history.last_missed_adapt;
      const recentSkips = block.sessions.filter((s) => s.status === "skipped" && s.date >= addDaysYMD(today, -14) && (!lastMissed || s.date >= lastMissed));
      const policy = recentSkips.length ? missedDecision(block, today, h) : null;
      const resto = restoration(block, today, h);
      const due = checkin(block, today);
      const lowDays = block.log.filter((e) => e.date >= addDaysYMD(today, -7) && e.feeling != null && e.feeling <= 2).length;

      let trigger: Trigger | null = null;
      let why = "";
      if (h.medical.raised) { trigger = "run_note"; why = "medical red flag"; }
      else if (policy?.action === "adapt") { trigger = "missed_session"; why = policy.reason; }
      else if (lowDays >= 2) { trigger = "wellness_logged"; why = `${lowDays} poor days in the last week`; }
      else if (resto.due) { trigger = "restoration_review"; why = resto.reason; }

      const lines: string[] = [];
      if (read.edited) lines.push(EDITED_NOTE);
      if (fresh.length) lines.push(`Added ${fresh.length} run${fresh.length === 1 ? "" : "s"} that had not been logged.`);
      for (const w of weeks) {
        lines.push(`Week ${w.week} (${w.phase ?? "?"}, from ${w.starts}${w.complete ? "" : ", in progress"}): ${w.completed} of ${w.sessions} sessions done, ${w.run_km} of ${w.planned_km} km planned${w.target_km ? ` (target ${w.target_km})` : ""}.${w.skipped.length ? ` Missed: ${w.skipped.join(", ")}.` : ""}${w.unplanned_runs ? ` ${w.unplanned_runs} unplanned run${w.unplanned_runs === 1 ? "" : "s"}.` : ""}${w.avg_feeling != null ? ` Felt ${w.avg_feeling}/5 on average${w.avg_rpe != null ? `, RPE ${w.avg_rpe}` : ""}.` : ""}`);
      }
      if (h.medical.raised) lines.push(`RED FLAG (${h.medical.reasons.join("; ")}): advise rest or easy movement and a professional assessment. Never diagnose.`);
      else if (h.injury.active) lines.push(`Injury in play: ${h.injury.summary}.`);
      if (policy) lines.push(`Missed-session policy: ${policy.action}. ${policy.reason}.`);
      if (policy?.action === "rebuild") lines.push("Call velox_build_plan with previous_block and reason \"rebuild\" for one re-entry rebuild from current fitness.");
      if (resto.due) lines.push("Restoration: the athlete has met their targets and parts of the plan sit below the original. Step them back toward it.");
      if (due) lines.push(`Check-in due (${due.kind}): ${due.text} Rebuild with velox_build_plan, previous_block and reason "${due.kind}".`);
      lines.push(trigger ? `Suggested: adapt the plan (${why}).` : (policy?.action === "rebuild" || due) ? "" : "The plan stands as it is.");

      const content = [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }];
      if (trigger) content.push({ type: "text" as const, text: adaptBrief(block, today, trigger) });
      if (changed) content.push(blockContent(block));
      return {
        content,
        structuredContent: {
          weeks, added_runs: fresh.length, block_changed: changed,
          health: { red_flag: h.medical.raised ? h.medical.reasons : null, injury: h.injury.active ? h.injury.summary : null },
          missed_policy: policy, restoration: resto, checkin: due,
          suggestion: trigger ? { adapt: true, trigger, why } : { adapt: false },
        },
      };
    },
  );
}
