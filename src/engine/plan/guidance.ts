/**
 * The coach's guidance, carried onto every session (#121, COACH_GUIDANCE).
 *
 * generateBlueprint asks the coach what the hard work is in each phase, how the
 * long session should feel, and where a week needs something different. Until
 * now only the weekly template and plan_notes survived expansion, so a session
 * beyond the describe pass's 14-day window read as nothing more than
 * "Threshold, 9 km, zone4".
 *
 * Now the blueprint is stored on the plan row (training_plans.blueprint) and
 * each quality or long session gets that phase's guidance in
 * planned_workouts.mental_cue, which the session modal already shows when no
 * personal note exists yet. The guidance is derived, never authored per
 * session, so it can be recomputed whenever a session's type changes.
 *
 * Text only: the engine still owns every number. The coach's words are shown as
 * written, cleaned of em-dashes and exclamation marks to match the house style.
 */

import type { Blueprint, PhasePlan, WeekOverride } from "./blueprint";
import { phaseForWeek } from "./blueprint";
import type { SportKey } from "./types";

/** What lands in training_plans.blueprint. */
export type StoredBlueprint = {
  source: Blueprint["source"];
  coach_analysis: string;
  phases: PhasePlan[];
  week_overrides: WeekOverride[];
  /** Stored week_number = blueprint week + week_offset. An in-place
   *  regeneration keeps the plan's original week numbering (plan/anchor.ts). */
  week_offset: number;
};

export function toStoredBlueprint(bp: Blueprint, weekOffset: number): StoredBlueprint {
  return {
    source: bp.source,
    coach_analysis: bp.coach_analysis,
    phases: bp.phases,
    week_overrides: bp.week_overrides,
    week_offset: weekOffset,
  };
}

/** Read a stored blueprint back, or null when the column is empty or malformed. */
export function readStoredBlueprint(raw: unknown): StoredBlueprint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<StoredBlueprint>;
  if (!Array.isArray(r.phases) || !r.phases.length) return null;
  return {
    source: r.source === "fallback" ? "fallback" : "coach",
    coach_analysis: typeof r.coach_analysis === "string" ? r.coach_analysis : "",
    phases: r.phases,
    week_overrides: Array.isArray(r.week_overrides) ? r.week_overrides : [],
    week_offset: Number.isInteger(r.week_offset) ? (r.week_offset as number) : 0,
  };
}

/** House style for coach-written text: no em or en dashes, no exclamation
 *  marks, one sentence-ending period. */
export function cleanCopy(s: string): string {
  let out = s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/!+/g, ".")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\.{2,}/g, ".")
    .trim();
  if (!out) return "";
  out = out[0].toUpperCase() + out.slice(1);
  if (!/[.?]$/.test(out)) out += ".";
  return out;
}

const QUALITY_TYPES = new Set(["tempo", "threshold", "interval"]);
const LONG_NOUN: Record<SportKey, string> = { run: "long run", bike: "long ride", swim: "long swim" };

type SessionShape = { week_number: number; sport?: string | null; workout_type: string; title?: string | null };

function sessionKind(s: SessionShape): "quality" | "long" | null {
  const sport = (s.sport ?? "run") as string;
  if (s.workout_type === "long_run") return "long";
  // Long rides and swims have no workout_type of their own; expansion names them.
  if (sport !== "run" && /^long (ride|swim)$/i.test(s.title?.trim() ?? "")) return "long";
  if (QUALITY_TYPES.has(s.workout_type)) return "quality";
  return null;
}

/** The overrides the coach set for this STORED week number. */
export function overridesForWeek(bp: StoredBlueprint, weekNumber: number): WeekOverride[] {
  const w = weekNumber - bp.week_offset;
  return bp.week_overrides.filter((o) => o.week === w);
}

/** The phase guidance for this STORED week number, or null outside the plan. */
export function phaseForStoredWeek(bp: StoredBlueprint, weekNumber: number): PhasePlan | null {
  const w = weekNumber - bp.week_offset;
  if (w < 1) return null;
  return phaseForWeek(bp, w);
}

/**
 * The coach's guidance for one session, or null when there is nothing specific
 * to say (easy, recovery, rest and race days, or a phase with no guidance for
 * this sport). Week overrides are attached to the sessions they are about:
 * quality and long sessions.
 */
export function sessionGuidance(bp: StoredBlueprint, s: SessionShape): string | null {
  const kind = sessionKind(s);
  if (!kind) return null;
  const sport = ((s.sport ?? "run") as SportKey);
  const phase = phaseForStoredWeek(bp, s.week_number);
  const lines: string[] = [];

  const text = kind === "quality" ? phase?.quality?.[sport] : phase?.long_texture?.[sport];
  if (text?.trim()) {
    lines.push(kind === "quality"
      ? cleanCopy(`This phase: ${text.trim()}`)
      : cleanCopy(`This phase, the ${LONG_NOUN[sport] ?? "long session"}: ${text.trim()}`));
  }
  for (const o of overridesForWeek(bp, s.week_number)) {
    if (o.reason?.trim()) lines.push(cleanCopy(`This week: ${o.reason.trim()}`));
  }
  return lines.length ? lines.join("\n") : null;
}

/** Phase intent and week overrides for the describe pass, one line per session. */
export function describeContextLine(bp: StoredBlueprint, s: SessionShape): string | null {
  const phase = phaseForStoredWeek(bp, s.week_number);
  const sport = ((s.sport ?? "run") as SportKey);
  const bits: string[] = [];
  const q = phase?.quality?.[sport];
  const l = phase?.long_texture?.[sport];
  if (q) bits.push(`phase quality: ${q}`);
  if (l) bits.push(`phase long-session texture: ${l}`);
  for (const o of overridesForWeek(bp, s.week_number)) bits.push(`week override ${o.change}: ${o.reason}`);
  return bits.length ? bits.join("; ") : null;
}
