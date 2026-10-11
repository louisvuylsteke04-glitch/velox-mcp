/**
 * Per-sport threshold estimation: cycling FTP and swimming CSS.
 *
 * A threshold is the anchor every prescription hangs off. Without it a plan can
 * only talk about duration, which is why a bike or swim session used to read
 * "45 min, moderate" while a run read "8 km at 4:45/km". These estimators turn
 * the messy history we actually have into one defensible number per sport.
 *
 * Both follow the same three rules:
 *   1. A manual value the athlete entered always wins.
 *   2. Physiologically impossible observations are discarded, not averaged in.
 *      Swim GPS drift routinely produces 1:08/100 m for a recreational swimmer,
 *      and one such lap would poison every zone in the plan.
 *   3. Several independent candidates are computed and the HIGHEST is taken,
 *      because every candidate is a lower bound: you cannot have held that
 *      power/pace for that long with a threshold below it.
 *
 * Rule 3 matters more than it looks. The previous FTP estimator used a single
 * candidate (best normalized power on a 30-75 min ride, times 0.95) and
 * systematically under-read athletes whose hard efforts are long rides. One real
 * case: a rider averaging 232 W normalized across 12.8 h/week was assigned an FTP
 * of 234 W, implying an average intensity factor of 0.99 sustained for weeks,
 * which inflated their weekly TSS to ~1070 and told the coach they were
 * permanently overreached.
 */

// ── Cycling FTP ───────────────────────────────────────────────────────────────

/** Plausible FTP bounds (W). Outside this, treat the estimate as noise. */
const FTP_MIN = 80;
const FTP_MAX = 500;

/**
 * Fraction of FTP a trained rider can hold for a given duration. Inverting these
 * turns "I held X W for this long" into "my FTP is at least Y". Each is the
 * OPTIMISTIC end of what is sustainable, so every candidate is a true lower bound.
 *
 * Which power metric matters here. Normalized power is the right figure for short
 * efforts, but it INFLATES on long variable rides: it is a 30-second rolling
 * fourth-power mean, so a hilly six-hour ride can show an NP 10% above its
 * average while the aerobic demand tracks the average. Reading a long ride's NP
 * as if it were steady power hands back an FTP nobody can hold. So short buckets
 * use NP and long buckets use average power.
 */
const FTP_CURVE: { minMins: number; maxMins: number; fraction: number; metric: "np" | "avg" }[] = [
  // The classic 20 min test: 95% of the effort's power.
  { minMins: 20, maxMins: 40,   fraction: 0.95, metric: "np" },
  // A maximal ~hour effort IS functional threshold power, by definition. In
  // practice this is the candidate that decides the answer for most riders.
  { minMins: 40, maxMins: 80,   fraction: 0.98, metric: "np" },
  // Long-ride fractions are set at the OPTIMISTIC end of what a strong rider can
  // average, so these bounds rarely bind. Set any lower and they start overtaking
  // the hour effort: at 0.80, one athlete's hard 2.75 h ride implied an FTP 10%
  // above their own best hour. A well-trained rider genuinely can average ~88% of
  // threshold for two to three hours in a race, and ~80% for an all-day ride.
  { minMins: 80, maxMins: 180,  fraction: 0.88, metric: "avg" },
  { minMins: 180, maxMins: 900, fraction: 0.80, metric: "avg" },
];
/**
 * Ceiling on the intensity factor an athlete's upper-quartile ride can sit at.
 * Above this, the FTP being used is too low rather than the athlete being
 * superhuman. Deliberately close to 1: this candidate exists only to rescue a
 * rider whose every ride is hard and who never does a measurable maximal effort,
 * so it should almost never be the binding constraint.
 */
const SUSTAINED_IF_CEILING = 0.95;
/**
 * FTP cannot sit far above the best power actually recorded for a sustained
 * effort: threshold is roughly an hour's maximum. Long-ride extrapolation can
 * otherwise drift upward without any single ride supporting it, so the estimate is
 * capped just above the best observed sustained power.
 */
const FTP_CEILING_OVER_BEST_NP = 1.10;

export type FtpRideInput = {
  moving_time_min: number | null;
  normalized_power?: number | null;
  weighted_average_watts?: number | null;
  average_watts?: number | null;
};

