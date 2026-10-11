/**
 * Coach edit validation. Ported from the validation block of adaptPlan in the
 * Vēlox web app's lib/coach-llm.ts, where it checked the LLM's proposed edits
 * before the guards ran. In velox-mcp the edits come from Claude; the rules
 * are the same:
 *
 *  - only forward sessions can be touched, never a pinned session or the race
 *  - updates may only change type, distance (0-100 km), duration (10-480 min)
 *    and zone; titles follow the type
 *  - moves and inserts stay inside the forward window, at most one session of
 *    a sport per day (two per day only across sports), never a race insert
 *  - running only: nothing may become another sport
 *
 * Every item that is dropped is reported, so the coach can see why.
 */
import { neutralTitle } from "../plan/race-day";
import { allowedInRunOnly } from "../plan/run-only";
import type { ForwardSnapshot } from "./guards";

export type PlanEdit = {
  updates: { id: number; fields: Record<string, unknown> }[];
  moves: { id: number; toDate: string }[];
  inserts: { date: string; week_number: number; title: string; workout_type: string; sport: string; target_distance_km: number | null; target_duration_min: number | null; target_pace_zone: string | null }[];
  deletes: number[];
};

export type RawEdit = {
  updates?: unknown;
  moves?: unknown;
  inserts?: unknown;
  deletes?: unknown;
};

