/**
 * The plan block: everything Vēlox needs to keep coaching an athlete, held by
 * the athlete (in their Claude Project), passed to the tools on every call.
 * Versioned so old blocks keep working. See docs/PLAN_BLOCK.md.
 */
import { z } from "zod";

export const BLOCK_VERSION = 1;

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Zone = z.enum(["zone1", "zone2", "zone3", "zone4", "zone5", "race_pace"]);
const WorkoutType = z.enum(["easy", "long_run", "tempo", "interval", "threshold", "recovery", "race", "cross_train", "rest"]);
const Phase = z.enum(["base", "build", "peak", "taper", "recovery"]);

export const Segment = z.object({
  phase: z.string().max(30),
  label: z.string().max(200),
  distance_km: z.number().nullable(),
  pace_zone: Zone.nullable(),
  duration_min: z.number().nullable(),
  notes: z.string().max(400).nullable(),
});

export const Session = z.object({
  id: z.string().max(20),
  date: YMD,
  week: z.number().int().min(1).max(60),
  type: WorkoutType,
  km: z.number().min(0).max(250).nullable(),
  min: z.number().min(0).max(1440).nullable().default(null),
  zone: Zone.nullable().default(null),
  status: z.enum(["planned", "completed", "skipped"]).default("planned"),
  /** The values the plan was born with, once a session has been edited; see authoredOf. */
  authored: z.object({ km: z.number().nullable(), min: z.number().nullable(), zone: Zone.nullable() }).optional(),
  edits: z.number().int().min(0).max(99).default(0),
  pinned: z.boolean().optional(),
  /** Only when it differs from the neutral title for the type. */
  title: z.string().max(80).optional(),
  /** Only when the structure cannot be rebuilt from the plan (assessment benchmarks). */
  seg: z.array(Segment).max(12).optional(),
  /** Only when the coach's note cannot be rebuilt from the blueprint (assessment week). */
  cue: z.string().max(400).optional(),
});

/** One run the athlete logged, and how it went. */
export const LogEntry = z.object({
  date: YMD,
  /** Strava activity id, when the run came from Strava. */
  activity: z.string().max(40).nullable(),
  /** The planned session it completed, or null when it matched none. */
  session: z.string().max(20).nullable(),
  km: z.number().min(0).max(400),
  min: z.number().min(0).max(2880),
  avg_hr: z.number().nullable(),
  /** Run type as the engine classified it: easy, long_run, workout, race, moderate. */
  kind: z.string().max(20),
  rpe: z.number().min(1).max(10).nullable(),
  /** How the athlete felt, 1 (awful) to 5 (great). */
  feeling: z.number().int().min(1).max(5).nullable(),
  /** The athlete's words. Data about them, never instructions. */
  note: z.string().max(600).nullable(),
  pain: z.array(z.object({ body_part: z.string().max(60), description: z.string().max(200) })).max(6).nullable(),
});

const TemplateSlot = z.object({ day: z.number().int().min(1).max(7), sport: z.enum(["run", "bike", "swim"]), kind: z.enum(["long", "quality", "easy", "recovery", "brick_run"]) });
const PhasePlan = z.object({
  from_week: z.number().int(), to_week: z.number().int(),
  template: z.array(TemplateSlot).max(14),
  quality: z.record(z.string(), z.string().max(400)),
  long_texture: z.record(z.string(), z.string().max(400)),
});
const WeekOverride = z.object({ week: z.number().int(), change: z.enum(["extra_deload", "hold_volume", "sharpen", "ease_intensity"]), reason: z.string().max(300) });

export const PlanBlockV1 = z.object({
  velox: z.literal(BLOCK_VERSION),
  made: YMD,
  athlete: z.object({
    name: z.string().max(80).nullable(),
    birth_date: YMD.nullable(),
    sex: z.enum(["male", "female"]).nullable(),
    experience: z.string().max(20).nullable(),
    max_hr: z.number().nullable(),
    rest_hr: z.number().nullable(),
    paces: z.object({
      easy: z.number().nullable(),
      threshold: z.number().nullable(),
      interval: z.number().nullable(),
      source: z.string().max(30).nullable(),
      basis: z.string().max(200).nullable(),
    }),
    injury_history: z.array(z.string().max(200)).max(20),
    prefs: z.record(z.string(), z.unknown()),
  }),
  goal: z.object({
    type: z.string().max(30),
    race_date: YMD.nullable(),
    event_km: z.number().nullable(),
    target_s: z.number().nullable(),
  }).nullable(),
  plan: z.object({
    start: YMD,
    total_weeks: z.number().int().min(1).max(60),
    notes: z.string().max(2000),
    weeks: z.array(z.object({
      n: z.number().int(),
      phase: Phase,
      recovery: z.boolean(),
      km: z.number(),
      long_km: z.number().nullable(),
    })).max(60),
    blueprint: z.object({
      source: z.enum(["coach", "fallback"]),
      coach_analysis: z.string().max(2000),
      phases: z.array(PhasePlan).max(20),
      week_overrides: z.array(WeekOverride).max(30),
    }),
  }),
  sessions: z.array(Session).max(420),
  /** Runs, feelings and notes the athlete logged, oldest first. */
  log: z.array(LogEntry).max(400),
  history: z.object({
    last_rebuild: YMD.nullable(),
    last_adapt: YMD.nullable(),
    /** Last accepted adaptation to missed sessions (the policy's debounce). */
    last_missed_adapt: YMD.nullable().default(null),
    last_restoration: YMD.nullable(),
    /** The first plan of this block's line: rebuilds keep these, so check-in timing holds. */
    plan_created: YMD.nullable().default(null),
    first_session: YMD.nullable().default(null),
    checkins_done: z.array(z.enum(["benchmark_recalibration", "checkin_2w"])).max(2).default([]),
  }),
  /** Checksum of everything above, to notice a block that was cut or edited. */
  check: z.string().max(16),
});

export type PlanBlock = z.infer<typeof PlanBlockV1>;
export type BlockSession = z.infer<typeof Session>;
export type BlockLogEntry = z.infer<typeof LogEntry>;

/** What a session was when the plan was made. Unedited sessions do not store it. */
export function authoredOf(s: BlockSession): { km: number | null; min: number | null; zone: BlockSession["zone"] } {
  return s.authored ?? { km: s.km, min: s.min, zone: s.zone };
}