export type ThresholdEstimate<T> = {
  value: T | null;
  source: "manual" | "estimated" | null;
  /** Short, human explanation of where the number came from, for prompts and UI. */
  basis: string | null;
};

/** Normalized power for a ride, falling back to a nudged average when the ride
 *  carries no NP (a plain average understates a variable ride). */
function rideNp(r: FtpRideInput): number | null {
  const np = r.normalized_power ?? r.weighted_average_watts ?? null;
  if (np != null && np > 0) return np;
  if (r.average_watts != null && r.average_watts > 0) return r.average_watts * 1.05;
  return null;
}

/** Average power, falling back to NP when only NP was recorded. */
function rideAvg(r: FtpRideInput): number | null {
  if (r.average_watts != null && r.average_watts > 0) return r.average_watts;
  return r.normalized_power ?? r.weighted_average_watts ?? null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/**
 * Estimate FTP (W) from ride history. Takes the highest of three independent
 * lower bounds so a rider whose only hard efforts are long steady rides is not
 * under-read. Returns null when no ride carries power at all.
 */
export function estimateFtpFromRides(rides: FtpRideInput[], manualFtp?: number | null): ThresholdEstimate<number> {
  if (manualFtp != null && manualFtp >= FTP_MIN / 2 && manualFtp <= FTP_MAX + 100) {
    return { value: Math.round(manualFtp), source: "manual", basis: "set by the athlete" };
  }

  const withPower = rides
    .map((r) => ({ mins: r.moving_time_min ?? 0, np: rideNp(r), avg: rideAvg(r) }))
    .filter((r) => r.mins >= 10 && r.np != null && r.np > 0);
  if (!withPower.length) return { value: null, source: null, basis: null };

  const candidates: { w: number; basis: string }[] = [];

  // 1. One candidate per duration bucket: the best effort in that bucket, read
  //    through what a rider can hold for that long.
  for (const band of FTP_CURVE) {
    const inBand = withPower.filter((r) => r.mins >= band.minMins && r.mins < band.maxMins);
    if (!inBand.length) continue;
    const metric = (r: typeof inBand[number]) => (band.metric === "np" ? r.np : r.avg) ?? 0;
    const best = inBand.reduce((a, b) => (metric(b) > metric(a) ? b : a));
    const w = metric(best);
    if (w <= 0) continue;
    const label = band.metric === "np" ? "normalized" : "average";
    candidates.push({
      w: band.fraction >= 0.95 ? w * band.fraction : w / band.fraction,
      basis: `${Math.round(w)} W ${label} for ${Math.round(best.mins)} min`,
    });
  }

  // 2. The distribution itself. Averaging near threshold across many rides for
  //    weeks is not possible, so a high upper quartile is evidence of a higher
  //    FTP rather than of extraordinary training.
  const solid = withPower.filter((r) => r.mins >= 45).map((r) => r.np as number).sort((a, b) => a - b);
  if (solid.length >= 6) {
    const p75 = percentile(solid, 0.75);
    candidates.push({ w: p75 / SUSTAINED_IF_CEILING, basis: `${Math.round(p75)} W typical hard-ride power across ${solid.length} rides` });
  }

  if (!candidates.length) return { value: null, source: null, basis: null };

  // Every candidate is a lower bound, so the highest wins. With the fractions above
  // calibrated honestly, a maximal hour effort is what decides the answer for most
  // riders, while the long-ride bounds still rescue the rider whose only hour-length
  // ride was an easy one: anchoring on that alone put a strong athlete at 114 W.
  const winner = candidates.reduce((a, b) => (b.w > a.w ? b : a));
  const bestSustainedNp = Math.max(...withPower.filter((r) => r.mins >= 20).map((r) => r.np as number), 0);
  const ceiling = bestSustainedNp > 0 ? bestSustainedNp * FTP_CEILING_OVER_BEST_NP : FTP_MAX;
  const value = Math.round(Math.min(FTP_MAX, ceiling, winner.w));
  // Below the plausible floor the power data itself is not trustworthy (an
  // uncalibrated meter, a trainer reporting nonsense). Returning null keeps the
  // load model on its heart-rate path, which is honest; clamping up to the floor
  // would invent a threshold and make every ride look like a threshold effort.
  if (value < FTP_MIN) return { value: null, source: null, basis: null };
  return { value, source: "estimated", basis: `estimated from ${winner.basis}` };
}

// ── Swimming CSS (critical swim speed) ────────────────────────────────────────

/**
 * Plausible CSS bounds (sec/100 m). The fast end is deliberately just inside
 * elite territory: open-water GPS drift and pool auto-detect errors produce
 * 60-70 s/100 m readings for club swimmers, and a single such lap would drag
 * every prescribed swim pace to something nobody can hold.
 */
const CSS_MIN_SEC = 55;
const CSS_MAX_SEC = 200;
/** A lap has to be this long to say anything about sustained pace on its own.
 *  Shorter laps are drills, sprints, or the rest interval between them. */
const MIN_LAP_M = 150;
/** Minimum aggregated working distance before a session's work-only pace counts. */
const MIN_WORK_M = 200;
/** Minimum session distance before the rest-included session average counts. */
const MIN_SESSION_M = 400;
/** Sustained-effort pace relative to CSS by distance. A 200-400 m rep is run
 *  slightly faster than CSS; a long continuous swim slightly slower. Used to
 *  convert an observed best pace into a CSS figure. */
function cssOffsetForDistance(metres: number): number {
  if (metres <= 400) return 2;    // short reps sit just under CSS pace
  if (metres <= 1000) return -1;  // ~CSS
  if (metres <= 2000) return -4;  // steady swimming is a touch above CSS pace
  return -7;                      // long continuous distance swimming
}

export type SwimLap = { distance_km?: number | null; time_sec?: number | null };
export type SwimInput = {
  distance_km: number | null;
  moving_time_min: number | null;
  swim_pace_sec_per_100m?: number | null;
  laps?: SwimLap[] | null;
};

/**
 * One usable observation: a sustained pace over a known distance.
 *
 * `tier` records how trustworthy the observation is, best first:
 *   1 a single continuous lap of real length. Cleanest evidence there is.
 *   2 the working laps of a session aggregated, with pure-rest laps removed. A
 *     pool set recorded as 60 m laps says plenty once the wall rest is dropped.
 *   3 the whole session average, which still contains rest and so reads slow.
 * Only the best available tier is used, so weak evidence never dilutes strong.
 */
type PaceObservation = { secPer100: number; metres: number; tier: 1 | 2 | 3 };

function plausible(secPer100: number): boolean {
  return Number.isFinite(secPer100) && secPer100 >= CSS_MIN_SEC && secPer100 <= CSS_MAX_SEC;
}

/**
 * Pull every trustworthy sustained-pace observation out of a swim. Laps are far
 * better evidence than the session average, because a pool session's average
 * includes rest: one real case logged 165 s/100 m for a set whose working laps
 * were nearer 110.
 */
function observationsFor(s: SwimInput): PaceObservation[] {
  const out: PaceObservation[] = [];
  const laps = s.laps ?? [];

  // Tier 1: continuous laps of real length.
  for (const lap of laps) {
    const m = (lap.distance_km ?? 0) * 1000;
    const t = lap.time_sec ?? 0;
    if (m < MIN_LAP_M || t <= 0) continue;
    const pace = (t / m) * 100;
    if (plausible(pace)) out.push({ secPer100: pace, metres: m, tier: 1 });
  }

  // Tier 2: the session's working laps, aggregated. A pure-rest lap logs distance
  // 0 with 10-20 seconds on it, so dropping zero-distance laps recovers the real
  // swimming pace of a set that would otherwise read far too slow.
  const work = laps.filter((l) => (l.distance_km ?? 0) > 0 && (l.time_sec ?? 0) > 0);
  if (work.length) {
    const m = work.reduce((a, l) => a + (l.distance_km ?? 0) * 1000, 0);
    const t = work.reduce((a, l) => a + (l.time_sec ?? 0), 0);
    if (m >= MIN_WORK_M) {
      const pace = (t / m) * 100;
      if (plausible(pace)) out.push({ secPer100: pace, metres: m, tier: 2 });
    }
  }

  // Tier 3: the session as a whole, rest included.
  const totalM = (s.distance_km ?? 0) * 1000;
  const mins = s.moving_time_min ?? 0;
  if (totalM >= MIN_SESSION_M) {
    const pace = mins > 0 ? (mins * 60 / totalM) * 100 : s.swim_pace_sec_per_100m ?? 0;
    if (plausible(pace)) out.push({ secPer100: pace, metres: totalM, tier: 3 });
  }
  return out;
}

/**
 * Estimate CSS (sec/100 m) from swim history.
 *
 * True CSS comes from a 400 m and 200 m time trial, which nobody in this app has
 * done. Instead we take the athlete's best sustained pace over a real distance
 * and adjust for how long that effort was. To resist a single bad GPS lap the
 * estimate uses the SECOND-best qualifying observation once there are enough of
 * them, rather than the outright best.
 */
export function estimateCss(swims: SwimInput[], manualCss?: number | null): ThresholdEstimate<number> {
  if (manualCss != null && plausible(manualCss)) {
    return { value: Math.round(manualCss), source: "manual", basis: "set by the athlete" };
  }

  const all = swims.flatMap(observationsFor);
  if (!all.length) return { value: null, source: null, basis: null };

  // Use only the best evidence available: one clean continuous lap beats any
  // number of rest-contaminated session averages.
  const bestTier = Math.min(...all.map((o) => o.tier)) as 1 | 2 | 3;
  const obs = all.filter((o) => o.tier === bestTier);

  // Fastest first. With three or more observations, skip the fastest: it is the
  // one most likely to be a measurement error, and second-fastest is still a
  // best-effort figure.
  const sorted = obs.slice().sort((a, b) => a.secPer100 - b.secPer100);
  const pick = sorted.length >= 3 ? sorted[1] : sorted[0];
  // A rest-included session average understates real swimming speed, so it needs
  // no "slower than CSS" adjustment on top.
  const offset = bestTier === 3 ? 0 : cssOffsetForDistance(pick.metres);
  const css = Math.round(pick.secPer100 + offset);
  if (!plausible(css)) return { value: null, source: null, basis: null };

  const how = bestTier === 1 ? `a continuous ${Math.round(pick.metres)} m`
    : bestTier === 2 ? `${Math.round(pick.metres)} m of working laps`
    : `a ${Math.round(pick.metres)} m session`;
  return {
    value: css,
    source: "estimated",
    basis: `estimated from ${how} at ${fmtSwimPace(pick.secPer100)}/100m`,
  };
}

// ── Zones ─────────────────────────────────────────────────────────────────────

export type SwimZone = { zone: string; label: string; secPer100: number; toSecPer100: number | null };

/**
 * Swim training paces anchored to CSS, in the offsets swim coaches actually use.
 * Aerobic work sits comfortably above CSS pace, threshold work brackets it, and
 * VO2 work is faster than CSS but only sustainable in short reps.
 */
export function swimZonesFromCss(css: number): SwimZone[] {
  return [
    { zone: "zone1", label: "Technique / recovery", secPer100: css + 12, toSecPer100: null },
    { zone: "zone2", label: "Aerobic endurance",    secPer100: css + 6,  toSecPer100: css + 11 },
    { zone: "zone3", label: "Steady / tempo",       secPer100: css + 3,  toSecPer100: css + 5 },
    { zone: "zone4", label: "Threshold (CSS)",      secPer100: css - 2,  toSecPer100: css + 2 },
    { zone: "zone5", label: "VO2 / speed",          secPer100: css - 6,  toSecPer100: css - 3 },
  ];
}

/** mm:ss per 100 m. */
export function fmtSwimPace(secPer100: number): string {
  const s = Math.round(secPer100);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One prompt line: "CSS 1:45/100m. Z2 1:51-1:56, Z3 1:48-1:50, Z4 1:43-1:47, Z5 1:39-1:42." */
export function formatSwimZones(css: number): string {
  const zones = swimZonesFromCss(css).filter((z) => z.zone !== "zone1");
  const parts = zones.map((z) => {
    const fast = fmtSwimPace(Math.min(z.secPer100, z.toSecPer100 ?? z.secPer100));
    const slow = fmtSwimPace(Math.max(z.secPer100, z.toSecPer100 ?? z.secPer100));
    return `${z.zone.toUpperCase().replace("ZONE", "Z")} ${fast}-${slow}`;
  });
  return `CSS ${fmtSwimPace(css)}/100m. ${parts.join(", ")} per 100 m.`;
}
