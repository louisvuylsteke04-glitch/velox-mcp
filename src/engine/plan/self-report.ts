/**
 * Starting volume from what the athlete told us at sign-up (#121, C1).
 *
 * Only for athletes whose synced history is too thin to stand on: the engine
 * otherwise opened them at an experience default (12 / 25 / 35 km of running)
 * no matter what they said they run. The rule, per sport:
 *
 *   - a report at or below the experience default is believed as given: a lower
 *     number is always the safe direction;
 *   - above it, start at 80% of the report, never below the default and never
 *     above the level's cap. An unverified number gets a margin, not blind trust.
 *
 * Synced data wins whenever it exists. The callers decide "thin"; this module
 * only turns a report into a starting number.
 */

export const SELF_REPORT_FRACTION = 0.8;

/** Ceiling on a self-reported running start (km/week), by level. */
export const SELF_REPORT_RUN_CAP_KM: Record<string, number> = { beginner: 30, intermediate: 60, advanced: 90 };

/** Fewer non-zero weeks than this in the 8-week history is "thin". The same bar
 *  computeStartingVolume already sets for demonstrated capacity. */
export const THIN_RUN_WEEKS = 2;
/** Fewer sessions than this in the last 4 weeks makes bike or swim history thin. */
export const THIN_SESSIONS_4W = 2;

/** The starting volume a report implies, or null when there is no usable report. */
export function startFromSelfReport(report: number | null | undefined, experienceDefault: number, cap: number): number | null {
  if (report == null || !Number.isFinite(report) || report <= 0) return null;
  if (report <= experienceDefault) return report;
  return Math.min(cap, Math.max(experienceDefault, report * SELF_REPORT_FRACTION));
}
