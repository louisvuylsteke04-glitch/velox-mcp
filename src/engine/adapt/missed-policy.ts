/**
 * Missed-session adaptation policy (#86 E4): decides whether a miss should be
 * adapted to, escalated to a one-time re-entry rebuild, or left alone.
 * Ported from the Vēlox web app's lib/missed-session-policy.ts with the env-var
 * configs replaced by their defaults.
 *
 * The current bug this replaces: an athlete who stops running produces a new
 * miss every night, so the cron runs a full adaptation every night, each one a
 * fresh decision with no knowledge of the previous. Fourteen nightly trims where
 * one re-entry rebuild was warranted.
 *
 * Pure and DB-free (tested in scripts/adaptation-guard-tests.ts). The cron
 * gathers the inputs (app/api/cron/detect-missed-workouts) and only consults
 * this when ADAPT_CRON_DEBOUNCE is on for the athlete. Sessions are still
 * marked skipped regardless: compliance stays honest, only the LLM call is
 * debounced.
 */

import { daysBetweenYMD } from "../dates";

export type MissedPolicyConfig = {
  /** No second missed-session adaptation within this many days, absent a material change. */
  debounceDays: number;
  /** This many consecutive completed weeks below the volume threshold = structural absence. */
  structuralWeeks: number;
  /** "Below" means under this % of the week's target volume. */
  structuralBelowPct: number;
  /** A race this close makes an adaptation material despite the debounce. */
  raceWindowDays: number;
  /** A pinned session this close makes an adaptation material despite the debounce. */
  pinnedWindowDays: number;
  /** No second rebuild within this many days: the zero weeks that made an
   *  absence structural stay in history after the athlete returns, so without
   *  a cooldown one logged run followed by one miss would trigger rebuild #2. */
  rebuildCooldownDays: number;
};

/** The web app's defaults (its env vars unset). */
export const DEFAULT_MISSED_POLICY: MissedPolicyConfig = {
  debounceDays: 3,
  structuralWeeks: 3,
  structuralBelowPct: 50,
  raceWindowDays: 14,
  pinnedWindowDays: 7,
  rebuildCooldownDays: 14,
};

/** One fully completed plan week: what the plan asked for vs what was run.
 *  Ordered oldest -> newest; only weeks whose 7 days are entirely in the past. */
export type WeekActual = { weekStart: string; actualKm: number; targetKm: number };

export type MissedPolicyInput = {
  today: string; // YYYY-MM-DD
  /** Most recent accepted missed_session adaptation (ISO timestamp), rebuilds included. */
  lastMissedAdaptAt: string | null;
  /** Most recent re-entry rebuild (suggestion rows tagged reentry_rebuild). */
  lastRebuildAt: string | null;
  /** Most recent logged run (YYYY-MM-DD). */
  lastRunLoggedAt: string | null;
  /** Recent fully completed weeks, oldest -> newest. */
  completedWeeks: WeekActual[];
  /** An active/monitoring health concern new or re-mentioned since lastMissedAdaptAt. */
  newHealthConcernSince: boolean;
  /** A race inside raceWindowDays, or a pinned session inside pinnedWindowDays. */
  raceOrPinnedNear: boolean;
  config: MissedPolicyConfig;
};

export type MissedPolicyDecision =
  | { action: "adapt"; reason: string }
  | { action: "rebuild"; reason: string }
  | { action: "skip"; reason: string };

/** The trailing run of completed weeks below the structural threshold. */
export function consecutiveWeeksBelow(weeks: WeekActual[], belowPct: number): number {
  let n = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i];
    if (w.targetKm > 0 && w.actualKm < w.targetKm * belowPct / 100) n++;
    else break;
  }
  return n;
}

// ── Restoration window (#86 E5) ─────────────────────────────────────────────

export type RestorationConfig = {
  /** This many consecutive completed weeks must meet target before restoring. */
  meetWeeks: number;
  /** "Meeting" a week means at least this % of its target volume. */
  meetPct: number;
  /** At most one restoration review per this many days. */
  intervalDays: number;
  /** A session counts as reduced when more than this % below authored. */
  driftPct: number;
};

