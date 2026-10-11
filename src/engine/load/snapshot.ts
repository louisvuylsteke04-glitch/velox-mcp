/**
 * Weekly training table, acute:chronic workload ratio and overtraining risk.
 * Ported from `computeAndSaveSnapshot` in the Vēlox web app's
 * lib/dashboard-compute.ts with the database read and write removed and "now"
 * passed in. The arithmetic is unchanged.
 */
import type { RunFeatures } from "./run-features";

export type RiskLevel = "low" | "moderate" | "high" | "unknown";

/** The run fields the snapshot reads. RunFeatures satisfies it. */
export type SnapshotRun = Pick<RunFeatures,
  | "activity_date" | "distance_km" | "trimp" | "average_heartrate_bpm"
  | "time_in_low_intensity_ratio" | "time_in_moderate_intensity_ratio"
  | "time_in_high_intensity_ratio" | "is_easy_run" | "is_quality_run" | "efficiency_factor">;

export type WeekPoint = {
  week_start: string;
  distance_km: number;
  sessions: number;
  long_run_km: number;
  acwr: number | null;
  atl: number;
  ctl: number;
  zone_low_pct: number | null;
  zone_mod_pct: number | null;
  zone_high_pct: number | null;
  easy_pct: number | null;
  quality_pct: number | null;
  avg_efficiency: number | null;
};

export type Snapshot = {
  has_data: boolean;
  last_activity_date: string | null;
  acwr: number | null;
  distance_7d_km: number;
  prior_7d_km: number;
  distance_28d_km: number;
  sessions_7d: number;
  avg_hr_last_7d: number | null;
  long_run_km_last_4w: number;
  overtraining_risk: RiskLevel;
  weekly: WeekPoint[];
};

type WeekAcc = {
  week_start: string;
  distance_km: number;
  max_distance: number;
  trimp: number;
  sessions: number;
  low: number; mod: number; high: number;
  easy: number; quality: number;
  eff_sum: number; eff_n: number;
};

/** Monday of the week containing `dateStr` (YYYY-MM-DD), in UTC. */
export function getMondayStr(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();                 // 0=Sun .. 6=Sat
  const diff = (day === 0 ? -6 : 1) - day;   // days back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split("T")[0];
}

function emptyWeek(week_start: string): WeekAcc {
  return {
    week_start, distance_km: 0, max_distance: 0, trimp: 0,
    sessions: 0, low: 0, mod: 0, high: 0, easy: 0, quality: 0,
    eff_sum: 0, eff_n: 0,
  };
}

/**
 * `runs` should cover the last 16 weeks, sorted oldest first, the window the
 * web app used. `nowMs` is the current instant in epoch milliseconds.
 */
