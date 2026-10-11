import { describe, expect, it } from "vitest";
import { PLAN_CASES, PLAN_TODAY } from "./golden/plan-fixtures";
import { buildPlan } from "@/src/engine/plan/build";
import { blockFromPlan, sessionsBetween } from "@/src/block/plan";
import { decodeBlock, encodeBlock } from "@/src/block/codec";
import { addDaysYMD } from "@/src/engine/dates";

const athlete = { name: "Test", birth_date: null, sex: "male" as const, experience: "intermediate", max_hr: 190, rest_hr: 55, injury_history: [] };

describe.each(PLAN_CASES)("plan block for $key", (c) => {
  const result = buildPlan({
    profile: structuredClone(c.profile), goal: c.goal, today: PLAN_TODAY,
    startDate: c.startDate ?? null, blueprint: c.blueprint, assessment: c.assessment,
  });
  const block = blockFromPlan({ result, profile: c.profile, athlete, goal: c.goal, today: PLAN_TODAY, prefs: {} });
  const text = encodeBlock(block);

  it("round-trips through text with a valid checksum", () => {
    const back = decodeBlock(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.edited).toBe(false);
      expect(back.block).toEqual(block);
    }
  });

  it("rebuilds every session's structure and coach cue exactly", () => {
    const views = sessionsBetween(block, PLAN_TODAY, addDaysYMD(PLAN_TODAY, 600));
    expect(views).toHaveLength(result.sessions.length);
    const byKey = new Map(result.sessions.map((s) => [`${s.date}|${s.workout_type}`, s]));
    for (const v of views) {
      const original = byKey.get(`${v.date}|${v.type}`)!;
      expect(original).toBeDefined();
      expect(v.segments).toEqual(original.segments);
      expect(v.coach_cue).toEqual(original.coach_cue);
      expect([v.km, v.min, v.zone, v.title]).toEqual([original.target_distance_km, original.target_duration_min, original.target_pace_zone, original.title]);
    }
  });

  it("stays small enough to pass on every call", () => {
    expect(text.length).toBeLessThan(40_000);
  });
});

describe("decodeBlock", () => {
  const c = PLAN_CASES[0];
  const result = buildPlan({ profile: structuredClone(c.profile), goal: c.goal, today: PLAN_TODAY, assessment: false });
  const text = encodeBlock(blockFromPlan({ result, profile: c.profile, athlete, goal: c.goal, today: PLAN_TODAY, prefs: {} }));

  it("accepts a reformatted block", () => {
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    const r = decodeBlock("```json\n" + pretty + "\n```");
    expect(r.ok && !r.edited).toBe(true);
  });
  it("flags an edited value", () => {
    const r = decodeBlock(text.replace(/"km":\d+(\.\d+)?/, '"km":99'));
    expect(r.ok && r.edited).toBe(true);
  });
  it("refuses a cut-off block with a plain sentence", () => {
    const r = decodeBlock(text.slice(0, text.length / 2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cut off/);
  });
  it("refuses another version", () => {
    const r = decodeBlock(text.replace('"velox":1', '"velox":9'));
    expect(r.ok).toBe(false);
  });
});
