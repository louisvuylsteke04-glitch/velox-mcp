/**
 * Pure injury / red-flag / return-to-training model.
 *
 * No I/O — unit-testable in isolation (see scripts/plan-tests.ts). The plan
 * generator (lib/training-plan.ts) feeds it rows from athlete_health_concerns
 * and run_logs.pain_areas and turns the result into validator restrictions and
 * prompt blocks.
 */

export type ConcernRow = {
  concern_type: string; body_part: string | null; description: string;
  severity: number | null; status: string; last_mentioned_at: string;
};
export type PainLogRow = { activity_date: string; pain_areas: unknown };

/** Region-specific training restrictions implied by an active injury. The
 *  validator enforces what the workout schema can express (noHighImpactIntervals);
 *  the rest are stated as constraints in the prompt. */
export type InjuryRestrictions = {
  noHighImpactIntervals: boolean; // Achilles/calf/foot tendon, bone, hamstring
  noHillsPlyo: boolean;           // tendon / bone load
  noDownhill: boolean;            // knee / ITB / quad
  noSprintStrides: boolean;       // hamstring
  impactOff: boolean;             // bone stress → cross-train only
};

export type InjuryContext = {
  active: boolean;            // a current concern/pain — drives HARD validator constraints
  lowerLimb: boolean;        // any lower-limb structure
  region: string | null;     // dominant region label, e.g. "Achilles/calf/foot"
  restrictions: InjuryRestrictions;
  summary: string | null;    // one short clause for the prompt (current)
  history: string[];         // static past-injury list — SOFT caution only
};

/** Red-flag medical picture. When raised, stop prescribing load and recommend
 *  assessment — never diagnose. */
export type MedicalEscalation = { raised: boolean; reasons: string[] };

export type MissedTrainingAction = "continue" | "reduce" | "base_week" | "recalc_baseline";

// ── Region + red-flag patterns ────────────────────────────────────────────────

/** Lower-limb load structures whose presence forbids high-impact intervals. */
const LOWER_LIMB_RE = /achilles|calf|shin|knee|foot|feet|ankle|hamstring|\bhip\b|heel|plantar|tendon|it[\s-]?band|iliotibial|\bitbs?\b|peroneal|metatarsal|\btoe\b|patell|quad/i;
const ACHILLES_CALF_FOOT_RE = /achilles|calf|soleus|gastroc|plantar|heel|arch|metatarsal|\bfoot\b|feet|\btoe\b|peroneal|tendon/i;
// Bone stress = impact OFF (cross-train only). Requires EXPLICIT bone-stress
// language, not a bare mention of a bone. "tibia"/"fibula" are word-bounded so
// "iliotibial" (which contains the substring "tibia") is NOT caught here; and
// bare "shin" is handled as soft-tissue below, since shin splints (MTSS) are
// usually not a stress fracture — only "shin/tibial stress" escalates to bone.
const BONE_STRESS_RE = /\btibia\b|\bfibula\b|stress fracture|bone stress|stress reaction|navicular|sacr|femoral neck|metatarsal stress|(shin|tibial|tibia)\s*stress/i;
// Shin/lower-leg soft tissue (MTSS): ease load, no hills/intervals, but NOT
// impact-off — running easy is appropriate unless it escalates to bone stress.
const SHIN_RE = /\bshin\b|shin splints|medial tibial|\bmtss\b|tibialis/i;
const KNEE_ITB_RE = /knee|it[\s-]?band|iliotibial|\bitbs?\b|patell|quad/i;
const HAMSTRING_RE = /hamstring|posterior thigh/i;

// Red-flag terms — stop coaching, recommend assessment, never diagnose.
const RED_FLAG_RE = /chest pain|short(ness)? of breath|palpitation|faint|black ?out|passed out|dizz|stress fracture|stress reaction|focal bone|sharp .{0,20}(bone|shin|pain)|swelling|swollen|numb|tingl|pins and needles|neuro|can'?t bear weight|can'?t put .{0,12}weight|cannot put .{0,12}weight|unable to (walk|run)|limp|fever|vomit|red-?s\b|disordered eating|not eating enough|under[- ]?eating|amenorrh|missing periods/i;

const INJURY_CONCERN_TYPES = new Set(["injury", "pain", "soreness"]);
const NO_RESTRICTIONS: InjuryRestrictions = { noHighImpactIntervals: false, noHillsPlyo: false, noDownhill: false, noSprintStrides: false, impactOff: false };