export function computeSnapshot(runs: SnapshotRun[], nowMs: number): Snapshot {
  const acts = runs;
  const hasData = acts.length > 0;
  const todayStr = new Date(nowMs).toISOString().split("T")[0];

  // ── Weekly aggregation ──────────────────────────────────────────────────
  const weekMap: Record<string, WeekAcc> = {};
  for (const a of acts) {
    const monday = getMondayStr(a.activity_date);
    if (!weekMap[monday]) weekMap[monday] = emptyWeek(monday);
    const w = weekMap[monday];
    const d = a.distance_km ?? 0;
    w.distance_km += d;
    w.max_distance = Math.max(w.max_distance, d);
    w.trimp += a.trimp ?? 0;
    w.sessions++;
    w.low  += a.time_in_low_intensity_ratio  ?? 0;
    w.mod  += a.time_in_moderate_intensity_ratio ?? 0;
    w.high += a.time_in_high_intensity_ratio ?? 0;
    if (a.is_easy_run)    w.easy++;
    if (a.is_quality_run) w.quality++;
    if (a.efficiency_factor != null) { w.eff_sum += a.efficiency_factor; w.eff_n++; }
  }

  const dailyTrimp: Record<string, number> = {};
  for (const a of acts) {
    dailyTrimp[a.activity_date] = (dailyTrimp[a.activity_date] ?? 0) + (a.trimp ?? 0);
  }

  // Every week from the first activity week through the current week gets an entry.
  const currentMondayStr = getMondayStr(todayStr);
  const existingWeeks = Object.keys(weekMap).sort();
  const firstWeek = existingWeeks[0] ?? currentMondayStr;
  for (let d = new Date(firstWeek + "T00:00:00Z"); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const key = d.toISOString().split("T")[0];
    if (!weekMap[key]) weekMap[key] = emptyWeek(key);
    if (key >= currentMondayStr) break;
  }

  // Daily ATL and CTL via EWMA, the Banister/Coggan model.
  // ATL (fatigue): τ = 7 days.  CTL (fitness): τ = 42 days.
  const kAtl = 1 - Math.exp(-1 / 7);
  const kCtl = 1 - Math.exp(-1 / 42);
  const dailyAtl: Record<string, number> = {};
  const dailyCtl: Record<string, number> = {};
  let atlPrev = 0, ctlPrev = 0;
  const ewmaEnd = new Date(nowMs);
  ewmaEnd.setUTCHours(23, 59, 59, 0);
  for (let d = new Date(firstWeek + "T00:00:00Z"); d <= ewmaEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().split("T")[0];
    const trimp = dailyTrimp[key] ?? 0;
    atlPrev = atlPrev + kAtl * (trimp - atlPrev);
    ctlPrev = ctlPrev + kCtl * (trimp - ctlPrev);
    dailyAtl[key] = atlPrev;
    dailyCtl[key] = ctlPrev;
  }

  const weekly: WeekPoint[] = Object.values(weekMap)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((w) => {
      // Week-end (Sunday) values; the current week uses today's.
      const wSunday = new Date(new Date(w.week_start).getTime() + 6 * 86400000)
        .toISOString().split("T")[0];
      const lookupDay = wSunday > todayStr ? todayStr : wSunday;
      const atl = dailyAtl[lookupDay] ?? 0;
      const ctl = dailyCtl[lookupDay] ?? 0;
      const n = w.sessions;
      return {
        week_start:    w.week_start,
        distance_km:   Math.round(w.distance_km  * 10) / 10,
        sessions:      n,
        long_run_km:   Math.round(w.max_distance * 10) / 10,
        acwr:          ctl > 0 ? Math.round((atl / ctl) * 100) / 100 : null,
        atl:           Math.round(atl * 10) / 10,
        ctl:           Math.round(ctl * 10) / 10,
        zone_low_pct:  n ? Math.round((w.low  / n) * 100) : null,
        zone_mod_pct:  n ? Math.round((w.mod  / n) * 100) : null,
        zone_high_pct: n ? Math.round((w.high / n) * 100) : null,
        easy_pct:      n ? Math.round((w.easy    / n) * 100) : null,
        quality_pct:   n ? Math.round((w.quality / n) * 100) : null,
        avg_efficiency: w.eff_n > 0 ? Math.round((w.eff_sum / w.eff_n) * 10000) / 10000 : null,
      };
    });

  // ── Snapshot-level metrics ───────────────────────────────────────────────
  const d7  = nowMs - 7  * 86400000;
  const d28 = nowMs - 28 * 86400000;
  const acts7d  = acts.filter(a => +new Date(a.activity_date) >= d7);
  const acts28d = acts.filter(a => +new Date(a.activity_date) >= d28);

  // Headline ACWR: the latest week that has one, from the same EWMA series.
  const acwr = [...weekly].reverse().find((w) => w.acwr != null)?.acwr ?? null;

  const priorMondayD = new Date(currentMondayStr + "T00:00:00Z");
  priorMondayD.setUTCDate(priorMondayD.getUTCDate() - 7);
  const priorMondayStr = priorMondayD.toISOString().split("T")[0];

  const dist7d   = Math.round((weekMap[currentMondayStr]?.distance_km ?? 0) * 10) / 10;
  const prior7d  = Math.round((weekMap[priorMondayStr]?.distance_km   ?? 0) * 10) / 10;
  const dist28d  = Math.round(acts28d.reduce((s, a) => s + (a.distance_km ?? 0), 0) * 10) / 10;
  const longRun  = acts28d.length ? Math.round(Math.max(...acts28d.map(a => a.distance_km ?? 0)) * 10) / 10 : 0;

  const hrVals = acts7d.filter(a => a.average_heartrate_bpm).map(a => a.average_heartrate_bpm!);
  const avgHr  = hrVals.length ? Math.round(hrVals.reduce((s, v) => s + v, 0) / hrVals.length) : null;

  return {
    has_data: hasData,
    last_activity_date: acts.at(-1)?.activity_date ?? null,
    acwr,
    distance_7d_km: dist7d,
    prior_7d_km: prior7d,
    distance_28d_km: dist28d,
    sessions_7d: acts7d.length,
    avg_hr_last_7d: avgHr,
    long_run_km_last_4w: longRun,
    overtraining_risk: acwr === null ? "unknown" : acwr > 1.5 ? "high" : acwr > 1.3 ? "moderate" : "low",
    weekly,
  };
}
