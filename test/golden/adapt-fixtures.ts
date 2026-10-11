/**
 * Adaptation scenarios shared by the golden generator (original web-app code)
 * and the parity tests (the port). Plan starts Monday 2026-10-12, today is
 * 2026-10-21 (week 2, Wednesday).
 */
export const A_TODAY = "2026-10-21";
export const A_PLAN_START = "2026-10-12";

export const GUARD_CONFIG = { floorPct: 70, recutMaxEdits: 2, recutBelowPct: 25, tolerance: 0.15, horizonDays: 21, ceilingPct: 115 };

type Snap = {
  id: number; scheduled_date: string; week_number: number; sport: string | null; workout_type: string;
  target_distance_km: number | null; target_duration_min: number | null; target_pace_zone: string | null;
  pinned_by: string | null; authored_distance_km?: number | null; authored_duration_min?: number | null;
  authored_pace_zone?: string | null; adapt_edit_count?: number | null;
};

const s = (id: number, date: string, week: number, type: string, km: number, extra: Partial<Snap> = {}): Snap => ({
  id, scheduled_date: date, week_number: week, sport: "run", workout_type: type,
  target_distance_km: km, target_duration_min: null, target_pace_zone: type === "easy" || type === "long_run" ? "zone2" : "zone4",
  pinned_by: null, ...extra,
});

/** Weeks 3-6 fully ahead; week 2 underway. */
export const FORWARD: Snap[] = [
  s(1, "2026-10-22", 2, "easy", 8), s(2, "2026-10-25", 2, "long_run", 18),
  s(3, "2026-10-27", 3, "easy", 8), s(4, "2026-10-28", 3, "tempo", 10), s(5, "2026-10-30", 3, "easy", 8), s(6, "2026-11-01", 3, "long_run", 20),
  s(7, "2026-11-03", 4, "easy", 7), s(8, "2026-11-04", 4, "interval", 9, { authored_distance_km: 12, adapt_edit_count: 1 }), s(9, "2026-11-08", 4, "long_run", 16),
  s(10, "2026-11-10", 5, "easy", 8, { adapt_edit_count: 2, authored_distance_km: 9 }), s(11, "2026-11-11", 5, "threshold", 11), s(12, "2026-11-15", 5, "long_run", 22),
  s(13, "2026-11-17", 6, "easy", 8), s(14, "2026-11-18", 6, "tempo", 10), s(15, "2026-11-22", 6, "race", 21.1, { pinned_by: "system", target_pace_zone: "race_pace" }),
];
export const WEEK_TARGETS = [
  { week_number: 2, target_weekly_km: 40 }, { week_number: 3, target_weekly_km: 46 }, { week_number: 4, target_weekly_km: 32 },
  { week_number: 5, target_weekly_km: 41 }, { week_number: 6, target_weekly_km: 39 },
];

const cite = (id: number, extra: Record<string, unknown> = {}) => {
  const f = FORWARD.find((x) => x.id === id)!;
  return {
    id, authored_km: f.authored_distance_km ?? f.target_distance_km, current_km: f.target_distance_km,
    authored_min: null, current_min: null, times_edited: f.adapt_edit_count ?? 0, verdict: "ok", new_signal: null, ...extra,
  };
};
const analysis = (entries: unknown[]) => ({ event: "e", net_position_reviewed: entries, decision: "d" });
const edit = (e: Partial<{ updates: unknown[]; moves: unknown[]; inserts: unknown[]; deletes: number[] }>) =>
  ({ updates: [], moves: [], inserts: [], deletes: [], ...e });