export type DroppedItem = { kind: "update" | "move" | "insert" | "delete"; ref: string; reason: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES = new Set(["easy", "long_run", "tempo", "interval", "threshold", "recovery", "cross_train", "rest"]);
const VALID_SPORTS = new Set(["run", "bike", "swim", "strength"]);
const VALID_ZONES = new Set(["zone1", "zone2", "zone3", "zone4", "zone5", "race_pace"]);
const validDist = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;
const validDur = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 10 && v <= 480;

function forwardWeekFor(forward: { scheduled_date: string; week_number: number }[], date: string): number {
  if (!forward.length) return 1;
  let best = forward[0], bd = Infinity;
  for (const r of forward) { const d = Math.abs(Date.parse(r.scheduled_date) - Date.parse(date)); if (d < bd) { bd = d; best = r; } }
  return best.week_number;
}

export function validateEdit(raw: RawEdit, forward: ForwardSnapshot[], runOnly = true): { edit: PlanEdit; dropped: DroppedItem[] } {
  const dropped: DroppedItem[] = [];
  const ids = new Set(forward.map(s => s.id));
  const protectedIds = new Set(forward.filter(s => s.pinned_by || s.workout_type === "race").map(s => s.id));
  const dates = forward.map(s => s.scheduled_date).sort();
  const inWindow = (d: string) => dates.length > 0 && d >= dates[0] && d <= dates[dates.length - 1];
  const why = (id: unknown) => typeof id !== "number" || !ids.has(id) ? "not a forward session" : "pinned or race session";

  const edit: PlanEdit = { updates: [], moves: [], inserts: [], deletes: [] };

  for (const d of Array.isArray(raw.deletes) ? raw.deletes : []) {
    if (typeof d === "number" && ids.has(d) && !protectedIds.has(d) && !edit.deletes.includes(d)) edit.deletes.push(d);
    else dropped.push({ kind: "delete", ref: String(d), reason: why(d) });
  }

  for (const u of Array.isArray(raw.updates) ? raw.updates : []) {
    const uu = u as { id?: unknown; fields?: unknown };
    if (typeof uu.id !== "number" || !ids.has(uu.id) || protectedIds.has(uu.id) || !uu.fields || typeof uu.fields !== "object") {
      dropped.push({ kind: "update", ref: String(uu.id), reason: !uu.fields ? "no fields" : why(uu.id) });
      continue;
    }
    const raw_f = uu.fields as Record<string, unknown>;
    const f: Record<string, unknown> = {};
    if (typeof raw_f.sport === "string" && VALID_SPORTS.has(raw_f.sport)) f.sport = raw_f.sport;
    if (typeof raw_f.workout_type === "string" && VALID_TYPES.has(raw_f.workout_type)) {
      f.workout_type = raw_f.workout_type;
      f.title = neutralTitle(raw_f.workout_type, (f.sport as string | undefined) ?? null);
      if (raw_f.workout_type === "rest" || raw_f.workout_type === "cross_train") f.target_distance_km = null;
    }
    if (validDist(raw_f.target_distance_km)) f.target_distance_km = Math.round((raw_f.target_distance_km as number) * 10) / 10;
    if (validDur(raw_f.target_duration_min)) f.target_duration_min = Math.round(raw_f.target_duration_min as number);
    if (typeof raw_f.target_pace_zone === "string" && VALID_ZONES.has(raw_f.target_pace_zone)) f.target_pace_zone = raw_f.target_pace_zone;
    if (Object.keys(f).length === 0) { dropped.push({ kind: "update", ref: String(uu.id), reason: "no valid field (type, km 0-100, minutes 10-480, zone)" }); continue; }
    if (runOnly) {
      const cur = forward.find(s => s.id === uu.id);
      const after = { sport: (f.sport as string | undefined) ?? cur?.sport ?? "run", workout_type: (f.workout_type as string | undefined) ?? cur?.workout_type ?? null };
      if (!allowedInRunOnly(after)) { dropped.push({ kind: "update", ref: String(uu.id), reason: "would turn a run into another sport" }); continue; }
    }
    edit.updates.push({ id: uu.id, fields: f });
  }

  // Day occupancy: at most two sessions per day, and never two of the same sport.
  const daySports = new Map<string, string[]>();
  for (const s of forward) {
    if (edit.deletes.includes(s.id)) continue;
    const list = daySports.get(s.scheduled_date) ?? [];
    list.push(s.sport ?? "run");
    daySports.set(s.scheduled_date, list);
  }
  const dayBlocks = (date: string, sport: string) => {
    const list = daySports.get(date) ?? [];
    return list.includes(sport) || list.length >= 2;
  };
  const dayAdd = (date: string, sport: string) => {
    const list = daySports.get(date) ?? [];
    list.push(sport);
    daySports.set(date, list);
  };
  const dayRemove = (date: string, sport: string) => {
    const list = daySports.get(date) ?? [];
    const idx = list.indexOf(sport);
    if (idx >= 0) list.splice(idx, 1);
    daySports.set(date, list);
  };
  const movedIds = new Set<number>();
  for (const m of Array.isArray(raw.moves) ? raw.moves : []) {
    const mm = m as { id?: unknown; toDate?: unknown };
    if (typeof mm.id !== "number" || !ids.has(mm.id) || protectedIds.has(mm.id) || movedIds.has(mm.id) || edit.deletes.includes(mm.id)) {
      dropped.push({ kind: "move", ref: String(mm.id), reason: typeof mm.id === "number" && (movedIds.has(mm.id) || edit.deletes.includes(mm.id)) ? "already moved or deleted in this edit" : why(mm.id) });
      continue;
    }
    if (typeof mm.toDate !== "string" || !YMD.test(mm.toDate) || !inWindow(mm.toDate)) {
      dropped.push({ kind: "move", ref: String(mm.id), reason: `target date ${String(mm.toDate)} is outside the forward plan` });
      continue;
    }
    const srcSession = forward.find(s => s.id === mm.id)!;
    const from = srcSession.scheduled_date;
    const sSport = srcSession.sport ?? "run";
    if (mm.toDate !== from) {
      dayRemove(from, sSport);
      if (dayBlocks(mm.toDate, sSport)) {
        dayAdd(from, sSport);
        dropped.push({ kind: "move", ref: String(mm.id), reason: `${mm.toDate} already has a run` });
        continue;
      }
      dayAdd(mm.toDate, sSport);
    }
    movedIds.add(mm.id);
    edit.moves.push({ id: mm.id, toDate: mm.toDate });
  }
  for (const i of Array.isArray(raw.inserts) ? raw.inserts : []) {
    const ii = i as { date?: unknown; workout_type?: unknown; sport?: unknown; target_distance_km?: unknown; target_duration_min?: unknown; target_pace_zone?: unknown };
    if (typeof ii.date !== "string" || !YMD.test(ii.date) || !inWindow(ii.date)) {
      dropped.push({ kind: "insert", ref: String(ii.date), reason: "date outside the forward plan" });
      continue;
    }
    // "race" is deliberately absent from VALID_TYPES: the coach can never insert a race.
    const insType = typeof ii.workout_type === "string" && VALID_TYPES.has(ii.workout_type) ? ii.workout_type : "easy";
    const insSport = typeof ii.sport === "string" && VALID_SPORTS.has(ii.sport) ? ii.sport : "run";
    if (runOnly && !allowedInRunOnly({ sport: insSport, workout_type: insType })) { dropped.push({ kind: "insert", ref: ii.date, reason: "running only" }); continue; }
    if (dayBlocks(ii.date, insSport)) { dropped.push({ kind: "insert", ref: ii.date, reason: `${ii.date} already has a run` }); continue; }
    dayAdd(ii.date, insSport);
    edit.inserts.push({
      date: ii.date, week_number: forwardWeekFor(forward, ii.date),
      title: neutralTitle(insType, insSport),
      workout_type: insType,
      sport: insSport,
      target_distance_km: insSport === "run" && validDist(ii.target_distance_km) ? Math.round((ii.target_distance_km as number) * 10) / 10 : null,
      target_duration_min: validDur(ii.target_duration_min) ? Math.round(ii.target_duration_min as number) : null,
      target_pace_zone: typeof ii.target_pace_zone === "string" && VALID_ZONES.has(ii.target_pace_zone) ? ii.target_pace_zone : null,
    });
  }
  return { edit, dropped };
}