/** The web app's defaults (its env vars unset). */
export const DEFAULT_RESTORATION: RestorationConfig = {
  meetWeeks: 2,
  meetPct: 90,
  intervalDays: 7,
  driftPct: 5,
};

/** Health-concern types that hold restoration shut: a plan reduced around a
 *  physical problem stays reduced until the concern is resolved. The athlete
 *  meeting targets does not override an active niggle. */
export const RESTORATION_BLOCKING_CONCERNS = new Set(["pain", "injury", "soreness", "illness", "fatigue"]);

/** The window is open when the athlete has EARNED the climb back: the last
 *  meetWeeks completed weeks each reached meetPct% of their target, and no
 *  physical health concern is active. */
export function restorationWindowOpen(
  completedWeeks: WeekActual[],
  hasBlockingConcern: boolean,
  config: RestorationConfig,
): boolean {
  if (hasBlockingConcern) return false;
  const recent = completedWeeks.slice(-config.meetWeeks);
  if (recent.length < config.meetWeeks) return false;
  return recent.every(w => w.targetKm > 0 && w.actualKm >= w.targetKm * config.meetPct / 100);
}

/** Cadence + preconditions for firing one weekly restoration review. */
export function shouldRunRestorationReview(input: {
  today: string;
  windowOpen: boolean;
  hasDrift: boolean;
  lastReviewAt: string | null;
  config: RestorationConfig;
}): { run: boolean; reason: string } {
  if (!input.windowOpen) return { run: false, reason: "restoration window closed" };
  if (!input.hasDrift) return { run: false, reason: "no forward session sits below authored" };
  if (input.lastReviewAt) {
    const days = daysBetweenYMD(input.lastReviewAt.slice(0, 10), input.today);
    if (days < input.config.intervalDays) {
      return { run: false, reason: `restoration review ran ${days} day(s) ago (interval ${input.config.intervalDays})` };
    }
  }
  return { run: true, reason: "window open, drift present, interval elapsed" };
}

export function decideMissedSessionAction(input: MissedPolicyInput): MissedPolicyDecision {
  const { config } = input;
  const belowWeeks = consecutiveWeeksBelow(input.completedWeeks, config.structuralBelowPct);
  const structural = belowWeeks >= config.structuralWeeks;

  // 1. Suppression: a re-entry rebuild is THE response to an absence. Until the
  //    athlete actually logs a run, there is nothing new to coach; more nightly
  //    adaptations would just re-litigate the rebuild.
  if (input.lastRebuildAt) {
    const rebuildDay = input.lastRebuildAt.slice(0, 10);
    const ranSince = input.lastRunLoggedAt != null && input.lastRunLoggedAt > rebuildDay;
    if (!ranSince) {
      return { action: "skip", reason: `re-entry rebuild already done on ${rebuildDay}; suppressed until a run is logged` };
    }
  }

  // 2. Structural escalation: one explicit rebuild instead of another trim.
  //    The cooldown stops rebuild #2 when the zero weeks are still in history
  //    right after the athlete returns; inside it, structural degrades to the
  //    normal debounced cadence below.
  if (structural) {
    const cooldownOver = input.lastRebuildAt == null
      || daysBetweenYMD(input.lastRebuildAt.slice(0, 10), input.today) >= config.rebuildCooldownDays;
    if (cooldownOver) {
      return { action: "rebuild", reason: `structural absence: ${belowWeeks} consecutive weeks below ${config.structuralBelowPct}% of target volume` };
    }
  }

  // 3. Debounce: a recent adaptation already answered this situation.
  if (input.lastMissedAdaptAt) {
    const daysSince = daysBetweenYMD(input.lastMissedAdaptAt.slice(0, 10), input.today);
    if (daysSince < config.debounceDays) {
      if (input.newHealthConcernSince) {
        return { action: "adapt", reason: `material change: new health concern since the last adaptation ${daysSince} day(s) ago` };
      }
      if (input.raceOrPinnedNear) {
        return { action: "adapt", reason: `material change: a race or pinned session is close enough that the miss affects it` };
      }
      return { action: "skip", reason: `debounced: missed-session adaptation ran ${daysSince} day(s) ago (window ${config.debounceDays}) and nothing material changed` };
    }
  }

  return { action: "adapt", reason: "no recent missed-session adaptation" };
}
