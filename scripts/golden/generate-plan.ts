/**
 * Golden parity generator for the plan engine. Runs the ORIGINAL Vēlox web-app
 * code and writes test/golden/plan.json:
 *
 *  1. buildAthleteProfile against an in-memory Supabase stub holding the
 *     fixture runs (fixtures.ts) and PROFILE_INPUT.
 *  2. The hybrid generation path (lib/training-plan.ts authorPlan, then
 *     pinRaceSession) on each PLAN_CASES persona, with the flags at their
 *     preview values and the deterministic blueprint in place of the LLM call.
 *
 * Usage (from the web-app checkout):
 *   cd /path/to/Velox && npx tsx /path/to/velox-mcp/scripts/golden/generate-plan.ts /path/to/Velox
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NOW_MS, buildRuns } from "../../test/golden/fixtures";
import { PLAN_CASES, PLAN_TODAY, PROFILE_INPUT } from "../../test/golden/plan-fixtures";

const VELOX = resolve(process.argv[2] ?? ".");
const OUT = resolve(__dirname, "../../test/golden");
const lib = (p: string) => join(VELOX, "lib", p);

const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW_MS);
    else super(...(args as [string]));
  }
  static now() { return NOW_MS; }
}
globalThis.Date = FrozenDate as DateConstructor;

type Row = Record<string, unknown>;
type Q = { table: string; select: string; eq: Row; gte: Row; inF: Record<string, unknown[]>; desc: string | null; limit: number | null };

function stub(client: { from: unknown }, route: (q: Q) => Row[] | Row | null) {
  client.from = (table: string) => {
    const q: Q = { table, select: "", eq: {}, gte: {}, inF: {}, desc: null, limit: null };
    const run = () => {
      const r = route(q);
      if (!Array.isArray(r)) return r;
      let rows = r.filter((x) => Object.entries(q.eq).every(([k, v]) => !(k in x) || x[k] === v))
        .filter((x) => Object.entries(q.gte).every(([k, v]) => !(k in x) || String(x[k]) >= String(v)))
        .filter((x) => Object.entries(q.inF).every(([k, vs]) => !(k in x) || vs.includes(x[k])));
      if (q.desc) rows = [...rows].sort((a, b) => String(b[q.desc!]).localeCompare(String(a[q.desc!])));
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return rows;
    };
    const b: Record<string, unknown> = {
      select: (s: string) => { q.select = s; return b; },
      eq: (k: string, v: unknown) => { q.eq[k] = v; return b; },
      gte: (k: string, v: unknown) => { q.gte[k] = v; return b; },
      in: (k: string, v: unknown[]) => { q.inF[k] = v; return b; },
      not: () => b,
      contains: () => b,
      order: (k: string, o?: { ascending?: boolean }) => { q.desc = o?.ascending === false ? k : null; return b; },
      limit: (n: number) => { q.limit = n; return b; },
      maybeSingle: () => Promise.resolve({ data: run(), error: null }),
      single: () => Promise.resolve({ data: run(), error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return b;
  };
}

async function main() {
  const sb = await import(lib("supabase.ts"));
  const tl = await import(lib("training-load.ts"));
  const profileMod = await import(lib("plan/profile.ts"));
  const periodize = await import(lib("plan/periodize.ts"));
  const blueprintMod = await import(lib("plan/blueprint.ts"));
  const expand = await import(lib("plan/expand.ts"));
  const runOnly = await import(lib("plan/run-only.ts"));
  const inv = await import(lib("plan/invariants.ts"));
  const guidance = await import(lib("plan/guidance.ts"));
  const workouts = await import(lib("plan/workouts.ts"));
  const assessment = await import(lib("plan/assessment.ts"));
  const coachLlm = await import(lib("coach-llm.ts"));
  const dates = await import(lib("plan-dates.ts"));
  const rp = await import(lib("race-predictor.ts"));
  const { computeFeaturesFrom } = await import("./compute-features");
  const computeFeatures = computeFeaturesFrom(VELOX, tl.banisterCoeffs);

  // ── 1. Profile builder ────────────────────────────────────────────────────
  const runs = buildRuns();
  const feats = runs.map((r, i) => ({
    ...computeFeatures(r, PROFILE_INPUT.maxHr, PROFILE_INPUT.restHr, PROFILE_INPUT.sex),
    strava_activity_id: 1000 + i,
  })) as unknown as (Row & { activity_date: string; workout_type: string })[];
  const rpeRows = runs.map((r, i) => ({ strava_activity_id: 1000 + i, perceived_effort: r.rpe, activity_date: feats[i].activity_date })).filter((x) => x.perceived_effort != null);
  const buildWith = async (input: typeof PROFILE_INPUT) => {
  stub(sb.supabase, (q) => {
    switch (q.table) {
      case "athletes":
        if (q.select.includes("swim_css")) return { swim_css_sec_per_100m: null };
        return {
          name: PROFILE_INPUT.name, gender: PROFILE_INPUT.sex, weight_kg: PROFILE_INPUT.weightKg, date_of_birth: PROFILE_INPUT.birthDate,
          experience_level: PROFILE_INPUT.experienceLevel, max_heart_rate: PROFILE_INPUT.maxHr, resting_heart_rate: PROFILE_INPUT.restHr,
          hr_zone_max_pcts: PROFILE_INPUT.hrZoneMaxPcts, ftp_watts: null, injury_history: PROFILE_INPUT.injuryHistory,
          training_preferences: input.preferences,
        };
      case "activity_features":
        if (q.select.includes("km_splits")) return [];
        if (q.eq.workout_type === "race") return feats.filter((f) => f.workout_type === "race");
        return feats as unknown as Row[];
      case "cross_training_activities": return [];
      case "athlete_health_concerns": return input.concerns as unknown as Row[];
      case "run_logs":
        if (q.select.includes("perceived_effort")) return rpeRows;
        return PROFILE_INPUT.painLogs as unknown as Row[];
      case "planned_workouts":
        if (q.select.includes("fatigue_rating")) return PROFILE_INPUT.feedback as unknown as Row[];
        return [];
      case "race_results": return input.races as unknown as Row[];
      case "athlete_goals": return input.goal ? [{ ...input.goal, priority: "A" }] : [];
      default: throw new Error(`unstubbed table ${q.table}`);
    }
  });
  return profileMod.buildAthleteProfile(1);
  };
  const builtProfile = await buildWith(PROFILE_INPUT);
  // No races and no goal: paces fall back to the athlete's own easy runs.
  const builtProfileNoRace = await buildWith({ ...PROFILE_INPUT, races: [], goal: null, concerns: [] } as unknown as typeof PROFILE_INPUT);

  // ── 2. Plan pipeline per persona (authorPlan, hybrid, flags at preview) ────
  const cases: Record<string, unknown> = {};
  const all = [...PLAN_CASES, { key: "fixture_profile_half", profile: builtProfile, goal: { type: "half_marathon", raceDate: "2027-01-17", eventDistanceKm: null, targetTimeSecs: 5400 }, assessment: true }];
  for (const c of all) {
    const profile = structuredClone(c.profile);
    const today = PLAN_TODAY;
    const startDate = "startDate" in c ? (c as { startDate?: string }).startDate : null;
    const planStart = startDate && startDate >= today ? dates.mondayOfWeekYMD(startDate) : dates.nextMondayOnOrAfterYMD(today);
    const raceSlot = c.goal?.raceDate ? dates.raceSlotYMD(planStart, c.goal.raceDate) : null;
    const weeksToRace = raceSlot ? Math.max(1, raceSlot.week) : null;
    const totalWeeks = raceSlot ? Math.min(weeksToRace!, 52) : 12;
    const raceDate = raceSlot ? c.goal!.raceDate : null;
    const goalType = c.goal?.type ?? "improve_fitness";

    const envelope = periodize.buildPlanEnvelope({
      profile,
      goal: c.goal ? { type: c.goal.type, sport: "run", raceDate, eventDistanceKm: c.goal.eventDistanceKm } : null,
      totalWeeks, weeksToRace, runOnly: true, selfReport: profile.prefs.sport_volume ?? null,
    });
    const bpIn = (c as { blueprint?: unknown }).blueprint;
    const blueprint = (bpIn != null ? blueprintMod.parseBlueprint(typeof bpIn === "string" ? bpIn : JSON.stringify(bpIn), envelope) : null)
      ?? blueprintMod.defaultBlueprint(envelope, profile, goalType);
    const plan = expand.expandPlan({ envelope, blueprint, profile, prefs: profile.prefs, goalType, hasRace: !!raceDate });
    runOnly.stripNonRunSessions(plan.weeks);
    if (envelope.roles.run !== "off" && profile.run.paceAnchor?.source === "easy_ratio") {
      plan.plan_notes = [plan.plan_notes, "Your training paces are estimated from your easy runs for now. A race or a time trial will sharpen them."].filter(Boolean).join(" ");
    }
    const isMastersOrBeginner = (profile.ageYears ?? 0) >= 50 || profile.experienceLevel === "beginner";
    const ctx = { envelope, plan, profile, totalWeeks, hasRace: !!raceDate, isMastersOrBeginner };
    let violations = inv.checkPlan(ctx);
    let repaired: string[] = [];
    const critical = violations.filter((x: { severity: string }) => x.severity === "critical");
    if (critical.length) {
      repaired = inv.repairPlan(plan, critical).repaired;
      if (repaired.length) violations = inv.checkPlan(ctx);
    }
    const problems = expand.validatePlan(plan, totalWeeks);
    const stored = guidance.toStoredBlueprint(blueprint, 0);
    for (const week of plan.weeks) for (const s of week.workouts) {
      s.coach_cue = guidance.sessionGuidance(stored, { week_number: week.week_number, sport: s.sport ?? "run", workout_type: s.workout_type, title: s.title });
    }
    const raceKm = c.goal ? rp.raceKmFor(c.goal.type, c.goal.eventDistanceKm) : undefined;
    const racePace = c.goal?.targetTimeSecs && raceKm ? c.goal.targetTimeSecs / raceKm : null;
    workouts.structurePlan(plan, envelope, profile, { racePaceSecPerKm: racePace, goalType });
    const placed = c.assessment ? assessment.applyAssessmentWeek(plan, envelope, profile) : null;
    coachLlm.pinRaceSession(plan, planStart, raceDate, c.goal?.type ?? null, "run", {
      distanceKm: c.goal?.type === "ultra" ? c.goal.eventDistanceKm : null, durationMin: null,
    });
    cases[c.key] = {
      planStart, totalWeeks, weeksToRace, envelope, blueprint, plan,
      violations, repaired, problems, assessment: placed ? { benchmarkKm: placed.run ?? null } : null,
    };
  }

  writeFileSync(join(OUT, "plan.json"), JSON.stringify({ profile: builtProfile, profileNoRace: builtProfileNoRace, cases }));
  console.log(`wrote test/golden/plan.json (${Object.keys(cases).length} cases)`);
  globalThis.Date = RealDate;
}

main().catch((e) => { console.error(e); process.exit(1); });
