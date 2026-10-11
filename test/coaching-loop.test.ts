/**
 * The M4 coaching loop end to end, through the real HTTP handler: build a
 * plan, log runs with how they felt, adapt within the guards, miss sessions,
 * raise a red flag, rebuild, and reach the two-week check-in.
 */
import { describe, expect, it } from "vitest";
import { buildRuns } from "./golden/fixtures";
import { COACH_BLUEPRINT } from "./golden/plan-fixtures";
import { callTool } from "./helpers";
import { decodeBlock } from "@/src/block/codec";

const history = buildRuns().map((r, i) => ({
  id: String(1000 + i), name: r.name, sport_type: "Run", start_local: r.start_local,
  distance: r.distance_m, moving_time: r.moving_time_s, avg_speed: r.avg_speed_mps, average_heartrate: r.average_heartrate, workout_type: r.workout_type,
}));
const blockOf = (body: { result: { content: { text: string }[] } }) => {
  const m = body.result.content.at(-1)!.text.match(/```json\n([\s\S]*)\n```/);
  return m ? m[1] : null;
};
const parse = (t: string) => { const r = decodeBlock(t); if (!r.ok) throw new Error(r.error); return r.block; };
const run = (id: string, date: string, km: number, paceS = 330, hr = 140) => ({
  id, name: "Run", sport_type: "Run", start_local: `${date}T07:00:00`, distance: km * 1000, moving_time: Math.round(km * paceS), average_heartrate: hr,
});

async function freshPlan() {
  const body = await callTool("velox_build_plan", {
    today: "2026-10-11", runs: history, athlete: { max_hr: 190, rest_hr: 50, sex: "male" },
    goal: { goal_type: "half_marathon", race_date: "2027-01-17", goal_time_s: 5400 },
    preferences: { available_days: 5, preferred_days: [1, 2, 4, 5, 7], long_run_day: 7 },
    blueprint: COACH_BLUEPRINT, first_plan: false,
  });
  return blockOf(body)!;
}

