/**
 * Golden parity for the plan engine: the port must reproduce the web app's
 * athlete profile and its hybrid generation path exactly (test/golden/plan.json,
 * written by scripts/golden/generate-plan.ts from the ORIGINAL code).
 */
import { describe, expect, it } from "vitest";
import golden from "./golden/plan.json";
import { NOW_MS, buildRuns } from "./golden/fixtures";
import { PLAN_CASES, PLAN_TODAY, PROFILE_INPUT } from "./golden/plan-fixtures";
import { computeRunFeatures } from "@/src/engine/load/run-features";
import { buildAthleteProfile, type AthleteProfile } from "@/src/engine/plan/profile";
import { anchorDataFrom } from "@/src/engine/plan/anchor-data";
import { buildPlan } from "@/src/engine/plan/build";

const j = <T>(x: T): T => JSON.parse(JSON.stringify(x));
type G = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const g = golden as G;

function portProfile(variant: "full" | "no_race" = "full"): AthleteProfile {
  const input = variant === "full" ? PROFILE_INPUT : { ...PROFILE_INPUT, races: [], goal: null, concerns: [] };
  const runs = buildRuns();
  const feats = runs.map((r) => computeRunFeatures(r, PROFILE_INPUT.maxHr, PROFILE_INPUT.restHr, PROFILE_INPUT.sex));
  return buildAthleteProfile({
    today: PLAN_TODAY, nowMs: NOW_MS,
    runs: feats.map((f, i) => ({ ...f, rpe: runs[i].rpe })),
    name: PROFILE_INPUT.name, birthDate: PROFILE_INPUT.birthDate, sex: PROFILE_INPUT.sex, weightKg: PROFILE_INPUT.weightKg,
    experienceLevel: PROFILE_INPUT.experienceLevel, maxHr: PROFILE_INPUT.maxHr, restHr: PROFILE_INPUT.restHr,
    hrZoneMaxPcts: PROFILE_INPUT.hrZoneMaxPcts, injuryHistory: PROFILE_INPUT.injuryHistory,
    concerns: input.concerns, painLogs: PROFILE_INPUT.painLogs, feedback: PROFILE_INPUT.feedback,
    preferences: PROFILE_INPUT.preferences,
    anchor: anchorDataFrom({ runs: feats, races: input.races, goal: input.goal, nowMs: NOW_MS }),
  });
}

describe("athlete profile", () => {
  it("matches the web app's buildAthleteProfile on the same data", () => {
    const p = j(portProfile());
    const expected = { ...g.profile, athleteId: 0 };
    expect(p).toEqual(expected);
  });
  it("matches it without race results or a goal (paces from the race-tagged run)", () => {
    const p = j(portProfile("no_race"));
    expect(p).toEqual({ ...g.profileNoRace, athleteId: 0 });
    // The fixture runs include a race-tagged 10K, so that run anchors the paces.
    expect(p.run.paceAnchor?.source).toBe("race_activity");
  });
});

const cases = [
  ...PLAN_CASES,
  { key: "fixture_profile_half", profile: portProfile(), goal: { type: "half_marathon", raceDate: "2027-01-17", eventDistanceKm: null, targetTimeSecs: 5400 }, assessment: true },
];

describe.each(cases)("plan $key", (c) => {
  const expected = g.cases[c.key];
  const result = buildPlan({
    profile: structuredClone(c.profile), goal: c.goal, today: PLAN_TODAY,
    startDate: "startDate" in c ? (c as { startDate?: string | null }).startDate : null,
    blueprint: "blueprint" in c ? (c as { blueprint?: unknown }).blueprint : undefined,
    assessment: c.assessment,
  });

  it("matches the plan window", () => {
    expect([result.planStart, result.totalWeeks, result.weeksToRace]).toEqual([expected.planStart, expected.totalWeeks, expected.weeksToRace]);
  });
  it("matches the envelope and the blueprint", () => {
    expect(j(result.envelope)).toEqual(expected.envelope);
    expect(j(result.blueprint)).toEqual(expected.blueprint);
  });
  it("matches every week and session", () => {
    expect(j(result.plan)).toEqual(expected.plan);
  });
  it("matches the invariant findings, repairs and assessment week", () => {
    expect(j(result.violations)).toEqual(expected.violations);
    expect(result.repaired).toEqual(expected.repaired);
    expect(result.structuralProblems).toEqual(expected.problems);
    expect(result.assessment).toEqual(expected.assessment);
  });
});
