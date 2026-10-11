import { describe, expect, it } from "vitest";
import { validateEdit } from "@/src/engine/adapt/validate";
import { FORWARD } from "./golden/adapt-fixtures";
import type { ForwardSnapshot } from "@/src/engine/adapt/guards";

const fwd = FORWARD as ForwardSnapshot[];

describe("validateEdit (the web app's adaptPlan checks)", () => {
  it("never touches the race or a pinned session", () => {
    const { edit, dropped } = validateEdit({ updates: [{ id: 15, fields: { target_distance_km: 10 } }], deletes: [15], moves: [{ id: 15, toDate: "2026-11-21" }] }, fwd);
    expect(edit.updates).toHaveLength(0);
    expect(edit.deletes).toHaveLength(0);
    expect(edit.moves).toHaveLength(0);
    expect(dropped.map((d) => d.reason)).toEqual(expect.arrayContaining(["pinned or race session"]));
  });
  it("keeps only valid fields, rounds them, and retitles on a type change", () => {
    const { edit } = validateEdit({ updates: [{ id: 4, fields: { workout_type: "easy", target_distance_km: 7.26, target_duration_min: 600, status: "completed" } }] }, fwd);
    expect(edit.updates[0].fields).toEqual({ workout_type: "easy", title: "Easy run", target_distance_km: 7.3 });
  });
  it("refuses another sport and a race insert", () => {
    const { edit, dropped } = validateEdit({
      updates: [{ id: 4, fields: { sport: "bike" } }],
      inserts: [{ date: "2026-10-29", workout_type: "race", sport: "run", target_distance_km: 5 }, { date: "2026-10-26", sport: "swim" }],
    }, fwd);
    expect(edit.updates).toHaveLength(0);
    expect(edit.inserts.map((i) => i.workout_type)).toEqual(["easy"]); // a "race" insert becomes easy, never a race
    expect(dropped.some((d) => d.reason === "running only")).toBe(true);
  });
  it("allows one run per day", () => {
    const { edit, dropped } = validateEdit({ moves: [{ id: 3, toDate: "2026-10-28" }], inserts: [{ date: "2026-10-30", sport: "run" }] }, fwd);
    expect(edit.moves).toHaveLength(0);
    expect(edit.inserts).toHaveLength(0);
    expect(dropped).toHaveLength(2);
  });
  it("keeps moves and inserts inside the forward window", () => {
    const { edit } = validateEdit({ moves: [{ id: 3, toDate: "2027-03-01" }], inserts: [{ date: "2026-10-01", sport: "run" }] }, fwd);
    expect(edit.moves).toHaveLength(0);
    expect(edit.inserts).toHaveLength(0);
  });
});