/** Age in whole years on `today` (YYYY-MM-DD). Ported change: was new Date(). */
export function computeAgeYears(dob: string | null | undefined, today: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  // Calendar-based, not 365.25-day division: the average-day method floored to
  // one year short on the actual birthday, which could miss the masters=50
  // boundary by a day.
  const now = new Date(`${today}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - d.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age > 8 && age < 100 ? age : null;
}

function regionOf(text: string): string | null {
  // Order matters: explicit bone-stress language wins over the soft-tissue shin
  // pattern, and ITB ("iliotibial"/"ITB") must reach knee/ITB rather than being
  // swallowed by the (now word-bounded) bone-stress "tibia".
  if (BONE_STRESS_RE.test(text)) return "bone-stress";
  if (SHIN_RE.test(text)) return "shin";
  if (KNEE_ITB_RE.test(text)) return "knee/ITB";
  if (ACHILLES_CALF_FOOT_RE.test(text)) return "Achilles/calf/foot";
  if (HAMSTRING_RE.test(text)) return "hamstring";
  return null;
}

/** Build the active injury picture from tracked concerns + fresh run-log pain.
 *  `injuryHistory` is a soft caution only — it never triggers hard constraints. */
export function classifyInjury(
  concerns: ConcernRow[] | null,
  painLogs: PainLogRow[] | null,
  injuryHistory: string[] | null = null,
): InjuryContext {
  const items: { label: string; lowerLimb: boolean; region: string | null }[] = [];

  for (const c of concerns ?? []) {
    if (!INJURY_CONCERN_TYPES.has(c.concern_type)) continue;
    const part = c.body_part ?? "";
    const text = `${part} ${c.description}`;
    items.push({
      label: `${c.concern_type}${part ? ` (${part})` : ""}${c.severity ? ` sev ${c.severity}/5` : ""}`,
      lowerLimb: LOWER_LIMB_RE.test(text),
      region: regionOf(text),
    });
  }
  for (const log of painLogs ?? []) {
    const areas = Array.isArray(log.pain_areas) ? log.pain_areas as Array<{ body_part?: string; description?: string }> : [];
    for (const a of areas) {
      const part = a.body_part ?? "";
      if (!part && !a.description) continue;
      const text = `${part} ${a.description ?? ""}`;
      items.push({ label: `pain${part ? ` (${part})` : ""} on ${log.activity_date}`, lowerLimb: LOWER_LIMB_RE.test(text), region: regionOf(text) });
    }
  }

  const history = (injuryHistory ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 6);

  if (!items.length) {
    return { active: false, lowerLimb: false, region: null, restrictions: { ...NO_RESTRICTIONS }, summary: null, history };
  }

  const regions = new Set(items.map(i => i.region).filter((r): r is string => r != null));
  const restrictions: InjuryRestrictions = {
    noHighImpactIntervals: regions.has("Achilles/calf/foot") || regions.has("bone-stress") || regions.has("hamstring") || regions.has("shin"),
    noHillsPlyo:           regions.has("Achilles/calf/foot") || regions.has("bone-stress") || regions.has("shin"),
    noDownhill:            regions.has("knee/ITB"),
    noSprintStrides:       regions.has("hamstring"),
    impactOff:             regions.has("bone-stress"),
  };

  return {
    active: true,
    lowerLimb: items.some(i => i.lowerLimb),
    region: regions.size ? [...regions].join(", ") : null,
    restrictions,
    summary: items.slice(0, 2).map(i => i.label).join("; "),
    history,
  };
}

/** Detect red-flag medical signals across concerns + run-log pain text. */
export function detectMedicalEscalation(concerns: ConcernRow[] | null, painLogs: PainLogRow[] | null): MedicalEscalation {
  const reasons: string[] = [];
  for (const c of concerns ?? []) {
    if (RED_FLAG_RE.test(`${c.concern_type} ${c.body_part ?? ""} ${c.description}`)) reasons.push(`${c.concern_type}${c.body_part ? ` (${c.body_part})` : ""}`);
  }
  for (const log of painLogs ?? []) {
    const areas = Array.isArray(log.pain_areas) ? log.pain_areas as Array<{ body_part?: string; description?: string }> : [];
    for (const a of areas) {
      if (RED_FLAG_RE.test(`${a.body_part ?? ""} ${a.description ?? ""}`)) reasons.push(`pain${a.body_part ? ` (${a.body_part})` : ""}`);
    }
  }
  return { raised: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 3) };
}

/** Deterministic return-to-training response. Maps the gap since the last run to
 *  a volume factor + action. The signal is days-since-last-run, so the thresholds
 *  are set for that: a runner who trained within the last week is NOT "missing
 *  training" (a 3-6 day gap is normal for someone running 3-4x/week). Only a full
 *  week or more off warrants a reduction. */
export function missedTrainingAdjustment(daysSinceLastRun: number | null): { action: MissedTrainingAction; volumeFactor: number; note: string } {
  if (daysSinceLastRun == null || daysSinceLastRun <= 6) return { action: "continue", volumeFactor: 1.0, note: "" };
  if (daysSinceLastRun <= 13) return { action: "reduce", volumeFactor: 0.8, note: `About a week without running (${daysSinceLastRun} days): ease back roughly 20% this week before resuming progression.` };
  if (daysSinceLastRun <= 27) return { action: "base_week", volumeFactor: 0.65, note: `${daysSinceLastRun} days without running: resume with an easy base week, then rebuild.` };
  return { action: "recalc_baseline", volumeFactor: 0.5, note: `${daysSinceLastRun} days without running: rebuild from a reduced baseline, do not resume at prior volume.` };
}