describe("coaching loop", () => {
  it("logs a run, matches it to its session and suggests adapting after a poor day", async () => {
    const block = await freshPlan();
    const first = parse(block).sessions[0];
    const body = await callTool("velox_log_run", {
      today: first.date, plan_block: block, run: { ...run("r1", first.date, first.km ?? 8), rpe: 8 }, feeling: 2, note: "legs heavy, slept badly",
    });
    const out = body.result.structuredContent;
    expect(out.matched_session).toBe(first.id);
    expect(out.suggestion).toMatchObject({ adapt: true, trigger: "wellness_logged" });
    expect(body.result.content[1].text).toContain("NET POSITION");
    expect(body.result.content[1].text).toContain("One poor day is common");
    const next = parse(blockOf(body)!);
    expect(next.sessions.find((s) => s.id === first.id)!.status).toBe("completed");
    expect(next.log.at(-1)).toMatchObject({ activity: "r1", feeling: 2, rpe: 8, session: first.id });
  });

  it("logging the same run twice updates it instead of duplicating it", async () => {
    const block = await freshPlan();
    const first = parse(block).sessions[0];
    const a = await callTool("velox_log_run", { today: first.date, plan_block: block, run: run("r1", first.date, 8) });
    const b = await callTool("velox_log_run", { today: first.date, plan_block: blockOf(a)!, run: run("r1", first.date, 8), feeling: 4 });
    expect(b.result.structuredContent.replaced).toBe(true);
    expect(parse(blockOf(b)!).log).toHaveLength(1);
  });

  it("applies a cited trim, keeps the authored value, and counts the edit", async () => {
    const block = parse(await freshPlan());
    const today = block.sessions[0].date;
    const target = block.sessions.find((s) => ["tempo", "threshold", "interval"].includes(s.type) && s.date > today)!;
    const body = await callTool("velox_adapt_plan", {
      today, plan_block: JSON.stringify(block), trigger: "wellness_logged",
      reasoning: "Your legs need a lighter quality day, so this session is a little shorter.",
      analysis: { event: "poor day", decision: "trim one session", net_position_reviewed: [{ id: target.id, authored_km: target.km, current_km: target.km, times_edited: 0, verdict: "trim" }] },
      updates: [{ id: target.id, km: Math.round((target.km! - 1.5) * 10) / 10 }],
    });
    expect(body.result.structuredContent.applied).toBe(true);
    const next = parse(blockOf(body)!);
    const s = next.sessions.find((x) => x.id === target.id)!;
    expect(s.km).toBeCloseTo(target.km! - 1.5, 1);
    expect(s.authored?.km).toBe(target.km);
    expect(s.edits).toBe(1);
    expect(next.history.last_adapt).toBe(today);
  });

  it("rejects an uncited edit, a race edit and a week-envelope breach, and changes nothing", async () => {
    const block = parse(await freshPlan());
    const today = block.sessions[0].date;
    const wk3 = block.sessions.filter((s) => s.week === 3 && s.type !== "race");
    const race = block.sessions.find((s) => s.type === "race")!;
    const body = await callTool("velox_adapt_plan", {
      today, plan_block: JSON.stringify(block), trigger: "run_logged", reasoning: "x",
      analysis: { event: "e", decision: "d", net_position_reviewed: wk3.map((s) => ({ id: s.id, authored_km: s.km, current_km: s.km, times_edited: 0, verdict: "cut" })) },
      updates: [{ id: race.id, km: 10 }, { id: block.sessions.find((s) => s.week === 4)!.id, km: 3 }],
      deletes: wk3.map((s) => s.id),
    });
    const out = body.result.structuredContent;
    expect(out.applied).toBe(false);
    const text = body.result.content[0].text;
    expect(text).toMatch(/pinned or race session/);
    expect(text).toMatch(/below 70% of its/);
    expect(blockOf(body)).toBeNull();
  });

  it("dry run checks without changing anything", async () => {
    const block = parse(await freshPlan());
    const today = block.sessions[0].date;
    const s = block.sessions.find((x) => x.type === "easy" && x.date > today)!;
    const body = await callTool("velox_adapt_plan", {
      today, plan_block: JSON.stringify(block), trigger: "calendar_edit", reasoning: "x", dry_run: true,
      analysis: { event: "e", decision: "d", net_position_reviewed: [{ id: s.id, authored_km: s.km, current_km: s.km, times_edited: 0, verdict: "ok" }] },
      updates: [{ id: s.id, zone: "zone1" }],
    });
    expect(body.result.structuredContent).toMatchObject({ applied: false, dry_run: true, accepted: 1 });
    expect(blockOf(body)).toBeNull();
  });

  it("marks missed sessions in the weekly review and applies the missed-session policy", async () => {
    const block = await freshPlan();
    const body = await callTool("velox_review_week", { today: "2026-10-23", plan_block: block });
    const out = body.result.structuredContent;
    expect(out.weeks.map((w: { week: number }) => w.week)).toEqual([1, 2]);
    expect(out.weeks[0].skipped.length).toBeGreaterThan(0);
    expect(out.missed_policy.action).toBe("adapt");
    expect(out.suggestion).toMatchObject({ adapt: true, trigger: "missed_session" });
    expect(out.block_changed).toBe(true);
  });

  it("catches up unlogged runs in the review", async () => {
    const block = await freshPlan();
    const b = parse(block);
    const s = b.sessions[0];
    const body = await callTool("velox_review_week", { today: s.date, plan_block: block, runs: [run("x9", s.date, s.km ?? 8)] });
    expect(body.result.structuredContent.added_runs).toBe(1);
    expect(parse(blockOf(body)!).sessions[0].status).toBe("completed");
  });

  it("raises a red flag from what the athlete reports", async () => {
    const block = await freshPlan();
    const first = parse(block).sessions[0];
    const body = await callTool("velox_log_run", {
      today: first.date, plan_block: block, run: run("r2", first.date, 6),
      pain: [{ body_part: "shin", description: "sharp pain on the bone, I can't bear weight" }],
    });
    expect(body.result.structuredContent.health.red_flag).not.toBeNull();
    expect(body.result.content[0].text).toMatch(/RED FLAG.*professional assessment/s);
  });

  it("rebuilds from the previous block, keeping the log and the plan line's history", async () => {
    const block = await freshPlan();
    const first = parse(block).sessions[0];
    const logged = blockOf(await callTool("velox_log_run", { today: first.date, plan_block: block, run: run("r3", first.date, 8), feeling: 4 }))!;
    const rebuilt = await callTool("velox_build_plan", { today: "2026-10-25", runs: history, previous_block: logged, reason: "rebuild" });
    const next = parse(blockOf(rebuilt)!);
    expect(next.log.map((e) => e.activity)).toContain("r3");
    expect(next.history.last_rebuild).toBe("2026-10-25");
    expect(next.history.first_session).toBe(first.date);
    expect(next.athlete.max_hr).toBe(190);
    expect(next.plan.start).toBe("2026-10-26");
  });

  it("reaches the two-week check-in and records it on rebuild", async () => {
    const block = await freshPlan();
    const firstDate = parse(block).sessions[0].date;
    const day14 = new Date(Date.parse(`${firstDate}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const review = await callTool("velox_review_week", { today: day14, plan_block: block });
    expect(review.result.structuredContent.checkin?.kind).toBe("checkin_2w");
    const reviewed = blockOf(review) ?? block;
    const rebuilt = await callTool("velox_build_plan", { today: day14, runs: history, previous_block: reviewed, reason: "checkin_2w" });
    const next = parse(blockOf(rebuilt)!);
    expect(next.history.checkins_done).toContain("checkin_2w");
    const again = await callTool("velox_review_week", { today: day14, plan_block: blockOf(rebuilt)! });
    expect(again.result.structuredContent.checkin).toBeNull();
  });
});
