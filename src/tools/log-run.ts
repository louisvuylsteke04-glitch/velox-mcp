import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { computeRunFeatures } from "../engine/load/run-features";
import { hrSettings } from "../engine/load/athlete";
import { fenceAthleteText } from "../engine/text";
import { logRuns } from "../block/log";
import { health, missedDecision, restoration, checkin } from "../block/signals";
import { Run, Today } from "./common";
import { EDITED_NOTE, PlanBlockText, blockContent, errorResult, readBlock } from "./plan-common";
import { adaptBrief, type Trigger } from "./adapt-common";

const Input = z.object({
  today: Today,
  plan_block: PlanBlockText,
  run: Run.describe("The run from Strava list_activities, with average_heartrate from get_activity_performance."),
  feeling: z.number().int().min(1).max(5).nullish().describe("How the athlete felt overall: 1 awful, 2 poor, 3 ok, 4 good, 5 great."),
  note: z.string().max(600).nullish().describe("What the athlete said about the run, in their words."),
  pain: z.array(z.object({ body_part: z.string().max(60), description: z.string().max(200) })).max(6).nullish()
    .describe("Anything that hurt, one entry per body part, in the athlete's words."),
});

export function registerLogRun(server: McpServer): void {
  server.registerTool(
    "velox_log_run",
    {
      title: "Log a run",
      description: [
        "Records a completed run in the plan block with how it felt: matches it to its planned session (same day), marks earlier unrun sessions as missed after a day's grace, and reads the signals a coach would act on: medical red flags, injury restrictions, a poor feeling, missed sessions and the missed-session policy, a due check-in.",
        "Ask the athlete how it went first (feeling 1-5, RPE 1-10, anything that hurt) and pass their words. Returns the updated block to save, and when the plan should change, the coaching rules and NET POSITION table for velox_adapt_plan.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const read = readBlock(input.plan_block);
      if ("error" in read) return read.error;
      const { today } = input;
      if (input.run.start_local.slice(0, 10) > today) return errorResult("That run is dated in the future. Check today's date and the run's start time.");
      if (input.run.sport_type && !["Run", "TrailRun", "VirtualRun"].includes(input.run.sport_type)) return errorResult(`Vēlox coaches running only, and this activity is a ${input.run.sport_type}.`);

      const a = read.block.athlete;
      const hr = hrSettings({ maxHr: a.max_hr, restHr: a.rest_hr, birthDate: a.birth_date, sex: a.sex }, today);
      const features = computeRunFeatures({
        name: input.run.name, start_local: input.run.start_local, distance_m: input.run.distance, moving_time_s: input.run.moving_time,
        elapsed_time_s: input.run.elapsed_time, elevation_gain_m: input.run.elevation_gain, avg_speed_mps: input.run.avg_speed,
        average_heartrate: input.run.average_heartrate, workout_type: input.run.workout_type,
      }, hr.maxHr, hr.restHr, hr.sex);

      const { block, outcomes, missed } = logRuns(read.block, [{
        activity: input.run.id ?? null, features, rpe: input.run.rpe ?? null, feeling: input.feeling ?? null,
        note: input.note ?? null, pain: input.pain?.length ? input.pain : null,
      }], today);
      const { entry, matched, replaced } = outcomes[0];

      const h = health(block, today);
      const policy = missed.length ? missedDecision(block, today, h) : null;
      const resto = restoration(block, today, h);
      const due = checkin(block, today);

      // What should happen next, most urgent first.
      let trigger: Trigger | null = null;
      let why = "";
      if (h.medical.raised) { why = "medical red flag"; trigger = "run_note"; }
      else if (input.pain?.length) { trigger = "run_note"; why = "the athlete reported pain"; }
      else if (policy?.action === "rebuild") { why = policy.reason; }
      else if (policy?.action === "adapt") { trigger = "missed_session"; why = policy.reason; }
      else if (entry.feeling != null && entry.feeling <= 2) { trigger = "wellness_logged"; why = "the athlete felt poor; a single off day is not always cause to cut the plan"; }
      else if (matched && matched.km && Math.abs(entry.km - matched.km) / matched.km > 0.3) { trigger = "run_logged"; why = `the run was ${entry.km} km against ${matched.km} km planned`; }
      else if (resto.due) { trigger = "restoration_review"; why = resto.reason; }

      const lines: string[] = [];
      if (read.edited) lines.push(EDITED_NOTE);
      lines.push(`${replaced ? "Updated" : "Logged"}: ${entry.date}, ${entry.km} km in ${Math.round(entry.min)} min${entry.avg_hr ? `, average HR ${entry.avg_hr}` : ""} (${entry.kind}).`);
      lines.push(matched ? `Completed the planned ${matched.type.replace("_", " ")}${matched.km ? ` of ${matched.km} km` : ""}.` : "It matched no planned session (no planned run that day, or the day's run was already done).");
      if (missed.length) lines.push(`Marked missed: ${missed.map((s) => `${s.date} ${s.type.replace("_", " ")}`).join(", ")}.`);
      if (entry.note) lines.push(`Athlete's note: ${fenceAthleteText(entry.note)}`);
      if (h.medical.raised) lines.push(`RED FLAG (${h.medical.reasons.join("; ")}): advise stopping hard training, easy movement or rest only, and a professional assessment soon. Never diagnose. Hold the plan to recovery volume until they are cleared.`);
      else if (h.injury.active) lines.push(`Injury in play: ${h.injury.summary}. Restrictions: ${Object.entries(h.injury.restrictions).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.`);
      if (policy) lines.push(`Missed-session policy: ${policy.action}. ${policy.reason}.`);
      if (policy?.action === "rebuild") lines.push("A structural absence calls for one re-entry rebuild: call velox_build_plan with previous_block and reason \"rebuild\", from the athlete's current runs.");
      if (due) lines.push(`Check-in due (${due.kind}): ${due.text} Rebuild with velox_build_plan, previous_block and reason "${due.kind}"${due.kind === "benchmark_recalibration" ? ", passing the time trial result as a race result" : ""}.`);
      lines.push(trigger ? `Suggested: consider adapting the plan (${why}).` : "No change to the plan is called for.");

      const structured = {
        logged: entry, replaced, matched_session: matched?.id ?? null, missed: missed.map((s) => s.id),
        health: { red_flag: h.medical.raised ? h.medical.reasons : null, injury: h.injury.active ? h.injury.summary : null, restrictions: h.injury.restrictions },
        missed_policy: policy, restoration: resto, checkin: due,
        suggestion: trigger ? { adapt: true, trigger, why } : { adapt: false, why: policy?.action === "rebuild" ? policy.reason : null },
      };
      const content = [{ type: "text" as const, text: lines.join("\n") }];
      if (trigger) content.push({ type: "text" as const, text: adaptBrief(block, today, trigger) });
      content.push(blockContent(block));
      return { content, structuredContent: structured };
    },
  );
}
