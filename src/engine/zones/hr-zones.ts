/**
 * Heart-rate zone calculations.
 *
 * Uses the classic 5-zone model keyed to % of max HR.
 * resolveMaxHR() is the single entry-point for determining max HR — it
 * prefers a manual value, then falls back to peak activity HR (×1.05 buffer),
 * then the 220-age formula, and finally signals "unavailable".
 */

export type HRZone = {
  zone:        number;
  name:        string;
  description: string;
  minBpm:      number;
  maxBpm:      number;
  minPct:      number;
  maxPct:      number;
  color:       string;
  benefit:     string;
};

export type HRZoneSource =
  | "manual"
  | "estimated_activity"
  | "estimated_age"
  | "unavailable";

const ZONE_DEFINITIONS = [
  { zone: 1, name: "Recovery",  description: "Very easy", minPct: 50, maxPct: 60,  color: "#64748b", benefit: "Active recovery, blood flow" },
  { zone: 2, name: "Aerobic",   description: "Easy",      minPct: 60, maxPct: 70,  color: "#4b8ef0", benefit: "Base aerobic fitness, fat burning" },
  { zone: 3, name: "Tempo",     description: "Moderate",  minPct: 70, maxPct: 80,  color: "#34d399", benefit: "Aerobic capacity, lactate clearance" },
  { zone: 4, name: "Threshold", description: "Hard",      minPct: 80, maxPct: 90,  color: "#f59e0b", benefit: "Lactate threshold, race-pace work" },
  { zone: 5, name: "VO2 Max",   description: "Very hard", minPct: 90, maxPct: 100, color: "#f87171", benefit: "Maximum aerobic power" },
];

/** The five default upper-bound percentages (60/70/80/90/100) used by the
 *  Coggan model. Stored separately so the Settings UI can show "Reset". */
export const DEFAULT_HR_ZONE_MAX_PCTS: readonly [number, number, number, number, number] = [60, 70, 80, 90, 100];
export const DEFAULT_HR_ZONE_MIN_PCT = 50;

/**
 * Validate and normalise a user-supplied set of zone upper bounds. Must be
 * five strictly-ascending integers between 51 and 100. Anything else falls
 * back to the defaults so a malformed value can never corrupt the display.
 */
export function normaliseHRZoneMaxPcts(input: unknown): readonly [number, number, number, number, number] | null {
  if (!Array.isArray(input) || input.length !== 5) return null;
  const arr = input.map(x => typeof x === "number" ? Math.round(x) : NaN);
  if (arr.some(x => !Number.isFinite(x) || x < 51 || x > 100)) return null;
  for (let i = 1; i < 5; i++) {
    if (arr[i] <= arr[i - 1]) return null;
  }
  return arr as unknown as readonly [number, number, number, number, number];
}

/**
 * Build the five HR zones for a given max-HR value. If the athlete has
 * customised the upper-bound percentages they take precedence; otherwise the
 * default Coggan bands are used.
 */
export function computeHRZones(maxHR: number, overrides?: readonly number[] | null): HRZone[] {
  const normalised = normaliseHRZoneMaxPcts(overrides ?? null);
  const maxPcts: readonly number[] = normalised ?? DEFAULT_HR_ZONE_MAX_PCTS;
  return ZONE_DEFINITIONS.map((z, i) => {
    const maxPct = maxPcts[i];
    const minPct = i === 0 ? DEFAULT_HR_ZONE_MIN_PCT : maxPcts[i - 1];
    return {
      ...z,
      minPct,
      maxPct,
      minBpm: Math.round(maxHR * minPct / 100),
      maxBpm: Math.round(maxHR * maxPct / 100),
    };
  });
}

/**
 * Determine the best available max-HR estimate and its confidence source.
 *
 * Priority:
 *   1. Manual value set by the athlete (most accurate)
 *   2. Peak HR observed in recent activities × 1.05 (activity-derived)
 *   3. 220 − age formula (rough age-based estimate)
 *   4. null / "unavailable" if none of the above can be applied
 */
export function resolveMaxHR(
  manualMaxHR:     number | null,
  dateOfBirth:     string | null,
  peakActivityHR:  number | null,
  /** Today as YYYY-MM-DD, for the age estimate. (Ported change: was new Date().) */
  today:           string,
): { maxHR: number | null; source: HRZoneSource } {
  if (manualMaxHR && manualMaxHR > 100) {
    return { maxHR: manualMaxHR, source: "manual" };
  }
  if (peakActivityHR && peakActivityHR > 140) {
    // 1.05 buffer: real max HR is typically slightly above the highest recorded value
    return { maxHR: Math.round(peakActivityHR * 1.05), source: "estimated_activity" };
  }
  if (dateOfBirth) {
    const age = new Date(today).getFullYear() - new Date(dateOfBirth).getFullYear();
    return { maxHR: 220 - age, source: "estimated_age" };
  }
  return { maxHR: null, source: "unavailable" };
}
