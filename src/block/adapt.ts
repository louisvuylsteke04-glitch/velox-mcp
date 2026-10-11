/**
 * Adaptation on a plan block: the block as the guards see it (forward
 * sessions with numeric ids), the NET POSITION table, completed-week volume
 * for the missed-session policy, and applying an accepted edit.
 */
import { addDaysYMD, daysBetweenYMD } from "../engine/dates";
import { netPositionLines, type ForwardSnapshot } from "../engine/adapt/guards";
import type { PlanEdit } from "../engine/adapt/validate";
import type { WeekActual } from "../engine/adapt/missed-policy";
import { neutralTitle } from "../engine/plan/race-day";
import type { BlockSession, PlanBlock } from "./schema";
import { authoredOf } from "./schema";
import { sealBlock } from "./codec";

/** Forward = still planned and not in the past (the web app's adapt window). */
export function forwardSessions(block: PlanBlock, today: string): { snapshots: ForwardSnapshot[]; idOf: Map<number, string>; numOf: Map<string, number> } {
  const idOf = new Map<number, string>();
  const numOf = new Map<string, number>();
  const snapshots: ForwardSnapshot[] = [];
  block.sessions.forEach((s, i) => {
    if (s.status !== "planned" || s.date < today) return;
    const n = i + 1;
    idOf.set(n, s.id);
    numOf.set(s.id, n);
    const a = authoredOf(s);
    snapshots.push({
      id: n, scheduled_date: s.date, week_number: s.week, sport: "run", workout_type: s.type,
      target_distance_km: s.km, target_duration_min: s.min, target_pace_zone: s.zone,
      pinned_by: s.pinned ? "system" : null,
      authored_distance_km: a.km, authored_duration_min: a.min, authored_pace_zone: a.zone,
      adapt_edit_count: s.edits,
    });
  });
  snapshots.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return { snapshots, idOf, numOf };
}

/** The NET POSITION table with the block's own session ids. */
export function netPositionTable(block: PlanBlock, today: string): string[] {
  const { snapshots, idOf } = forwardSessions(block, today);
  return netPositionLines(snapshots).map((l) => l.replace(/^- id=(\d+) /, (_m, n: string) => `- id=${idOf.get(Number(n))} `));
}

export function weekTargets(block: PlanBlock): { week_number: number; target_weekly_km: number }[] {
  return block.plan.weeks.map((w) => ({ week_number: w.n, target_weekly_km: w.km }));
}

/**
 * Actual vs target km for the most recent (up to 6) fully completed plan weeks,
 * from the runs the athlete logged. Same arithmetic as the web app's
 * completedWeeksFor, which read every synced run.
 */
export function completedWeeks(block: PlanBlock, today: string): WeekActual[] {
  const planStart = block.plan.start;
  const out: WeekActual[] = [];
  const lastComplete = Math.floor(daysBetweenYMD(planStart, today) / 7);
  const firstWeek = Math.max(1, lastComplete - 5);
  if (lastComplete < 1) return out;
  const kmByWeek = new Map<number, number>();
  for (const e of block.log) {
    const w = Math.floor(daysBetweenYMD(planStart, e.date) / 7) + 1;
    if (w < firstWeek || w > lastComplete) continue;
    kmByWeek.set(w, (kmByWeek.get(w) ?? 0) + e.km);
  }
  for (let w = firstWeek; w <= lastComplete; w++) {
    const t = block.plan.weeks.find((x) => x.n === w);
    out.push({ weekStart: addDaysYMD(planStart, (w - 1) * 7), actualKm: kmByWeek.get(w) ?? 0, targetKm: t?.km ?? 0 });
  }
  return out;
}

/** A unique session id for a date. */
function freshId(date: string, taken: Set<string>): string {
  if (!taken.has(date)) return date;
  for (let n = 2; ; n++) if (!taken.has(`${date}.${n}`)) return `${date}.${n}`;
}

export type AppliedChange = { id: string; change: string };

/** Apply an accepted (validated and guarded) edit. Returns the new sealed block. */
export function applyEdit(
  block: PlanBlock,
  edit: PlanEdit,
  idOf: Map<number, string>,
  stamp: { today: string; trigger: string; rebuild?: boolean },
): { block: PlanBlock; changes: AppliedChange[] } {
  const sessions: BlockSession[] = block.sessions.map((s) => ({ ...s }));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const changes: AppliedChange[] = [];
  const weekOf = (d: string) => Math.floor(daysBetweenYMD(block.plan.start, d) / 7) + 1;

  for (const u of edit.updates) {
    const s = byId.get(idOf.get(u.id)!);
    if (!s) continue;
    if (!s.authored) s.authored = authoredOf(s);
    const f = u.fields;
    const parts: string[] = [];
    if (typeof f.workout_type === "string" && f.workout_type !== s.type) {
      parts.push(`${s.type} → ${f.workout_type}`);
      s.type = f.workout_type as BlockSession["type"];
      delete s.title; // titles follow the type
    }
    if ("target_distance_km" in f && f.target_distance_km !== s.km) {
      parts.push(`${s.km ?? 0} → ${f.target_distance_km ?? 0} km`);
      s.km = (f.target_distance_km as number | null) ?? null;
    }
    if ("target_duration_min" in f && f.target_duration_min !== s.min) {
      parts.push(`${s.min ?? 0} → ${f.target_duration_min} min`);
      s.min = f.target_duration_min as number;
    }
    if ("target_pace_zone" in f && f.target_pace_zone !== s.zone) {
      parts.push(`${s.zone ?? "none"} → ${f.target_pace_zone}`);
      s.zone = f.target_pace_zone as BlockSession["zone"];
    }
    delete s.seg; // a changed session's structure is rebuilt
    delete s.cue;
    s.edits += 1;
    changes.push({ id: s.id, change: parts.join(", ") || "updated" });
  }

  for (const m of edit.moves) {
    const s = byId.get(idOf.get(m.id)!);
    if (!s || s.date === m.toDate) continue;
    changes.push({ id: s.id, change: `moved ${s.date} → ${m.toDate}` });
    s.date = m.toDate;
    s.week = weekOf(m.toDate);
  }

  const deleted = new Set(edit.deletes.map((n) => idOf.get(n)));
  for (const id of deleted) if (id) changes.push({ id, change: "removed" });
  const next = sessions.filter((s) => !deleted.has(s.id));

  const taken = new Set(next.map((s) => s.id));
  for (const ins of edit.inserts) {
    const id = freshId(ins.date, taken);
    taken.add(id);
    const title = ins.title !== neutralTitle(ins.workout_type, "run") ? ins.title : undefined;
    next.push({
      id, date: ins.date, week: weekOf(ins.date), type: ins.workout_type as BlockSession["type"],
      km: ins.target_distance_km, min: ins.target_duration_min, zone: ins.target_pace_zone as BlockSession["zone"],
      status: "planned", edits: 0, ...(title ? { title } : {}),
    });
    changes.push({ id, change: `added ${ins.workout_type}${ins.target_distance_km ? ` ${ins.target_distance_km} km` : ""}` });
  }
  // Order is NOT re-sorted: a session's structure depends on its place among the
  // week's quality sessions, so untouched sessions must keep their order.

  const history = { ...block.history, last_adapt: stamp.today };
  if (stamp.trigger === "missed_session") history.last_missed_adapt = stamp.today;
  if (stamp.trigger === "restoration_review") history.last_restoration = stamp.today;
  if (stamp.rebuild) history.last_rebuild = stamp.today;

  const { check: _c, ...rest } = block;
  void _c;
  return { block: sealBlock({ ...rest, sessions: next, history }), changes };
}
