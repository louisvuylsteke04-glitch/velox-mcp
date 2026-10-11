import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { computeSnapshot } from "../engine/load/snapshot";
import { fmtPredictedTime, predictRaceTime, type ActivityForPrediction } from "../engine/predict/race-predictor";
import { buildPredictionView } from "../engine/predict/race-models/view";
import { assessGoalRealism } from "../engine/zones/goal-paces";
import { trainingPhase } from "../engine/goal";
import { Athlete, Runs, Today, addDays, nowMsOf, prepareRuns, result } from "./common";

const GOAL_LABEL: Record<string, string> = {
  "5k": "5 km", "10k": "10 km", half_marathon: "Half Marathon", marathon: "Marathon", ultra: "Ultra",
};

const Input = z.object({
  today: Today,
  goal_type: z.enum(["5k", "10k", "half_marathon", "marathon", "ultra"]),
  event_distance_km: z.number().min(1).max(250).nullish().describe("Required for ultra; ignored for standard distances."),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().describe("Race day, YYYY-MM-DD. Sets the training phase and taper adjustment."),
  goal_time_s: z.number().int().min(600).max(200_000).nullish().describe("Target time in seconds, to judge whether it is realistic."),
  athlete: Athlete.optional(),
  runs: Runs.describe("Strava runs from the last 16 weeks or more. Pass average_heartrate where known: heart rate makes every estimate sharper."),
});

const DAY_MS = 86_400_000;

export function registerPredictRace(server: McpServer): void {
  server.registerTool(
    "velox_predict_race",
    {
      title: "Predict a race time",
      description: [
        "Race-time prediction from the athlete's own runs, two ways: the Vēlox predictor (training-run ensemble blended with fitness and volume, with a confidence band),",
        "and a bank of ten published models (Riegel, Daniels VDOT, Cameron, Tanda, critical speed and others) summarised as a weighted median with its spread.",
        "Pass goal_time_s to get a realism verdict. Present the range, not just the central time, and say what limits the estimate.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const { today } = input;
      const nowMs = nowMsOf(today);
      const prep = prepareRuns(input.runs, input.athlete, today);
      const since16w = addDays(today, -112);
      const snap = computeSnapshot(prep.features.filter((f) => f.activity_date >= since16w), nowMs);

      const toPred = (f: (typeof prep.features)[number]): ActivityForPrediction => ({
        activity_date: f.activity_date, distance_km: f.distance_km, moving_time_min: f.moving_time_min,
        average_pace_sec_per_km: f.average_pace_sec_per_km, avg_hr_pct_max: f.avg_hr_pct_max,
        workout_type: f.workout_type, is_long_run: f.is_long_run, is_quality_run: f.is_quality_run, is_easy_run: f.is_easy_run,
      });
      // The web app's dashboard window: the last 57 days, newest first, at most 60 runs.
      const since57 = addDays(today, -57);
      const recent = prep.features.filter((f) => f.activity_date >= since57).reverse().slice(0, 60).map(toPred);

      const raceDate = input.race_date ?? null;
      const phase = trainingPhase(raceDate, nowMs);
      const weeksToRace = raceDate ? Math.ceil((new Date(raceDate).getTime() - nowMs) / (7 * DAY_MS)) : null;

      const single = predictRaceTime({
        goalType: input.goal_type,
        activities: recent,
        ctl: snap.weekly.at(-1)?.ctl ?? null,
        acwr: snap.acwr,
        weeklyAvgKm: snap.distance_28d_km / 4,
        weeksToRace,
        trainingPhase: phase,
        goalTimeSeconds: input.goal_time_s ?? null,
        eventDistanceKm: input.event_distance_km,
        nowMs,
      });

      const bank = buildPredictionView({
        activities: prep.features.map(toPred),
        goalType: input.goal_type,
        goalLabel: GOAL_LABEL[input.goal_type],
        raceDate,
        planStartDate: null,
        trainingStartDate: null,
        today,
        ctl: snap.weekly.at(-1)?.ctl ?? null,
        eventDistanceKm: input.event_distance_km,
      });

      const realism = input.goal_time_s
        ? assessGoalRealism({ goalTimeSeconds: input.goal_time_s, goalType: input.goal_type, prediction: single })
        : null;

      const fmt = (s: number | null | undefined) => (s == null ? null : fmtPredictedTime(Math.round(s)));
      const structured = {
        goal_type: input.goal_type,
        training_phase: phase,
        weeks_to_race: weeksToRace,
        prediction: single ? {
          seconds: single.predictedSeconds, time: fmt(single.predictedSeconds),
          range: [fmt(single.rangeLowSeconds), fmt(single.rangeHighSeconds)],
          confidence: single.confidence, confidence_note: single.confidenceNote,
          primary_driver: single.primaryDriver, limiter: single.limiter, method: single.methodNote,
        } : null,
        model_bank: bank ? {
          central: fmt(bank.central), central_seconds: bank.central,
          band: [fmt(bank.bandLow), fmt(bank.bandHigh)], min_max: [fmt(bank.low), fmt(bank.high)],
          models_answered: bank.answered, models_total: bank.total, spread_pct: bank.spreadPct,
          primary_effort: bank.primaryEffort,
          models: bank.models.map((m) => ({ name: m.name, family: m.family, time: fmt(m.seconds), abstained: m.abstainReason })),
          recent_series: bank.series.slice(-8),
        } : null,
        goal_realism: realism,
        data: { runs_used: prep.features.length, runs_with_hr: prep.withHr, runs_in_57d_window: recent.length },
      };

      const lines: string[] = [];
      if (single) {
        lines.push(`Vēlox predictor: ${fmt(single.predictedSeconds)} (range ${fmt(single.rangeLowSeconds)} to ${fmt(single.rangeHighSeconds)}, ${single.confidence} confidence).`);
        lines.push(single.confidenceNote);
        if (single.limiter) lines.push(`Limiter: ${single.limiter}`);
      } else {
        lines.push("Not enough recent running to predict with the Vēlox predictor.");
      }
      if (bank?.central != null) {
        lines.push(`Model bank: ${fmt(bank.central)}, middle band ${fmt(bank.bandLow)} to ${fmt(bank.bandHigh)}, ${bank.answered} of ${bank.total} models answered.`);
      }
      if (realism) lines.push(`Goal ${fmt(input.goal_time_s)}: ${realism.verdict}. ${realism.note}`);
      lines.push(`Phase ${phase}${weeksToRace != null ? `, ${weeksToRace} weeks to race` : ""}. Based on ${prep.features.length} runs, ${prep.withHr} with heart rate.`);
      return result(lines.filter(Boolean).join("\n"), structured);
    },
  );
}
