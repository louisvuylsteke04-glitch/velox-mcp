import { describe, expect, it } from "vitest";
import { TODAY, buildRuns } from "./golden/fixtures";
import { COACH_BLUEPRINT } from "./golden/plan-fixtures";
import { callTool, rpc } from "./helpers";

const runs = buildRuns().map((r, i) => ({
  id: String(1000 + i), name: r.name, sport_type: "Run", start_local: r.start_local,
  distance: r.distance_m, moving_time: r.moving_time_s, elevation_gain: r.elevation_gain_m,
  avg_speed: r.avg_speed_mps, average_heartrate: r.average_heartrate, workout_type: r.workout_type, rpe: r.rpe,
}));
const base = {
  today: TODAY,
  athlete: { max_hr: 190, rest_hr: 50, sex: "male", experience: "intermediate", name: "Test Runner" },
  runs,
  goal: { goal_type: "half_marathon", race_date: "2027-01-17", goal_time_s: 5400 },
  preferences: { available_days: 5, preferred_days: [2, 3, 4, 6, 7], long_run_day: 7 },
};
const blockOf = (body: { result: { content: { text: string }[] } }) =>
  body.result.content.at(-1)!.text.match(/```json\n([\s\S]*)\n```/)![1];

describe("velox_build_plan", () => {
  it("builds a plan on the default blueprint and hands back the coaching brief and a block", async () => {
    const body = await callTool("velox_build_plan", base);
    expect(body.result.isError).not.toBe(true);
    const out = body.result.structuredContent;
    expect(out.plan_start).toBe("2026-10-12");
    expect(out.total_weeks).toBe(14);
    expect(out.blueprint_source).toBe("fallback");
    expect(out.weeks).toHaveLength(14);
    expect(out.weeks.at(-1).long_km).toBe(0); // race week: the race is not a long run
    const texts = body.result.content.map((c: { text: string }) => c.text);
    expect(texts[1]).toContain("COACH INSTRUCTIONS");
    expect(texts[1]).toContain("BRIEF");
    expect(JSON.parse(blockOf(body)).velox).toBe(1);
    for (const t of texts) expect(t).not.toMatch(/—/);
  });

  it("uses the coach's blueprint when one is passed and drops the brief", async () => {
    const body = await callTool("velox_build_plan", { ...base, blueprint: COACH_BLUEPRINT });
    expect(body.result.structuredContent.blueprint_source).toBe("coach");
    expect(body.result.content).toHaveLength(2);
    expect(JSON.parse(blockOf(body)).plan.blueprint.coach_analysis).toBe(COACH_BLUEPRINT.coach_analysis);
  });

  it("says so when a blueprint cannot be used", async () => {
    const body = await callTool("velox_build_plan", { ...base, blueprint: { phases: "nonsense" } });
    expect(body.result.structuredContent.blueprint_rejected).toBe(true);
    expect(body.result.content[0].text).toContain("could not be used");
  });

  it("builds a general block with no goal and no history from the stated volume", async () => {
    const body = await callTool("velox_build_plan", { today: TODAY, runs: [], preferences: { weekly_km_now: 25 } });
    const out = body.result.structuredContent;
    expect(out.total_weeks).toBe(12);
    expect(out.race_date).toBeNull();
    expect(out.weeks.reduce((a: number, w: { runs: number }) => a + w.runs, 0)).toBeGreaterThan(0);
  });

  it("raises a medical red flag in plain words and never diagnoses", async () => {
    const body = await callTool("velox_build_plan", {
      ...base, injuries: { current: [{ type: "pain", body_part: "shin", description: "sharp shin pain, can't bear weight" }] },
    });
    const out = body.result.structuredContent;
    expect(out.safety.medical_red_flag).not.toBeNull();
    expect(body.result.content[0].text).toMatch(/RED FLAG/);
    expect(body.result.content[0].text).toMatch(/professional assessment/);
  });

  it("takes paces from a recent race result", async () => {
    const body = await callTool("velox_build_plan", { ...base, race_results: [{ date: "2026-09-20", distance_km: 10, time_s: 2520, name: "Parkloop 10K" }] });
    expect(body.result.structuredContent.paces.anchor).toContain("Parkloop 10K");
  });
});

describe("velox_get_sessions", () => {
  it("returns the next 7 days with structure, paces and cues", async () => {
    const built = await callTool("velox_build_plan", { ...base, blueprint: COACH_BLUEPRINT, first_plan: false });
    const body = await callTool("velox_get_sessions", { today: TODAY, plan_block: blockOf(built), from: "2026-10-26" });
    const out = body.result.structuredContent;
    expect(out.from).toBe("2026-10-26");
    expect(out.to).toBe("2026-11-01");
    expect(out.sessions.length).toBeGreaterThan(0);
    const quality = out.sessions.find((s: { type: string }) => ["tempo", "threshold", "interval"].includes(s.type));
    expect(quality.segments.map((g: { phase: string }) => g.phase)).toContain("warmup");
    expect(quality.coach_cue).toMatch(/This phase/);
    expect(out.sessions.every((s: { target_pace: string | null; type: string }) => s.type === "race" || s.target_pace)).toBe(true);
  });

  it("refuses a cut-off block with a plain sentence", async () => {
    const built = await callTool("velox_build_plan", base);
    const text = blockOf(built);
    const body = await callTool("velox_get_sessions", { today: TODAY, plan_block: text.slice(0, 500) });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/cut off/);
  });

  it("notes a hand-edited block and still reads it", async () => {
    const built = await callTool("velox_build_plan", base);
    const edited = blockOf(built).replace(/"km":\d+(\.\d+)?/, '"km":8');
    const body = await callTool("velox_get_sessions", { today: TODAY, plan_block: edited });
    expect(body.result.structuredContent.edited).toBe(true);
    expect(body.result.content[0].text).toMatch(/changed by hand/);
  });
});

describe("registry", () => {
  it("lists the M3 tools", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["velox_build_plan", "velox_get_sessions"]));
  });
});
