import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { buildAthleteProfile, type ProfileRun } from "../engine/plan/profile";
import { anchorDataFrom } from "../engine/plan/anchor-data";
import { buildPlan, type PlanGoal } from "../engine/plan/build";
import { BLUEPRINT_SYSTEM } from "../engine/plan/blueprint";
import { fmtPace } from "../engine/zones/goal-paces";
import { fmtTime } from "../engine/goal";
import { addDaysYMD } from "../engine/dates";
import { blockFromPlan, sessionsBetween } from "../block/plan";
import { Athlete, Runs, Today, nowMsOf, prepareRuns } from "./common";
import { PlanBlockText, blockContent, readBlock } from "./plan-common";
import { addDaysYMD as plusDays } from "../engine/dates";
import { sealBlock } from "../block/codec";
import type { PlanBlock } from "../block/schema";

const Day = z.number().int().min(1).max(7);

const Input = z.object({
  today: Today,
  athlete: Athlete.extend({
    name: z.string().max(80).nullish(),
    experience: z.enum(["beginner", "intermediate", "advanced"]).nullish().describe("How long and how seriously they have run. Shapes the starting volume and progression."),
  }).optional(),
  runs: Runs.describe("Strava runs from the last 17 weeks (list_activities), with relative_effort, and average_heartrate for the last 10 days. An athlete with no runs gets a plan from their stated weekly volume."),
  goal: z.object({
    goal_type: z.enum(["5k", "10k", "half_marathon", "marathon", "ultra", "improve_fitness"]),
    race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    goal_time_s: z.number().int().min(600).max(200_000).nullish(),
    event_distance_km: z.number().min(1).max(250).nullish().describe("Ultra only."),
  }).nullish().describe("Omit, or use improve_fitness with no date, for a general 12-week block."),
  preferences: z.object({
    available_days: z.number().int().min(2).max(7).nullish(),
    preferred_days: z.array(Day).max(7).nullish().describe("ISO weekdays, 1 = Monday."),
    long_run_day: Day.nullish(),
    min_session_km: z.number().min(1).max(20).nullish(),
    max_session_minutes: z.number().int().min(20).max(300).nullish().describe("Longest a weekday session can be."),
    weekly_km_now: z.number().min(0).max(250).nullish().describe("What the athlete says they run per week. Used when Strava history is thin."),
  }).nullish(),
  race_results: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    distance_km: z.number().min(1).max(250),
    time_s: z.number().int().min(180).max(200_000),
    name: z.string().max(80).nullish(),
  })).max(20).nullish().describe("Recent races. The best anchor for training paces."),
  injuries: z.object({
    history: z.array(z.string().max(200)).max(20).nullish().describe("Past injuries, in the athlete's words."),
    current: z.array(z.object({
      type: z.enum(["injury", "pain", "soreness", "illness", "fatigue"]),
      body_part: z.string().max(60).nullish(),
      description: z.string().max(300),
      severity: z.number().int().min(1).max(5).nullish(),
    })).max(8).nullish().describe("Anything bothering them now. Shapes restrictions; a red flag stops hard training."),
  }).nullish(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("Start later than next Monday. Snapped to its Monday."),
  first_plan: z.boolean().nullish().describe("True for an athlete's first Vēlox plan: week 1 becomes an assessment week with a time trial that sets their paces. Defaults to true, or false when previous_block is given."),
  previous_block: PlanBlockText.nullish().describe("When rebuilding: the current plan block. Its log, history and athlete details carry over, and logged effort, feelings and pain shape the new plan."),
  reason: z.enum(["new_plan", "rebuild", "benchmark_recalibration", "checkin_2w"]).default("new_plan").describe("Why this plan is built: a new plan, a re-entry rebuild after a long gap, or a check-in from the missed-session policy or review."),
  blueprint: z.record(z.string(), z.unknown()).nullish().describe("The coach's blueprint. Omit on the first call; then write one from the returned brief and call again with it."),
  request: z.string().max(600).nullish().describe("Anything the athlete asked for in this plan, in their words."),
});


