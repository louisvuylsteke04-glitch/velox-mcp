/**
 * Synthetic, deterministic training data shared by the golden generator
 * (scripts/golden/generate.ts, which runs the original Vēlox web-app code) and
 * the parity tests (which run the port). No real athlete data.
 */
import type { RunInput } from "../../src/engine/load/run-features";

/** "Now" for every golden case: 2026-10-11 08:00 UTC. */
export const NOW_MS = Date.UTC(2026, 9, 11, 8, 0, 0);
export const TODAY = "2026-10-11";
export const START = "2026-06-20"; // 16 weeks before TODAY

export type FixtureRun = RunInput & { rpe: number | null };

export type FixtureAthlete = { key: string; maxHr: number; restHr: number; sex: "male" | "female" | null };
export const ATHLETES: FixtureAthlete[] = [
  { key: "male_190_50", maxHr: 190, restHr: 50, sex: "male" },
  { key: "female_182_58", maxHr: 182, restHr: 58, sex: "female" },
  { key: "unknown_195_45", maxHr: 195, restHr: 45, sex: null },
];

/** Small deterministic PRNG (LCG) so fixtures never change between runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * About 16 weeks of a typical 4-6 runs/week build: Tuesday intervals,
 * Thursday tempo, Sunday long run, easy days in between, one 10K race, one
 * parkrun, a treadmill run with no distance, and HR missing on some runs.
 */
export function buildRuns(): FixtureRun[] {
  const rnd = lcg(20261011);
  const runs: FixtureRun[] = [];
  const startMs = Date.UTC(2026, 5, 20);
  for (let day = 0; day < 112; day++) {
    const ms = startMs + day * 86_400_000;
    const date = ymd(ms);
    const dow = new Date(ms).getUTCDay(); // 0 Sun
    const week = Math.floor(day / 7);
    const build = 1 + week * 0.03;
    const hasHr = rnd() > 0.25;
    const hr = (base: number) => (hasHr ? Math.round(base + rnd() * 8) : null);
    const rpe = rnd() > 0.6 ? Math.max(1, Math.min(10, Math.round(3 + rnd() * 6))) : null;
    const push = (r: Omit<FixtureRun, "start_local" | "rpe"> & { hour?: number }) => {
      const hour = String(r.hour ?? 7).padStart(2, "0");
      const { hour: _h, ...rest } = r;
      void _h;
      runs.push({ ...rest, start_local: `${date}T${hour}:15:00`, rpe });
    };

    if (dow === 1) continue; // Monday rest
    if (dow === 0) {
      if (week === 8) {
        push({ name: "Ghent 10K", distance_m: 10000, moving_time_s: 2580, elevation_gain_m: 20, average_heartrate: hasHr ? 176 : null, workout_type: 1, avg_speed_mps: 10000 / 2580, average_cadence: 88 });
        continue;
      }
      const km = Math.min(28, 14 + week * 0.8);
      const pace = 330 - rnd() * 15;
      push({ name: week % 3 === 0 ? "Long run" : "Sunday Morning Run", distance_m: km * 1000, moving_time_s: Math.round(km * pace), elevation_gain_m: Math.round(40 + rnd() * 120), average_heartrate: hr(146), avg_speed_mps: 1000 / pace, average_cadence: 84 });
      continue;
    }
    if (dow === 2) {
      const km = 9 + rnd() * 3;
      const pace = 285 - rnd() * 10;
      push({ name: "Track intervals 6x1k", distance_m: km * 1000, moving_time_s: Math.round(km * pace), elevation_gain_m: 10, average_heartrate: hr(158), workout_type: 3, avg_speed_mps: 1000 / pace, average_cadence: 90, hour: 18 });
      continue;
    }
    if (dow === 4) {
      const km = 10 + rnd() * 4;
      const pace = (295 - rnd() * 10) / build ** 0.1;
      push({ name: rnd() > 0.5 ? "Tempo" : "Thursday Evening Run", distance_m: km * 1000, moving_time_s: Math.round(km * pace), elevation_gain_m: 30, average_heartrate: hr(162), avg_speed_mps: 1000 / pace, average_cadence: 88, hour: 18 });
      continue;
    }
    if (dow === 6 && week % 4 === 1) {
      push({ name: "parkrun", distance_m: 5000, moving_time_s: Math.round(1260 - week * 4), elevation_gain_m: 15, average_heartrate: hr(172), avg_speed_mps: 5000 / (1260 - week * 4), average_cadence: 90, hour: 9 });
      continue;
    }
    if (dow === 5 && week % 5 === 2) {
      // Treadmill: no distance recorded.
      push({ name: "Treadmill", distance_m: 0, moving_time_s: 2700, elevation_gain_m: 0, average_heartrate: null, avg_speed_mps: 0 });
      continue;
    }
    if (rnd() < 0.8) {
      const km = 6 + rnd() * 5;
      const pace = 345 + rnd() * 30;
      push({ name: rnd() > 0.5 ? "Easy run" : "Lunch Run", distance_m: km * 1000, moving_time_s: Math.round(km * pace), elevation_gain_m: Math.round(rnd() * 60), average_heartrate: hr(136), avg_speed_mps: 1000 / pace, average_cadence: 82, hour: 12 });
    }
  }
  return runs;
}
