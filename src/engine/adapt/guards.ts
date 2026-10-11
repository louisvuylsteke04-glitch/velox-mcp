/**
 * Adaptation edit guards (#86 E1 + E2): the code layer that makes the downward
 * ratchet structurally impossible instead of merely discouraged.
 *
 * Ported from the Vēlox web app's lib/adapt-guards.ts. The env-var config and
 * pilot-flag helpers are replaced by DEFAULT_GUARD_CONFIG; the guards themselves
 * are unchanged. In the web app they ran behind two flags:
 *
 *   ADAPT_NET_POSITION  — the NET POSITION table goes into the prompt and the
 *                         model's private analysis becomes typed (its edits must
 *                         cite the table). Prompt-side half of the loop.
 *   ADAPT_EDIT_GUARDS   — the rejections below actually run. Code-side half.
 *
 * The citation and re-cut guards need the typed analysis, so they only run when
 * BOTH flags are on. The weekly floor guard runs whenever ADAPT_EDIT_GUARDS is on.
 */

import { addDaysYMD, daysBetweenYMD } from "../dates";

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A forward planned session as the guards (and the NET POSITION table) see it.
 *  Numeric columns may arrive from PostgREST as strings; always read via num(). */
export type ForwardSnapshot = {
  id: number;
  scheduled_date: string;
  week_number: number;
  sport: string | null;
  workout_type: string;
  target_distance_km: number | string | null;
  target_duration_min: number | string | null;
  target_pace_zone: string | null;
  pinned_by: string | null;
  authored_distance_km?: number | string | null;
  authored_duration_min?: number | string | null;
  authored_pace_zone?: string | null;
  adapt_edit_count?: number | string | null;
  last_adapted_at?: string | null;
};

export type AdaptSignal = "injury" | "illness" | "structural_absence";
const SIGNALS = new Set<string>(["injury", "illness", "structural_absence"]);

/** One row of the model's typed deliberation: its own record of a session's net
 *  position, quoted back from the table the prompt supplied. */
export type ReviewedEntry = {
  id: number;
  authored_km: number | null;
  current_km: number | null;
  authored_min: number | null;
  current_min: number | null;
  times_edited: number | null;
  verdict: string | null;
  new_signal: AdaptSignal | null;
};

export type AdaptAnalysis = {
  event: string | null;
  net_position_reviewed: ReviewedEntry[];
  decision: string | null;
};

/** The subset of PlanEdit the guards operate on (structural, to avoid importing
 *  from coach-llm and creating a cycle). */
export type GuardablePlanEdit = {
  updates: { id: number; fields: Record<string, unknown> }[];
  moves: { id: number; toDate: string }[];
  inserts: { date: string; sport: string; target_distance_km: number | null }[];
  deletes: number[];
};

export type GuardRejection = {
  guard: "citation" | "recut" | "floor" | "ceiling" | "horizon";
  sessionId?: number;
  week?: number;
  reason: string;
};

export type GuardConfig = {
  /** A week may not be edited below this % of its target_weekly_km. */
  floorPct: number;
  /** A session already edited this many times is not cut again without a new signal. */
  recutMaxEdits: number;
  /** A session already this % below authored is not cut again without a new signal. */
  recutBelowPct: number;
  /** Numeric slack when comparing the model's citations to the prompt's table. */
  tolerance: number;
  /** missed_session edits reach at most this many days ahead (E3). */
  horizonDays: number;
  /** A week may not be edited above this % of its target_weekly_km (E5's
   *  overshoot guard; completes the two-sided envelope). */
  ceilingPct: number;
};

/** The web app's defaults (its env vars unset). */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  floorPct: 70,
  recutMaxEdits: 2,
  recutBelowPct: 25,
  tolerance: 0.15,
  horizonDays: 21,
  ceilingPct: 115,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Authored values with the NULL-means-current read rule (rows inserted between
 *  the migration and a snapshot write have no authored value: they ARE their
 *  own authored value). */
export function authoredOf(s: ForwardSnapshot): { dist: number | null; dur: number | null; zone: string | null } {
  return {
    dist: num(s.authored_distance_km) ?? num(s.target_distance_km),
    dur: num(s.authored_duration_min) ?? num(s.target_duration_min),
    zone: s.authored_pace_zone ?? s.target_pace_zone,
  };
}

function editCount(s: ForwardSnapshot): number {
  return num(s.adapt_edit_count) ?? 0;
}

function withinTol(cited: number | null | undefined, actual: number | null, tol: number): boolean {
  if (cited == null && actual == null) return true;
  if (cited == null || actual == null) return false;
  return Math.abs(cited - actual) <= tol;
}

// ── NET POSITION table (E2a) ────────────────────────────────────────────────

