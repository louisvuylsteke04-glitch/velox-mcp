/**
 * Logging runs into a plan block: match the run to its planned session (the
 * web app's matcher), record how it went, and mark sessions missed after a
 * day's grace (the web app's nightly cron rule).
 */
import { addDaysYMD } from "../engine/dates";
import { MATCH_THRESHOLD, scoreMatch } from "../engine/adapt/matcher";
import type { RunFeatures } from "../engine/load/run-features";
import type { BlockLogEntry, BlockSession, PlanBlock } from "./schema";
import { sealBlock } from "./codec";

const RUN_TYPES = new Set(["easy", "long_run", "tempo", "interval", "threshold", "recovery", "race"]);

export type LoggedRun = {
  activity: string | null;
  features: RunFeatures;
  rpe: number | null;
  feeling: number | null;
  note: string | null;
  pain: { body_part: string; description: string }[] | null;
};

export type LogOutcome = {
  entry: BlockLogEntry;
  matched: BlockSession | null;
  /** A repeat of a run already in the log: updated in place. */
  replaced: boolean;
};

/** Add (or update) one run. Mutates the given session and log arrays. */
function ingest(sessions: BlockSession[], log: BlockLogEntry[], r: LoggedRun): LogOutcome {
  const f = r.features;
  const existing = r.activity ? log.findIndex((e) => e.activity === r.activity) : -1;
  let matched: BlockSession | null = null;
  if (existing >= 0 && log[existing].session) {
    matched = sessions.find((s) => s.id === log[existing].session) ?? null;
  } else {
    let best = 0;
    for (const s of sessions) {
      if (s.status !== "planned") continue;
      const score = scoreMatch(
        { scheduled_date: s.date, workout_type: s.type, target_distance_km: s.km },
        { activity_date: f.activity_date, distance_km: f.distance_km, workout_type: f.workout_type },
      );
      if (score > best) { best = score; matched = s; }
    }
    if (best <= MATCH_THRESHOLD) matched = null;
    if (matched) matched.status = "completed";
  }
  const prev = existing >= 0 ? log[existing] : null;
  const entry: BlockLogEntry = {
    date: f.activity_date,
    activity: r.activity,
    session: matched?.id ?? null,
    km: Math.round(f.distance_km * 100) / 100,
    min: Math.round(f.moving_time_min * 10) / 10,
    avg_hr: f.average_heartrate_bpm != null ? Math.round(f.average_heartrate_bpm) : null,
    kind: f.workout_type,
    rpe: r.rpe ?? prev?.rpe ?? null,
    feeling: r.feeling ?? prev?.feeling ?? null,
    note: r.note ?? prev?.note ?? null,
    pain: r.pain ?? prev?.pain ?? null,
  };
  if (existing >= 0) log[existing] = entry;
  else log.push(entry);
  return { entry, matched, replaced: existing >= 0 };
}

/** Planned runs before yesterday that no run completed: skipped (one day of grace). */
function markMissed(sessions: BlockSession[], today: string): BlockSession[] {
  const cutoff = addDaysYMD(today, -1);
  const missed: BlockSession[] = [];
  for (const s of sessions) {
    if (s.status === "planned" && s.date < cutoff && RUN_TYPES.has(s.type)) {
      s.status = "skipped";
      missed.push(s);
    }
  }
  return missed;
}

export function logRuns(block: PlanBlock, runs: LoggedRun[], today: string): { block: PlanBlock; outcomes: LogOutcome[]; missed: BlockSession[] } {
  const sessions = block.sessions.map((s) => ({ ...s }));
  const log = block.log.map((e) => ({ ...e }));
  const outcomes = [...runs]
    .sort((a, b) => a.features.activity_date.localeCompare(b.features.activity_date))
    .map((r) => ingest(sessions, log, r));
  const missed = markMissed(sessions, today);
  log.sort((a, b) => a.date.localeCompare(b.date));
  // Keep the log to its cap, oldest out first.
  while (log.length > 400) log.shift();
  const { check: _c, ...rest } = block;
  void _c;
  return { block: sealBlock({ ...rest, sessions, log }), outcomes, missed };
}
