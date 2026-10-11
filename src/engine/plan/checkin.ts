/**
 * Recalibration and the 2-week check-in for a new plan (#121, C7, PLAN_CHECKIN).
 *
 * A newly generated plan is built from what the engine could know on day one:
 * often a sign-up estimate and paces from easy runs. The first two weeks are
 * exactly when that is most likely wrong, so a newly generated plan is rebuilt
 * in place at most twice:
 *
 *   benchmark_recalibration  after week 1, when its assessment benchmark was
 *                            completed: weeks 2+ use the measured paces.
 *   checkin_2w               at day 14: the plan re-anchors on two weeks of real
 *                            synced training instead of the estimate.
 *
 * The engine already eases for high RPE, fatigue and missed training, so the
 * check-in adds no rules of its own about how much to ease: rebuilding from the
 * real data is the adaptation. What it adds is the timing, the once-only
 * guarantee and a plain account of what it saw.
 *
 * Timing counts from the plan's first session date, which in-place rebuilds
 * never move. A plan more than 21 days past its first session is out of every
 * window, so turning the flag on never sweeps through existing plans at once.
 */

export type CheckinKind = "benchmark_recalibration" | "checkin_2w";

/** Generous on purpose: a plan can be generated weeks before its start date.
 *  Old plans are kept out by the windows below, which count from the first
 *  session, and in-place rebuilds never move that date. */
export const CHECKIN_MAX_AGE_DAYS = 60;
/** Windows in days since the first session, inclusive. Missed days catch up. */
const RECAL_WINDOW = [7, 13] as const;
const CHECKIN_WINDOW = [14, 21] as const;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10) + "T00:00:00Z") - Date.parse(a.slice(0, 10) + "T00:00:00Z")) / 86_400_000);
}

export type CheckinState = {
  today: string;
  planCreatedAt: string;
  /** First scheduled session of the plan, completed or not. */
  firstSessionDate: string | null;
  done: CheckinKind[];
  benchmarkCompleted: boolean;
};

/** What is due for this plan today, or null. */
export function dueCheckin(s: CheckinState): CheckinKind | null {
  if (!s.firstSessionDate) return null;
  if (daysBetween(s.planCreatedAt, s.today) > CHECKIN_MAX_AGE_DAYS) return null;
  const d = daysBetween(s.firstSessionDate, s.today);
  if (s.benchmarkCompleted && !s.done.includes("benchmark_recalibration") && d >= RECAL_WINDOW[0] && d <= RECAL_WINDOW[1]) {
    return "benchmark_recalibration";
  }
  if (!s.done.includes("checkin_2w") && d >= CHECKIN_WINDOW[0] && d <= CHECKIN_WINDOW[1]) return "checkin_2w";
  return null;
}

export type CheckinStats = {
  plannedSessions: number;
  completedSessions: number;
  plannedRunKm: number;
  actualRunKm: number;
  avgRpe: number | null;
};

const fmtKm = (km: number) => String(Math.round(km));

/** The account the athlete reads on the Adaptation page. No em-dashes, no
 *  exclamation marks, real numbers only. */
export function checkinSummary(kind: CheckinKind, s: CheckinStats | null, benchmark: { run: boolean; swim: boolean } = { run: true, swim: false }): { title: string; text: string } {
  if (kind === "benchmark_recalibration") {
    const what = benchmark.run && benchmark.swim ? "time trial and CSS test are" : benchmark.swim ? "CSS test is" : "time trial is";
    return {
      title: "Paces set from your benchmark",
      text: `Your ${what} in. From week 2 your sessions use the paces it set, instead of estimates from your easy runs.`,
    };
  }
  const st = s ?? { plannedSessions: 0, completedSessions: 0, plannedRunKm: 0, actualRunKm: 0, avgRpe: null };
  const parts = [`you completed ${st.completedSessions} of ${st.plannedSessions} planned sessions`];
  if (st.plannedRunKm > 0) parts.push(`${fmtKm(st.actualRunKm)} of ${fmtKm(st.plannedRunKm)} km of running`);
  if (st.avgRpe != null) parts.push(`average effort ${Math.round(st.avgRpe * 10) / 10} out of 10`);
  const share = st.plannedSessions > 0 ? st.completedSessions / st.plannedSessions : 1;
  const close = share < 0.6
    ? "Your plan now builds from what you actually managed, so the coming weeks start where you are."
    : "Your plan now builds from your real training rather than your starting estimate.";
  return { title: "Two-week check-in", text: `Two weeks in, ${parts.join(", ")}. ${close}` };
}