/** The compact per-session state table the prompt supplies. Only sessions with
 *  history or drift get their own line; the untouched majority is one summary
 *  line, so the table costs less than the prose it replaces. */
export function netPositionLines(forward: ForwardSnapshot[]): string[] {
  const lines: string[] = [];
  let untouched = 0;
  for (const s of forward) {
    const a = authoredOf(s);
    const curD = num(s.target_distance_km);
    const curM = num(s.target_duration_min);
    const edits = editCount(s);
    const distDrift = a.dist != null && curD != null && Math.abs(a.dist - curD) > 0.05;
    const durDrift = a.dur != null && curM != null && Math.abs(a.dur - curM) > 0.5;
    if (edits === 0 && !distDrift && !durDrift) { untouched++; continue; }

    const measure = (dist: number | null, dur: number | null): string => {
      const parts: string[] = [];
      if (dist != null) parts.push(`${Math.round(dist * 10) / 10}km`);
      if (dur != null) parts.push(`${Math.round(dur)}min`);
      return parts.join(" / ") || "no measure";
    };
    let drift = "at authored";
    if (a.dist != null && curD != null && a.dist > 0 && distDrift) {
      const pct = Math.round(Math.abs(a.dist - curD) / a.dist * 100);
      drift = curD < a.dist ? `${pct}% below authored` : `${pct}% above authored`;
    } else if (a.dur != null && curM != null && a.dur > 0 && durDrift) {
      const pct = Math.round(Math.abs(a.dur - curM) / a.dur * 100);
      drift = curM < a.dur ? `${pct}% below authored` : `${pct}% above authored`;
    }
    const editBit = edits > 0
      ? `edited ${edits}x${s.last_adapted_at ? ` (last ${s.last_adapted_at.slice(0, 10)})` : ""}`
      : "not edited by you";
    lines.push(`- id=${s.id} ${s.scheduled_date} [${s.sport && s.sport !== "run" ? `${s.sport} ` : ""}${s.workout_type}]: authored ${measure(a.dist, a.dur)}, current ${measure(curD, curM)}, ${editBit}, ${drift}`);
  }
  if (untouched > 0) lines.push(`- the other ${untouched} forward session${untouched === 1 ? "" : "s"} are untouched (current = authored)`);
  return lines;
}

// ── Typed analysis parsing (E2b) ────────────────────────────────────────────

export function parseAdaptAnalysis(raw: unknown): AdaptAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entries: ReviewedEntry[] = [];
  for (const e of Array.isArray(r.net_position_reviewed) ? r.net_position_reviewed : []) {
    if (!e || typeof e !== "object") continue;
    const ee = e as Record<string, unknown>;
    if (typeof ee.id !== "number") continue;
    const signal = typeof ee.new_signal === "string" && SIGNALS.has(ee.new_signal) ? ee.new_signal as AdaptSignal : null;
    entries.push({
      id: ee.id,
      authored_km: num(ee.authored_km as number | string | null),
      current_km: num(ee.current_km as number | string | null),
      authored_min: num(ee.authored_min as number | string | null),
      current_min: num(ee.current_min as number | string | null),
      times_edited: num(ee.times_edited as number | string | null),
      verdict: typeof ee.verdict === "string" ? ee.verdict : null,
      new_signal: signal,
    });
  }
  return {
    event: typeof r.event === "string" ? r.event : null,
    net_position_reviewed: entries,
    decision: typeof r.decision === "string" ? r.decision : null,
  };
}

// ── The guards (E1 + E2c) ───────────────────────────────────────────────────

export type GuardInput<T extends GuardablePlanEdit> = {
  edit: T;
  analysis: AdaptAnalysis | null;
  forward: ForwardSnapshot[];
  weekTargets: { week_number: number; target_weekly_km: number }[];
  /** plan_start_date; week N starts at planStart + (N-1)*7 days. NULL disables the floor guard. */
  planStart: string | null;
  today: string;
  config: GuardConfig;
  /** True when ADAPT_NET_POSITION is on: the typed analysis was requested, so
   *  the citation and re-cut guards are enforceable. */
  enforceCitation: boolean;
  /** True when ADAPT_EDIT_GUARDS is on. False leaves the floor idle so the
   *  horizon guard can run alone under its own flag (E3 without E1). */
  enforceFloor: boolean;
  /** E3: when set, edits touching sessions or dates after this YMD are dropped
   *  (missed_session only; a structural rebuild passes null to lift it). */
  horizonMaxDate?: string | null;
};

