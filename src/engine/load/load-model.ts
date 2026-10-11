/**
 * Fitness (CTL), fatigue (ATL) and form (TSB) day by day, plus ramp rate,
 * monotony and strain. Ported from the Vēlox web app's lib/multisport-load.ts,
 * running only: bike and swim series and the mechanical weighting are removed.
 * With no cross-training the web app's numbers are identical to these.
 */
import { rpeLoad, NO_DATA_LOAD_PER_HOUR } from "./training-load";

export type DailyLoad = {
  date: string;
  run: number;
  total: number;
  ctl: number;   // fitness (42-day EWMA)
  atl: number;   // fatigue (7-day EWMA)
  tsb: number;   // form (ctl - atl)
};

export type WeeklyLoad = { week_start: string; run: number; total: number };

export type LoadSummary = {
  ctl: number;
  atl: number;
  tsb: number;
  formLabel: "Fresh" | "Neutral" | "Fatigued";
  rampPct: number | null;
  monotony: number | null;
  strain: number | null;
  weekLoad7: number;
  hasData: boolean;
};

export type LoadModel = { daily: DailyLoad[]; weekly: WeeklyLoad[]; summary: LoadSummary };

/* EWMA time constants, identical to snapshot.ts. */
const K_ATL = 1 - Math.exp(-1 / 7);
const K_CTL = 1 - Math.exp(-1 / 42);

const DAY_MS = 86_400_000;

function parseUtc(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr: string): string {
  const d = parseUtc(dateStr);
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // 0 = Monday
  x.setUTCDate(x.getUTCDate() - dow);
  return isoDate(x);
}

export type RunDay = {
  activity_date: string;
  trimp: number | null;
  moving_time_min?: number | null;
  distance_km?: number | null;
  data_quality_score?: number | null;
  rpe?: number | null;
};

/**
 * Load for one run: the stored TRIMP, except a run with no HR and no distance
 * where TRIMP is a flat guess, so a logged RPE substitutes.
 */
function runLoad(r: RunDay): number {
  const stored = Math.round(r.trimp ?? 0);
  const noHr = r.data_quality_score != null && r.data_quality_score < 0.9;
  const noDistance = r.distance_km == null || r.distance_km <= 0;
  if (!noHr || !noDistance || r.rpe == null) return stored;
  const hours = (r.moving_time_min ?? 0) / 60;
  return rpeLoad(hours, r.rpe, NO_DATA_LOAD_PER_HOUR.runPaceProxy) ?? stored;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export function formRead(tsb: number): LoadSummary["formLabel"] {
  if (tsb > 5) return "Fresh";
  if (tsb >= -15) return "Neutral";
  return "Fatigued";
}

/** Every calendar day from startDate to endDate, so the EWMA warms up correctly. */
export function buildRunLoadModel(opts: { runs: RunDay[]; startDate: string; endDate: string }): LoadModel {
  const { runs, startDate, endDate } = opts;

  const run: Record<string, number> = {};
  for (const r of runs) {
    if (!r.activity_date) continue;
    run[r.activity_date] = (run[r.activity_date] ?? 0) + runLoad(r);
  }

  const daily: DailyLoad[] = [];
  let atl = 0;
  let ctl = 0;
  const end = parseUtc(endDate);
  for (let d = parseUtc(startDate); d <= end; d = new Date(d.getTime() + DAY_MS)) {
    const key = isoDate(d);
    const rl = Math.round(run[key] ?? 0);
    const total = rl;
    atl = atl + K_ATL * (total - atl);
    ctl = ctl + K_CTL * (total - ctl);
    daily.push({
      date: key,
      run: rl, total,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10,
    });
  }

  const weekMap = new Map<string, WeeklyLoad>();
  for (const p of daily) {
    const wk = mondayOf(p.date);
    const w = weekMap.get(wk) ?? { week_start: wk, run: 0, total: 0 };
    w.run += p.run; w.total += p.total;
    weekMap.set(wk, w);
  }
  const weekly = Array.from(weekMap.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));

  const latest = daily[daily.length - 1] ?? { ctl: 0, atl: 0, tsb: 0 };
  const last = (n: number) => daily.slice(Math.max(0, daily.length - n));
  const last7 = last(7);
  const last28 = last(28);
  const sum = (arr: DailyLoad[]) => arr.reduce((a, p) => a + p.total, 0);

  const week7Total = sum(last7);
  const meanWeekly28 = last28.length ? sum(last28) / 4 : 0;
  const rampPct = meanWeekly28 > 0 ? Math.round(((week7Total - meanWeekly28) / meanWeekly28) * 100) : null;

  const daily7 = last7.map((p) => p.total);
  const sd7 = stdev(daily7);
  const mean7 = mean(daily7);
  const monotony = sd7 != null && sd7 > 0 && mean7 != null ? Math.round((mean7 / sd7) * 100) / 100 : null;
  const strain = monotony != null ? Math.round(monotony * week7Total) : null;

  return {
    daily,
    weekly,
    summary: {
      ctl: Math.round(latest.ctl),
      atl: Math.round(latest.atl),
      tsb: Math.round(latest.tsb),
      formLabel: formRead(latest.tsb),
      rampPct,
      monotony,
      strain,
      weekLoad7: Math.round(week7Total),
      hasData: daily.some((p) => p.total > 0),
    },
  };
}
