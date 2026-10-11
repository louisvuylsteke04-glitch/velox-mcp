/**
 * Shared engine types: what a periodised plan looks like before any session has
 * been written.
 *
 * The engine's output is an ENVELOPE, not a schedule. It says how much of each
 * sport belongs in each week, how long the key session may be, and what the week
 * is for. Turning that into days is lib/plan/schedule.ts; turning it into coached
 * sessions is lib/plan/expand.ts.
 *
 * Every sport is measured in the unit its athletes actually use, and every week
 * also carries TSS so the three can be compared and budgeted against each other.
 */

export type Phase = "base" | "build" | "peak" | "taper" | "recovery";
export type SportKey = "run" | "bike" | "swim";

/**
 * How much a sport matters in this plan.
 *   primary  the goal is in this sport, so it drives periodisation
 *   support  trained to hold fitness and durability, not to peak
 *   off      not scheduled at all
 */
export type SportRole = "primary" | "support" | "off";

export type RunWeek = {
  km: number;
  /** Ceiling for the week's long run. */
  longRunKm: number;
  sessions: number;
  tss: number;
};

export type BikeWeek = {
  hours: number;
  longRideHours: number;
  sessions: number;
  tss: number;
};

export type SwimWeek = {
  /** Distance target. Null for athletes whose swims record no distance. */
  metres: number | null;
  /** Time target, always present: it is the only unit every swimmer can measure. */
  minutes: number;
  /** Longest continuous swim the week should build toward (metres), when known. */
  longestM: number | null;
  sessions: number;
  tss: number;
};

export type EnvelopeWeek = {
  week_number: number;
  phase: Phase;
  isRecovery: boolean;
  /** True when this week should contain a bike-to-run brick (triathlon build+). */
  brick: boolean;
  run: RunWeek | null;
  bike: BikeWeek | null;
  swim: SwimWeek | null;
  /** Combined planned load. */
  tssTotal: number;
  /** Impact-weighted load, the injury-risk view (run 1.0, bike 0.25, swim 0.1). */
  mechanical: number;
  /** Total planned training time in hours, checked against the athlete's budget. */
  hours: number;
};

/** An honest verdict about one dimension of the plan, shown to the athlete when it fails. */
export type Verdict = {
  code: string;
  adequate: boolean;
  note: string | null;
};

export type PlanEnvelope = {
  weeks: EnvelopeWeek[];
  roles: Record<SportKey, SportRole>;
  /** Per-sport and whole-plan honesty checks (long run, long ride, longest swim, time). */
  verdicts: Verdict[];
  /** One paragraph explaining the shape of the block, for the prompt and the plan notes. */
  rationale: string;
  /** Sports whose starting volume came from the athlete's sign-up answer
   *  because synced history was thin (#121, SELF_REPORT_START). */
  selfReportStart?: SportKey[];
};

/** Sessions per week for a sport, by the role it plays in this plan. */
export type SessionBand = { min: number; max: number };

// ── Load estimation ───────────────────────────────────────────────────────────
// Weekly TSS from weekly volume, before any session exists. The intensity factors
// are what a well-distributed week averages out at (roughly 80% easy, 20% quality),
// not the intensity of any single session. Deliberately conservative: this figure
// budgets the week and guards the ramp, and over-estimating it would suppress
// training that is actually fine.

const WEEK_IF_RUN = 0.72;
const WEEK_IF_BIKE = 0.70;
const WEEK_IF_SWIM = 0.75;

const tssFromHours = (hours: number, intensity: number) => Math.round(hours * intensity * intensity * 100);

/** Running hours implied by weekly km at the athlete's own easy pace. */
export function runHours(km: number, easyPaceSecPerKm: number | null): number {
  const pace = easyPaceSecPerKm && easyPaceSecPerKm > 0 ? easyPaceSecPerKm : 360;
  // Quality running is faster than easy pace, so a whole week averages slightly
  // quicker than the easy pace alone.
  return (km * pace * 0.97) / 3600;
}

export function runWeekTss(km: number, easyPaceSecPerKm: number | null): number {
  return tssFromHours(runHours(km, easyPaceSecPerKm), WEEK_IF_RUN);
}

export function bikeWeekTss(hours: number): number {
  return tssFromHours(hours, WEEK_IF_BIKE);
}

export function swimWeekTss(minutes: number): number {
  return tssFromHours(minutes / 60, WEEK_IF_SWIM);
}

/** Swim minutes implied by a metre target at the athlete's own CSS (rest included). */
export function swimMinutes(metres: number, cssSecPer100m: number | null): number {
  const css = cssSecPer100m && cssSecPer100m > 0 ? cssSecPer100m : 130;
  // Session time runs about 15% over pure swimming time once rest and drills are in.
  return Math.round(((metres / 100) * css * 1.15) / 60);
}
