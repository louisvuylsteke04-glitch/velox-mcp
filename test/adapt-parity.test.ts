/** Golden parity for adaptation: guards, missed-session policy, restoration window. */
import { describe, expect, it } from "vitest";
import golden from "./golden/adapt.json";
import { A_PLAN_START, A_TODAY, FORWARD, GUARD_CASES, GUARD_CONFIG, POLICY_CASES, RESTORATION_CASES, RESTORATION_CONFIG, WEEK_TARGETS } from "./golden/adapt-fixtures";
import { applyEditGuards, netPositionLines, parseAdaptAnalysis, DEFAULT_GUARD_CONFIG, type GuardablePlanEdit } from "@/src/engine/adapt/guards";
import { decideMissedSessionAction, restorationWindowOpen, DEFAULT_MISSED_POLICY, DEFAULT_RESTORATION } from "@/src/engine/adapt/missed-policy";

type G = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const g = golden as G;
const j = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("edit guards", () => {
  it.each(GUARD_CASES)("$key matches the web app", (c) => {
    const out = applyEditGuards({
      edit: c.edit as GuardablePlanEdit, analysis: parseAdaptAnalysis(c.analysis), forward: FORWARD, weekTargets: WEEK_TARGETS,
      planStart: A_PLAN_START, today: A_TODAY, config: GUARD_CONFIG, enforceCitation: true, enforceFloor: true, horizonMaxDate: c.horizon,
    });
    expect(j(out)).toEqual(g.guards[c.key]);
  });
  it("renders the same NET POSITION table", () => {
    expect(netPositionLines(FORWARD)).toEqual(g.net);
  });
  it("uses the web app's default config", () => {
    expect(DEFAULT_GUARD_CONFIG).toEqual(GUARD_CONFIG);
  });
});

describe("missed-session policy", () => {
  it.each(POLICY_CASES)("$key matches the web app", (c) => {
    expect(decideMissedSessionAction(c.input)).toEqual(g.policy[c.key]);
  });
  it.each(RESTORATION_CASES)("restoration window $key matches", (c) => {
    expect(restorationWindowOpen(c.weeks, c.concern, RESTORATION_CONFIG)).toBe(g.restoration[c.key]);
  });
  it("uses the web app's default configs", () => {
    expect(DEFAULT_MISSED_POLICY).toEqual(POLICY_CASES[0].input.config);
    expect(DEFAULT_RESTORATION).toEqual(RESTORATION_CONFIG);
  });
});