export function applyEditGuards<T extends GuardablePlanEdit>(input: GuardInput<T>): { edit: T; rejections: GuardRejection[] } {
  const { edit: rawEdit, analysis, forward, config, enforceCitation, horizonMaxDate } = input;
  const rejections: GuardRejection[] = [];
  const byId = new Map(forward.map(s => [s.id, s]));

  // ── Horizon (E3) ──────────────────────────────────────────────────────────
  // Runs first and independently of the typed analysis: a missed session today
  // is not a reason to edit October. Sessions beyond the horizon stay as
  // authored. Moves are checked on both ends.
  let edit: T = rawEdit;
  if (horizonMaxDate) {
    const beyond = (d: string | undefined): boolean => d != null && d > horizonMaxDate;
    const dateOf = (id: number) => byId.get(id)?.scheduled_date;
    const rejectHorizon = (id: number | undefined, what: string, date: string | undefined) =>
      rejections.push({ guard: "horizon", sessionId: id, reason: `${what} rejected: ${date} is beyond the ${horizonMaxDate} horizon for missed-session edits` });
    edit = {
      ...rawEdit,
      updates: rawEdit.updates.filter(u => beyond(dateOf(u.id)) ? (rejectHorizon(u.id, `update of id=${u.id}`, dateOf(u.id)), false) : true),
      moves: rawEdit.moves.filter(m => (beyond(dateOf(m.id)) || beyond(m.toDate)) ? (rejectHorizon(m.id, `move of id=${m.id}`, beyond(m.toDate) ? m.toDate : dateOf(m.id)), false) : true),
      deletes: rawEdit.deletes.filter(d => beyond(dateOf(d)) ? (rejectHorizon(d, `delete of id=${d}`, dateOf(d)), false) : true),
      inserts: rawEdit.inserts.filter(i => beyond(i.date) ? (rejectHorizon(undefined, "insert", i.date), false) : true),
    };
  }
  const reviewed = new Map((analysis?.net_position_reviewed ?? []).map(e => [e.id, e]));

  // A named injury/illness anywhere in the analysis exempts the floor guard;
  // per-session signals exempt that session's re-cut guard.
  const hasHealthSignal = (analysis?.net_position_reviewed ?? [])
    .some(e => e.new_signal === "injury" || e.new_signal === "illness");

  const citationOk = (id: number): boolean => {
    const s = byId.get(id);
    if (!s) return true; // unknown ids were already dropped by the id validator
    const entry = reviewed.get(id);
    if (!entry) return false;
    const a = authoredOf(s);
    const curD = num(s.target_distance_km);
    const curM = num(s.target_duration_min);
    if (a.dist != null || curD != null) {
      return withinTol(entry.authored_km, a.dist, config.tolerance) && withinTol(entry.current_km, curD, config.tolerance);
    }
    if (a.dur != null || curM != null) {
      return withinTol(entry.authored_min, a.dur, config.tolerance) && withinTol(entry.current_min, curM, config.tolerance);
    }
    return true; // rest-like session: the id citation alone is enough
  };

  /** Does this update/delete reduce the session's prescribed load? */
  const isReduction = (s: ForwardSnapshot, fields: Record<string, unknown> | null): boolean => {
    const curD = num(s.target_distance_km);
    const curM = num(s.target_duration_min);
    if (fields === null) return (curD ?? 0) > 0 || (curM ?? 0) > 0; // delete
    if (curD != null && "target_distance_km" in fields) {
      const next = num(fields.target_distance_km as number | string | null) ?? 0; // null = became rest/cross
      if (next < curD - 1e-6) return true;
    }
    if (curM != null && "target_duration_min" in fields) {
      const next = num(fields.target_duration_min as number | string | null) ?? 0;
      if (next < curM - 1e-6) return true;
    }
    return false;
  };

  /** Is this session already at the point where another cut needs a new signal? */
  const cutProtected = (s: ForwardSnapshot): string | null => {
    if (editCount(s) >= config.recutMaxEdits) return `already edited ${editCount(s)}x (max ${config.recutMaxEdits} without a new signal)`;
    const a = authoredOf(s);
    const curD = num(s.target_distance_km);
    if (a.dist != null && curD != null && a.dist > 0 && curD < a.dist * (1 - config.recutBelowPct / 100) - 1e-6) {
      return `already ${Math.round((a.dist - curD) / a.dist * 100)}% below authored ${a.dist}km (max ${config.recutBelowPct}% without a new signal)`;
    }
    const curM = num(s.target_duration_min);
    if (a.dur != null && curM != null && a.dur > 0 && curM < a.dur * (1 - config.recutBelowPct / 100) - 1e-6) {
      return `already ${Math.round((a.dur - curM) / a.dur * 100)}% below authored ${a.dur}min (max ${config.recutBelowPct}% without a new signal)`;
    }
    return null;
  };

  const allowItem = (id: number, fields: Record<string, unknown> | null, kind: "update" | "move" | "delete"): boolean => {
    if (!enforceCitation) return true;
    if (!citationOk(id)) {
      rejections.push({ guard: "citation", sessionId: id, reason: `${kind} of id=${id} rejected: session missing from net_position_reviewed or its cited values do not match the prompt's table` });
      return false;
    }
    if (kind === "move") return true; // moves are direction-neutral
    const s = byId.get(id);
    if (s && isReduction(s, fields)) {
      const why = cutProtected(s);
      if (why && reviewed.get(id)?.new_signal == null) {
        rejections.push({ guard: "recut", sessionId: id, reason: `cut of id=${id} rejected: ${why}` });
        return false;
      }
    }
    return true;
  };

  const updates = edit.updates.filter(u => allowItem(u.id, u.fields, "update"));
  const moves = edit.moves.filter(m => allowItem(m.id, null, "move"));
  const deletes = edit.deletes.filter(d => allowItem(d, null, "delete"));
  const guarded: T = { ...edit, updates, moves, deletes };

  // ── Weekly floor and ceiling (E1 + E5) ────────────────────────────────────
  // Projected run km per week after the surviving edits, compared to the
  // plan's own weekly targets. Only weeks that have not started yet are
  // enforced (a partially elapsed week's forward sessions are not its whole
  // volume). A violation rejects the entire edit set: the model's reshape is
  // off-envelope as a whole, and applying half of it would be incoherent.
  // A named injury/illness signal exempts the FLOOR (cutting deep is sometimes
  // right); nothing exempts the CEILING (no signal ever justifies overshoot).
  if (input.enforceFloor && input.planStart) {
    // Same week arithmetic as applyPlanEdit's weekFor, so a moved session lands
    // in the same week here as it will in the database.
    const planStart = input.planStart;
    const weekOfDate = (d: string): number => Math.floor(daysBetweenYMD(planStart, d) / 7) + 1;
    // Per-session projected (week, km) for run sessions.
    const deleted = new Set(deletes);
    const updById = new Map(updates.map(u => [u.id, u.fields]));
    const moveById = new Map(moves.map(m => [m.id, m.toDate]));
    const base = new Map<number, number>();
    const projected = new Map<number, number>();
    for (const s of forward) {
      if ((s.sport ?? "run") !== "run") continue;
      const curD = num(s.target_distance_km) ?? 0;
      base.set(s.week_number, (base.get(s.week_number) ?? 0) + curD);
      if (deleted.has(s.id)) continue;
      const f = updById.get(s.id);
      const nextD = f && "target_distance_km" in f ? (num(f.target_distance_km as number | string | null) ?? 0) : curD;
      const toDate = moveById.get(s.id);
      const wk = toDate ? weekOfDate(toDate) : s.week_number;
      projected.set(wk, (projected.get(wk) ?? 0) + nextD);
    }
    for (const ins of edit.inserts) {
      if (ins.sport !== "run" || ins.target_distance_km == null) continue;
      const wk = weekOfDate(ins.date);
      projected.set(wk, (projected.get(wk) ?? 0) + ins.target_distance_km);
    }
    const envelopeViolations: GuardRejection[] = [];
    for (const t of input.weekTargets) {
      const target = num(t.target_weekly_km) ?? 0;
      if (target <= 0) continue;
      const weekStart = addDaysYMD(input.planStart, (t.week_number - 1) * 7);
      if (weekStart <= input.today) continue; // week already underway
      const before = base.get(t.week_number) ?? 0;
      if (before <= 0) continue; // week not represented in the forward window
      const after = projected.get(t.week_number) ?? 0;
      const floorKm = target * config.floorPct / 100;
      const ceilingKm = target * config.ceilingPct / 100;
      if (!hasHealthSignal && after < floorKm - 1e-6 && after < before - 1e-6) {
        envelopeViolations.push({
          guard: "floor", week: t.week_number,
          reason: `edit set rejected: it takes week ${t.week_number} to ${Math.round(after * 10) / 10}km, below ${config.floorPct}% of its ${target}km target (floor ${Math.round(floorKm * 10) / 10}km), with no injury or illness signal named`,
        });
      }
      if (after > ceilingKm + 1e-6 && after > before + 1e-6) {
        envelopeViolations.push({
          guard: "ceiling", week: t.week_number,
          reason: `edit set rejected: it takes week ${t.week_number} to ${Math.round(after * 10) / 10}km, above ${config.ceilingPct}% of its ${target}km target (ceiling ${Math.round(ceilingKm * 10) / 10}km)`,
        });
      }
    }
    if (envelopeViolations.length) {
      rejections.push(...envelopeViolations);
      return { edit: { ...guarded, updates: [], moves: [], deletes: [], inserts: [] }, rejections };
    }
  }

  return { edit: guarded, rejections };
}
