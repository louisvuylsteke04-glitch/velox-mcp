/**
 * Timezone-safe calendar-date math for training plans.
 *
 * Plan dates are calendar days, not instants. The classic bug: build a Date
 * from a local-time string and format it back with toISOString(), and the day
 * shifts by one in any timezone east of UTC (CEST: local-midnight Monday is
 * Sunday 22:00 UTC, so toISOString() yields the Sunday). Vercel runs in UTC so
 * production happened to be correct, but a laptop in CEST produced a Sunday
 * planStart, scattering every session onto the wrong weekday.
 *
 * These helpers do ALL arithmetic at UTC midnight, so results are identical on
 * a CEST laptop, a US-Pacific laptop, and Vercel. Never reintroduce
 * getDay()/setDate()/new Date(localString) for plan dates — use these instead.
 */

/** Parse a YYYY-MM-DD (tolerates a trailing time component) as UTC midnight. */
export function parseYMD(ymd: string): Date {
  return new Date(ymd.slice(0, 10) + "T00:00:00Z");
}

/** Format a Date as YYYY-MM-DD using its UTC calendar day. */
export function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday (UTC) of the ISO week containing `ymd`, as YYYY-MM-DD. Sunday belongs
 *  to the week that began the previous Monday. */
export function mondayOfWeekYMD(ymd: string): string {
  const d = parseYMD(ymd);
  const od = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  d.setUTCDate(d.getUTCDate() + (od === 0 ? -6 : 1 - od));
  return toYMD(d);
}

/** Earliest Monday on or after `ymd` (returns `ymd` itself if it is a Monday). */
export function nextMondayOnOrAfterYMD(ymd: string): string {
  const d = parseYMD(ymd);
  const od = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (od === 0 ? 1 : od === 1 ? 0 : 8 - od));
  return toYMD(d);
}

/** Add `days` to a YYYY-MM-DD at UTC, returning YYYY-MM-DD. */
export function addDaysYMD(ymd: string, days: number): string {
  const d = parseYMD(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return toYMD(d);
}

/** ISO weekday of a YYYY-MM-DD computed in UTC: 1=Mon .. 7=Sun. */
export function isoWeekdayYMD(ymd: string): number {
  const wd = parseYMD(ymd).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Whole days from `aYMD` to `bYMD` (UTC), positive when b is after a. */
export function daysBetweenYMD(aYMD: string, bYMD: string): number {
  return Math.round((parseYMD(bYMD).getTime() - parseYMD(aYMD).getTime()) / 86_400_000);
}

/**
 * The (week, day) a race falls on relative to a Monday plan start, or null if
 * the race is before the plan starts. week is 1-based, day is ISO 1=Mon..7=Sun.
 * This is the single source of truth for the race slot: the plan must contain
 * `week` weeks for the race to land inside it. A race an exact multiple of 7
 * days out (same weekday as the Monday start) sits on day 1 of the NEXT week —
 * floor()+1, not ceil() — which is the off-by-one that dropped Monday races.
 */
export function raceSlotYMD(planStartYMD: string, raceYMD: string): { week: number; day: number } | null {
  const days = daysBetweenYMD(planStartYMD, raceYMD);
  if (days < 0) return null;
  return { week: Math.floor(days / 7) + 1, day: (days % 7) + 1 };
}