export function registerBuildPlan(server: McpServer): void {
  server.registerTool(
    "velox_build_plan",
    {
      title: "Build a training plan",
      description: [
        "Builds a periodised running plan from the athlete's own Strava history: safe weekly volumes, long-run progression, deloads, taper, quality sessions with warm-up, main set and cool-down at the athlete's paces, and race day pinned.",
        "Two steps. First call without a blueprint: you get a plan on the engine's default shape plus a coaching brief. Then, as the coach, write a blueprint (weekly template, quality focus and long-run texture per phase, week overrides) following the brief, and call again with it. Volumes, safety rules and dates stay the engine's; the shape and progression become yours.",
        "Returns a plan block. Save it in the athlete's Claude Project and pass it to every later Vēlox call.",
        "Before calling, ask for the goal, race date, available days and long-run day if you do not know them. Never present a plan as medical advice.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const { today } = input;
      const nowMs = nowMsOf(today);
      let prev: PlanBlock | null = null;
      if (input.previous_block) {
        const r = readBlock(input.previous_block);
        if ("error" in r) return r.error;
        prev = r.block;
      }
      const pa = prev?.athlete;
      const ath = {
        ...input.athlete,
        name: input.athlete?.name ?? pa?.name ?? null,
        birth_date: input.athlete?.birth_date ?? pa?.birth_date ?? null,
        sex: input.athlete?.sex ?? pa?.sex ?? null,
        experience: input.athlete?.experience ?? (pa?.experience as "beginner" | "intermediate" | "advanced" | null | undefined) ?? null,
        max_hr: input.athlete?.max_hr ?? pa?.max_hr ?? null,
        rest_hr: input.athlete?.rest_hr ?? pa?.rest_hr ?? null,
      };
      const prep = prepareRuns(input.runs, ath, today);

      const goal: PlanGoal | null = input.goal && !(input.goal.goal_type === "improve_fitness" && !input.goal.race_date)
        ? {
            type: input.goal.goal_type,
            raceDate: input.goal.race_date ?? null,
            eventDistanceKm: input.goal.goal_type === "ultra" ? input.goal.event_distance_km ?? null : null,
            targetTimeSecs: input.goal.goal_time_s ?? null,
          }
        : null;

      const p = input.preferences ?? {};
      const preferences: Record<string, unknown> = {
        ...(prev && !input.preferences ? prev.athlete.prefs : {}),
        ...(p.available_days != null ? { available_days: p.available_days } : {}),
        ...(p.preferred_days?.length ? { preferred_days: p.preferred_days } : {}),
        ...(p.long_run_day != null ? { long_run_day: p.long_run_day } : {}),
        ...(p.min_session_km != null ? { min_session_km: p.min_session_km } : {}),
        ...(p.max_session_minutes != null ? { max_session_minutes: p.max_session_minutes } : {}),
        ...(p.weekly_km_now != null ? { sport_volume: { run_weekly_km: p.weekly_km_now } } : {}),
      };

      const concerns = (input.injuries?.current ?? []).map((c) => ({
        concern_type: c.type, body_part: c.body_part ?? null, description: c.description,
        severity: c.severity ?? null, status: "active", last_mentioned_at: `${today}T12:00:00Z`,
      }));

      // Logged effort from the previous block: RPE onto its run, and the web app's
      // feedback rows (RPE and fatigue, 28 days) and pain logs (10 days).
      const rpeByDate = new Map((prev?.log ?? []).filter((e) => e.rpe != null).map((e) => [`${e.date}|${Math.round(e.km)}`, e.rpe]));
      const profileRuns: ProfileRun[] = prep.features.map((f, i) => ({ ...f, rpe: prep.rpe[i] ?? rpeByDate.get(`${f.activity_date}|${Math.round(f.distance_km)}`) ?? null }));
      const since28 = plusDays(today, -28);
      const since10 = plusDays(today, -10);
      const feedback = (prev?.log ?? []).filter((e) => e.date >= since28 && (e.rpe != null || e.feeling != null))
        .map((e) => ({ rpe: e.rpe, fatigue_rating: e.feeling != null ? 6 - e.feeling : null }));
      const painLogs = (prev?.log ?? []).filter((e) => e.date >= since10 && e.pain?.length).map((e) => ({ activity_date: e.date, pain_areas: e.pain }));
      const injuryHistory = input.injuries?.history ?? prev?.athlete.injury_history ?? null;
      const profile = buildAthleteProfile({
        today, nowMs, runs: profileRuns,
        name: ath?.name ?? null, birthDate: ath?.birth_date ?? null, sex: ath?.sex ?? null,
        experienceLevel: ath?.experience ?? null, maxHr: ath?.max_hr ?? null, restHr: ath?.rest_hr ?? null,
        injuryHistory, concerns, painLogs, feedback,
        preferences,
        anchor: anchorDataFrom({
          runs: prep.features,
          races: (input.race_results ?? []).map((r) => ({
            race_date: r.date, event_name: r.name ?? null, distance_type: null, distance_km: r.distance_km,
            finish_time_seconds: r.time_s, dnf: false, sport: "run",
          })),
          goal: goal ? { goal_type: goal.type, race_date: goal.raceDate, goal_time_seconds: goal.targetTimeSecs, goal_distance_m: goal.eventDistanceKm ? goal.eventDistanceKm * 1000 : null } : null,
          nowMs,
        }),
      });

      const result = buildPlan({
        profile, goal, today, startDate: input.start_date ?? null,
        blueprint: input.blueprint ?? null, assessment: input.first_plan ?? !prev, constraint: input.request ?? null,
      });

      const built = blockFromPlan({
        result, profile, goal, today, prefs: preferences,
        athlete: {
          name: ath?.name ?? null, birth_date: ath?.birth_date ?? null, sex: ath?.sex ?? null,
          experience: ath?.experience ?? null, max_hr: ath?.max_hr ?? null, rest_hr: ath?.rest_hr ?? null,
          injury_history: injuryHistory ?? [],
        },
      });
      // A rebuild keeps the athlete's log and the plan line's history.
      const block: PlanBlock = prev
        ? (() => {
            const { check: _c, ...rest } = built;
            void _c;
            const done = new Set(prev.history.checkins_done);
            if (input.reason === "benchmark_recalibration" || input.reason === "checkin_2w") done.add(input.reason);
            return sealBlock({
              ...rest,
              log: prev.log,
              history: {
                ...prev.history,
                plan_created: prev.history.plan_created ?? prev.made,
                first_session: prev.history.first_session ?? prev.sessions[0]?.date ?? null,
                checkins_done: [...done],
                last_rebuild: input.reason === "rebuild" ? today : prev.history.last_rebuild,
              },
            });
          })()
        : built;

      const firstWeek = sessionsBetween(block, today, addDaysYMD(result.planStart, 6));
      const weeks = block.plan.weeks.map((w) => {
        const ss = block.sessions.filter((s) => s.week === w.n);
        return {
          week: w.n, starts: addDaysYMD(result.planStart, (w.n - 1) * 7), phase: w.recovery ? "recovery" : w.phase,
          km: Math.round(ss.reduce((a, s) => a + (s.km ?? 0), 0) * 10) / 10, target_km: w.km,
          runs: ss.length, long_km: Math.max(0, ...ss.filter((s) => s.type === "long_run").map((s) => s.km ?? 0)),
          quality: ss.filter((s) => ["tempo", "threshold", "interval"].includes(s.type)).length,
        };
      });
      const issues = result.finalViolations.map((v) => ({ severity: v.severity, week: v.week, message: v.message }));
      const verdicts = result.envelope.verdicts.filter((v) => !v.adequate && v.note).map((v) => v.note as string);

      const structured = {
        plan_start: result.planStart,
        total_weeks: result.totalWeeks,
        weeks_to_race: result.weeksToRace,
        race_date: goal?.raceDate ?? null,
        blueprint_source: result.blueprintSource,
        blueprint_rejected: result.blueprintRejected,
        paces: {
          easy: profile.run.easyPaceSecPerKm != null ? fmtPace(profile.run.easyPaceSecPerKm) : null,
          threshold: profile.run.thresholdPaceSecPerKm != null ? fmtPace(profile.run.thresholdPaceSecPerKm) : null,
          interval: profile.run.intervalPaceSecPerKm != null ? fmtPace(profile.run.intervalPaceSecPerKm) : null,
          anchor: profile.run.paceAnchor?.basis ?? null,
        },
        starting_point: { weekly_km: profile.run.weeklyKm, longest_km: profile.run.longestKm, fitness_ctl: profile.load.ctl },
        safety: {
          injury: profile.injury.active ? profile.injury.summary : null,
          restrictions: profile.injury.restrictions,
          medical_red_flag: profile.medical.raised ? profile.medical.reasons : null,
          returning_after_break: profile.missedTraining.action !== "continue" ? profile.missedTraining.note : null,
        },
        assessment_week: result.assessment,
        weeks,
        first_week: firstWeek,
        feasibility: verdicts,
        issues,
        plan_notes: result.plan.plan_notes,
        load_methods: prep.calibration.counts,
      };

      const lines: string[] = [];
      lines.push(`${result.totalWeeks}-week plan from Monday ${result.planStart}${goal?.raceDate ? ` to race day ${goal.raceDate}` : ""}. Blueprint: ${result.blueprintSource === "coach" ? "yours" : "engine default"}${result.blueprintRejected ? " (the blueprint you sent could not be used, so the default was applied; check it against the brief)" : ""}.`);
      lines.push(`Starting point: ${profile.run.weeklyKm} km/week, longest run ${profile.run.longestKm} km. Paces: easy ${structured.paces.easy ?? "n/a"}, threshold ${structured.paces.threshold ?? "n/a"}, interval ${structured.paces.interval ?? "n/a"}${structured.paces.anchor ? ` (from ${structured.paces.anchor})` : ""}.`);
      if (profile.medical.raised) lines.push(`RED FLAG: ${profile.medical.reasons.join("; ")}. Advise rest or easy movement only and a professional assessment before training hard. Do not diagnose.`);
      if (profile.injury.active) lines.push(`Injury in play: ${profile.injury.summary ?? profile.injury.region}. The plan applies its restrictions.`);
      if (result.assessment?.benchmarkKm) lines.push(`Week 1 is an assessment week with a ${result.assessment.benchmarkKm} km time trial. Its result resets the paces.`);
      else if (result.assessment) lines.push("Week 1 is an easy settling-in week. No time trial fitted this week, so the paces stand on the evidence above.");
      for (const v of verdicts) lines.push(`Feasibility: ${v}`);
      for (const i of issues.filter((x) => x.severity === "critical")) lines.push(`Check: ${i.message}`);
      lines.push("");
      lines.push("Week | starts | phase | km | runs | long | quality");
      for (const w of weeks) lines.push(`${w.week} | ${w.starts} | ${w.phase} | ${w.km} | ${w.runs} | ${w.long_km || "-"} | ${w.quality}`);
      lines.push("");
      lines.push("This week:");
      for (const s of firstWeek) lines.push(`${s.date} ${s.title}${s.km ? ` ${s.km} km` : ""}${s.segments ? `: ${s.segments.map((g) => g.label).join(", ")}` : ""}`);
      if (goal?.targetTimeSecs) lines.push(`\nGoal time ${fmtTime(goal.targetTimeSecs)}.`);

      const content = [{ type: "text" as const, text: lines.join("\n") }];
      if (result.blueprintSource === "fallback") {
        content.push({
          type: "text" as const,
          text: `TO COACH THIS PLAN: write a blueprint and call velox_build_plan again with the same inputs plus \`blueprint\`. Running only: use sport "run" in every slot.\n\nCOACH INSTRUCTIONS:\n${BLUEPRINT_SYSTEM}\n\nBRIEF:\n${result.brief}`,
        });
      }
      content.push(blockContent(block));
      return { content, structuredContent: structured };
    },
  );
}
