/**
 * Plan ↔ block. A built plan becomes a small block; a block becomes sessions
 * with their full structure, paces and coach cues again. Structure is rebuilt
 * with the engine's own structurePlan, so it is exactly what the plan would
 * carry, and only what cannot be rebuilt (assessment benchmarks) is stored.
 */
import type { GeneratedPlan, GeneratedSession, SessionSegment, WorkoutType } from "../engine/types/calendar";
import type { AthleteProfile } from "../engine/plan/profile";
import type { PlanEnvelope } from "../engine/plan/types";
import type { BuildPlanResult, PlanGoal } from "../engine/plan/build";
import { structurePlan } from "../engine/plan/workouts";
import { sessionGuidance, toStoredBlueprint } from "../engine/plan/guidance";
import { neutralTitle } from "../engine/plan/race-day";
import { raceKmFor } from "../engine/predict/race-predictor";
import { addDaysYMD } from "../engine/dates";
import { BLOCK_VERSION, type BlockSession, type PlanBlock } from "./schema";
import { sealBlock } from "./codec";

export type BlockAthlete = {
  name: string | null;
  birth_date: string | null;
  sex: "male" | "female" | null;
  experience: string | null;
  max_hr: number | null;
  rest_hr: number | null;
  injury_history: string[];
};

const sameSegs = (a: SessionSegment[] | null | undefined, b: SessionSegment[] | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Session ids: the date, plus a counter when a day holds more than one session. */
function sessionId(date: string, used: Map<string, number>): string {
  const n = (used.get(date) ?? 0) + 1;
  used.set(date, n);
  return n === 1 ? date : `${date}.${n}`;
}

/** The pieces of a profile and envelope that structurePlan reads, rebuilt from a block. */
function structureInputs(block: PlanBlock): { envelope: PlanEnvelope; profile: AthleteProfile } {
  const envelope = {
    weeks: block.plan.weeks.map((w) => ({ week_number: w.n, phase: w.phase, isRecovery: w.recovery })),
  } as unknown as PlanEnvelope;
  const profile = {
    experienceLevel: block.athlete.experience,
    run: { easyPaceSecPerKm: block.athlete.paces.easy, thresholdPaceSecPerKm: block.athlete.paces.threshold, intervalPaceSecPerKm: block.athlete.paces.interval },
    bike: { ftp: { value: null } },
    swim: { css: { value: null }, distanceRecorded: false },
  } as unknown as AthleteProfile;
  return { envelope, profile };
}

function racePaceOf(goal: PlanBlock["goal"]): number | null {
  if (!goal?.target_s) return null;
  const km = raceKmFor(goal.type, goal.event_km);
  return km ? goal.target_s / km : null;
}

/** Segments the engine would attach to each session of the block, keyed by session id. */
export function rebuildSegments(block: PlanBlock, sessions: BlockSession[] = block.sessions): Map<string, SessionSegment[] | null> {
  const { envelope, profile } = structureInputs(block);
  const byWeek = new Map<number, { id: string; s: GeneratedSession }[]>();
  for (const bs of sessions) {
    const s: GeneratedSession = {
      day_of_week: 0, title: bs.title ?? "", workout_type: bs.type as WorkoutType, sport: "run",
      target_distance_km: bs.km, target_duration_min: bs.min, target_pace_zone: bs.zone,
    };
    const list = byWeek.get(bs.week) ?? [];
    list.push({ id: bs.id, s });
    byWeek.set(bs.week, list);
  }
  const plan: GeneratedPlan = {
    plan_notes: "",
    weeks: [...byWeek.entries()].map(([n, list]) => ({ week_number: n, phase: "base", target_weekly_km: 0, workouts: list.map((x) => x.s) })),
  };
  structurePlan(plan, envelope, profile, { racePaceSecPerKm: racePaceOf(block.goal), goalType: block.goal?.type ?? "improve_fitness" });
  const out = new Map<string, SessionSegment[] | null>();
  for (const list of byWeek.values()) for (const x of list) out.set(x.id, x.s.segments?.length ? x.s.segments : null);
  return out;
}

export function blockFromPlan(args: {
  result: BuildPlanResult;
  profile: AthleteProfile;
  athlete: BlockAthlete;
  goal: PlanGoal | null;
  today: string;
  prefs: Record<string, unknown>;
}): PlanBlock {
  const { result, profile, athlete, goal, today } = args;
  const used = new Map<string, number>();
  const sessions: (BlockSession & { _segs: SessionSegment[] | null; _cue: string | null })[] = [];
  for (const week of result.plan.weeks) {
    for (const s of week.workouts) {
      const date = addDaysYMD(result.planStart, (week.week_number - 1) * 7 + (s.day_of_week - 1));
      if (date < today) continue;
      const title = s.title?.trim();
      sessions.push({
        id: sessionId(date, used),
        date,
        week: week.week_number,
        type: s.workout_type,
        km: s.target_distance_km,
        min: s.target_duration_min ?? null,
        zone: s.target_pace_zone,
        status: "planned",
        edits: 0,
        ...(s.workout_type === "race" ? { pinned: true } : {}),
        ...(title && title !== neutralTitle(s.workout_type, s.sport ?? null) ? { title } : {}),
        _segs: s.segments?.length ? s.segments : null,
        _cue: s.coach_cue ?? null,
      });
    }
  }

  const unsealed: Omit<PlanBlock, "check"> = {
    velox: BLOCK_VERSION,
    made: today,
    athlete: {
      ...athlete,
      paces: {
        easy: profile.run.easyPaceSecPerKm,
        threshold: profile.run.thresholdPaceSecPerKm,
        interval: profile.run.intervalPaceSecPerKm,
        source: profile.run.paceAnchor?.source ?? null,
        basis: profile.run.paceAnchor?.basis ?? null,
      },
      prefs: args.prefs,
    },
    goal: goal ? { type: goal.type, race_date: goal.raceDate, event_km: goal.eventDistanceKm, target_s: goal.targetTimeSecs } : null,
    plan: {
      start: result.planStart,
      total_weeks: result.totalWeeks,
      notes: result.plan.plan_notes,
      weeks: result.envelope.weeks.map((w) => {
        const pw = result.plan.weeks.find((x) => x.week_number === w.week_number);
        return {
          n: w.week_number,
          phase: w.phase,
          recovery: w.isRecovery,
          km: pw?.target_weekly_km ?? w.run?.km ?? 0,
          long_km: w.run?.longRunKm ?? null,
        };
      }),
      blueprint: {
        source: result.blueprint.source,
        coach_analysis: result.blueprint.coach_analysis,
        phases: result.blueprint.phases,
        week_overrides: result.blueprint.week_overrides,
      },
    },
    sessions: sessions.map(({ _segs: _s, _cue: _c, ...rest }) => { void _s; void _c; return rest; }),
    log: [],
    history: {
      last_rebuild: null, last_adapt: null, last_missed_adapt: null, last_restoration: null,
      plan_created: today, first_session: sessions[0]?.date ?? null, checkins_done: [],
    },
  };

  // Store structure and cues only where the engine could not rebuild them from the block.
  const sealedProbe = sealBlock(unsealed);
  const rebuilt = rebuildSegments(sealedProbe);
  const stored = toStoredBlueprint({ ...sealedProbe.plan.blueprint, plan_notes: sealedProbe.plan.notes }, 0);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!sameSegs(s._segs, rebuilt.get(s.id))) unsealed.sessions[i].seg = s._segs ?? [];
    const cue = sessionGuidance(stored, { week_number: s.week, sport: "run", workout_type: s.type, title: s.title ?? neutralTitle(s.type, "run") });
    if ((s._cue ?? null) !== cue) unsealed.sessions[i].cue = s._cue ?? "";
  }
  return sealBlock(unsealed);
}

