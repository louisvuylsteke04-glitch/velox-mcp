import { describe, expect, it } from "vitest";
import { calibrateLoad, paceProxyTrimp } from "@/src/engine/load/calibrate";
import { computeRunFeatures, type RunInput } from "@/src/engine/load/run-features";

const run = (date: string, km: number, paceS: number, hr: number | null): RunInput => ({
  start_local: `${date}T07:00:00`, distance_m: km * 1000, moving_time_s: km * paceS, average_heartrate: hr,
});
const feats = (rs: RunInput[]) => rs.map((r) => computeRunFeatures(r, 190, 50, "male"));

describe("calibrateLoad", () => {
  it("leaves every run untouched when all runs have heart rate", () => {
    const f = feats([run("2026-10-01", 10, 300, 150), run("2026-10-02", 8, 330, 140), run("2026-10-03", 12, 290, 160)]);
    const { features, calibration } = calibrateLoad(f, [80, 40, 120]);
    expect(features).toEqual(f);
    expect(calibration.counts.heart_rate).toBe(3);
  });

  it("keeps the web app's raw pace proxy with fewer than 3 heart-rate runs", () => {
    const f = feats([run("2026-10-01", 10, 300, 150), run("2026-10-02", 8, 330, 140), run("2026-10-03", 12, 290, null)]);
    const { features, calibration } = calibrateLoad(f, [80, 40, 120]);
    expect(features[2].trimp).toBe(f[2].trimp);
    expect(calibration.kRelativeEffort).toBeNull();
    expect(calibration.counts.pace).toBe(1);
  });

  it("prefers relative effort, scaled by the median heart-rate ratio", () => {
    const f = feats([
      run("2026-10-01", 10, 300, 150), run("2026-10-02", 8, 330, 140), run("2026-10-03", 12, 290, 160),
      run("2026-09-20", 14, 320, null),
    ]);
    const re = [f[0].trimp! / 1.2, f[1].trimp! / 1.0, f[2].trimp! / 1.1, 70];
    const { features, calibration } = calibrateLoad(f, re);
    expect(calibration.kRelativeEffort).toBeCloseTo(1.1, 10);
    expect(features[3].trimp).toBeCloseTo(70 * 1.1, 10);
    expect(calibration.methods[3]).toBe("relative_effort");
  });

  it("falls back to the calibrated pace proxy without relative effort", () => {
    const f = feats([
      run("2026-10-01", 10, 300, 150), run("2026-10-02", 8, 330, 140), run("2026-10-03", 12, 290, 160),
      run("2026-09-20", 14, 320, null),
    ]);
    const { features, calibration } = calibrateLoad(f, [null, null, null, null]);
    const ratios = f.slice(0, 3).map((x) => x.trimp! / paceProxyTrimp(x)).sort((a, b) => a - b);
    expect(calibration.kPace).toBeCloseTo(ratios[1], 10);
    expect(features[3].trimp).toBeCloseTo(paceProxyTrimp(f[3]) * ratios[1], 10);
    expect(calibration.methods[3]).toBe("pace_calibrated");
  });

  it("never calibrates a run with no distance from pace", () => {
    const f = feats([
      run("2026-10-01", 10, 300, 150), run("2026-10-02", 8, 330, 140), run("2026-10-03", 12, 290, 160),
      { start_local: "2026-09-20T07:00:00", distance_m: 0, moving_time_s: 2700, average_heartrate: null },
    ]);
    const { calibration } = calibrateLoad(f, [null, null, null, null]);
    expect(calibration.methods[3]).toBe("pace");
  });
});