export const GUARD_CASES = [
  { key: "clean_trim", edit: edit({ updates: [{ id: 4, fields: { target_distance_km: 8 } }] }), analysis: analysis([cite(4)]), horizon: null },
  { key: "missing_citation", edit: edit({ updates: [{ id: 4, fields: { target_distance_km: 8 } }] }), analysis: analysis([]), horizon: null },
  { key: "wrong_citation", edit: edit({ updates: [{ id: 4, fields: { target_distance_km: 8 } }] }), analysis: analysis([cite(4, { current_km: 12 })]), horizon: null },
  { key: "recut_edited_twice", edit: edit({ updates: [{ id: 10, fields: { target_distance_km: 6 } }] }), analysis: analysis([cite(10)]), horizon: null },
  { key: "recut_below_authored", edit: edit({ updates: [{ id: 8, fields: { target_distance_km: 7 } }] }), analysis: analysis([cite(8)]), horizon: null },
  { key: "recut_with_signal", edit: edit({ updates: [{ id: 8, fields: { target_distance_km: 7 } }] }), analysis: analysis([cite(8, { new_signal: "injury" })]), horizon: null },
  { key: "floor_breach", edit: edit({ deletes: [4, 6] }), analysis: analysis([cite(4), cite(6)]), horizon: null },
  { key: "floor_with_illness", edit: edit({ deletes: [4, 6] }), analysis: analysis([cite(4, { new_signal: "illness" }), cite(6)]), horizon: null },
  { key: "ceiling_breach", edit: edit({ updates: [{ id: 6, fields: { target_distance_km: 30 } }] }), analysis: analysis([cite(6)]), horizon: null },
  { key: "move_into_week", edit: edit({ moves: [{ id: 7, toDate: "2026-10-31" }] }), analysis: analysis([cite(7)]), horizon: null },
  { key: "horizon_missed", edit: edit({ updates: [{ id: 4, fields: { target_distance_km: 9 } }, { id: 14, fields: { target_distance_km: 8 } }] }), analysis: analysis([cite(4), cite(14)]), horizon: "2026-11-11" },
  { key: "insert_counts", edit: edit({ inserts: [{ date: "2026-10-29", sport: "run", target_distance_km: 12 }] }), analysis: analysis([]), horizon: null },
];

const week = (weekStart: string, actualKm: number, targetKm: number) => ({ weekStart, actualKm, targetKm });
export const POLICY_CONFIG = { debounceDays: 3, structuralWeeks: 3, structuralBelowPct: 50, raceWindowDays: 14, pinnedWindowDays: 7, rebuildCooldownDays: 14 };
const base = {
  today: A_TODAY, lastMissedAdaptAt: null as string | null, lastRebuildAt: null as string | null, lastRunLoggedAt: "2026-10-20" as string | null,
  completedWeeks: [week("2026-10-12", 38, 40)], newHealthConcernSince: false, raceOrPinnedNear: false, config: POLICY_CONFIG,
};
export const POLICY_CASES = [
  { key: "first_miss", input: base },
  { key: "debounced", input: { ...base, lastMissedAdaptAt: "2026-10-19T20:00:00Z" } },
  { key: "debounced_but_concern", input: { ...base, lastMissedAdaptAt: "2026-10-19T20:00:00Z", newHealthConcernSince: true } },
  { key: "debounced_but_race_near", input: { ...base, lastMissedAdaptAt: "2026-10-20T20:00:00Z", raceOrPinnedNear: true } },
  { key: "structural", input: { ...base, completedWeeks: [week("2026-09-21", 10, 40), week("2026-09-28", 5, 42), week("2026-10-05", 0, 44)] } },
  { key: "structural_cooldown", input: { ...base, lastRebuildAt: "2026-10-12T00:00:00Z", lastRunLoggedAt: "2026-10-15", completedWeeks: [week("2026-09-21", 10, 40), week("2026-09-28", 5, 42), week("2026-10-05", 0, 44)] } },
  { key: "suppressed_after_rebuild", input: { ...base, lastRebuildAt: "2026-10-18T00:00:00Z", lastRunLoggedAt: "2026-10-10" } },
];

export const RESTORATION_CONFIG = { meetWeeks: 2, meetPct: 90, intervalDays: 7, driftPct: 5 };
export const RESTORATION_CASES = [
  { key: "earned", weeks: [week("2026-09-28", 40, 42), week("2026-10-05", 43, 44)], concern: false },
  { key: "one_short", weeks: [week("2026-09-28", 30, 42), week("2026-10-05", 43, 44)], concern: false },
  { key: "concern_holds", weeks: [week("2026-09-28", 40, 42), week("2026-10-05", 43, 44)], concern: true },
  { key: "too_few_weeks", weeks: [week("2026-10-05", 43, 44)], concern: false },
];