export type SessionView = {
  id: string;
  date: string;
  week: number;
  phase: string | null;
  title: string;
  type: string;
  km: number | null;
  min: number | null;
  zone: string | null;
  status: string;
  pinned: boolean;
  segments: SessionSegment[] | null;
  coach_cue: string | null;
};

/** Sessions between two dates (inclusive), with structure and coach guidance. */
export function sessionsBetween(block: PlanBlock, from: string, to: string): SessionView[] {
  const picked = block.sessions.filter((s) => s.date >= from && s.date <= to);
  const weeksTouched = new Set(picked.map((s) => s.week));
  // Rebuild structure over whole weeks, since a session's structure depends on its place in the week.
  const segs = rebuildSegments(block, block.sessions.filter((s) => weeksTouched.has(s.week)));
  const stored = toStoredBlueprint({ ...block.plan.blueprint, plan_notes: block.plan.notes }, 0);
  return picked
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((s) => {
      const title = s.title ?? neutralTitle(s.type, "run");
      return {
        id: s.id, date: s.date, week: s.week,
        phase: block.plan.weeks.find((w) => w.n === s.week)?.phase ?? null,
        title, type: s.type, km: s.km, min: s.min, zone: s.zone, status: s.status, pinned: !!s.pinned,
        segments: s.seg !== undefined ? (s.seg.length ? s.seg : null) : segs.get(s.id) ?? null,
        coach_cue: s.cue !== undefined ? (s.cue || null) : sessionGuidance(stored, { week_number: s.week, sport: "run", workout_type: s.type, title }),
      };
    });
}
