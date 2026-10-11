/**
 * Heart-rate settings the load model uses. Ported from getHeartRateSettings in
 * the Vēlox web app's lib/strava-sync.ts, with the database read replaced by
 * arguments and "today" made explicit.
 *
 * Max HR: the measured value first, then 220 − age when a birth date is known,
 * then a flat default. Rest HR falls back to the shared default.
 */
import { DEFAULT_MAX_HR, DEFAULT_REST_HR, normaliseSex } from "./training-load";

export type HrSettings = {
  maxHr: number;
  restHr: number;
  sex: "male" | "female" | null;
  maxHrSource: "measured" | "age" | "default";
  restHrSource: "measured" | "default";
};

export function hrSettings(
  input: { maxHr?: number | null; restHr?: number | null; birthDate?: string | null; sex?: string | null },
  today: string,
): HrSettings {
  let maxHr = input.maxHr ?? null;
  let maxHrSource: HrSettings["maxHrSource"] = maxHr != null ? "measured" : "default";
  if (maxHr == null && input.birthDate) {
    const birth = new Date(`${input.birthDate}T00:00:00Z`);
    if (!Number.isNaN(birth.getTime())) {
      const age = (new Date(`${today}T00:00:00Z`).getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age >= 10 && age <= 100) {
        maxHr = Math.round(220 - age);
        maxHrSource = "age";
      }
    }
  }
  return {
    maxHr: maxHr ?? DEFAULT_MAX_HR,
    restHr: input.restHr ?? DEFAULT_REST_HR,
    sex: normaliseSex(input.sex),
    maxHrSource,
    restHrSource: input.restHr != null ? "measured" : "default",
  };
}
