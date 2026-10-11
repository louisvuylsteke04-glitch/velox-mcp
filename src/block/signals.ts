/**
 * What the coach should notice, read from a plan block: health flags, the
 * missed-session policy, the restoration window and due check-ins. All rules
 * are the web app's (injury-model, missed-session-policy, plan/checkin).
 */
import { addDaysYMD, daysBetweenYMD } from "../engine/dates";
import { classifyInjury, detectMedicalEscalation, type ConcernRow, type PainLogRow, type InjuryContext, type MedicalEscalation } from "../engine/injury-model";
import {
  consecutiveWeeksBelow, decideMissedSessionAction, restorationWindowOpen, shouldRunRestorationReview,
  DEFAULT_MISSED_POLICY, DEFAULT_RESTORATION, type MissedPolicyDecision,
} from "../engine/adapt/missed-policy";
import { dueCheckin, checkinSummary, type CheckinKind } from "../engine/plan/checkin";
import { BENCHMARK_PHASE } from "../engine/plan/assessment";
import { completedWeeks } from "./adapt";
import { authoredOf, type PlanBlock } from "./schema";

export type Health = { injury: InjuryContext; medical: MedicalEscalation; painDays: number };

/** Pain from runs in the last 10 days and notes from the last 14 (the web app's windows). */
export function health(block: PlanBlock, today: string): Health {
  const since10 = addDaysYMD(today, -10);
  const since14 = addDaysYMD(today, -14);
  const painLogs: PainLogRow[] = block.log
    .filter((e) => e.date >= since10 && e.pain?.length)
    .map((e) => ({ activity_date: e.date, pain_areas: e.pain }));
  // Notes only feed the red-flag check: the injury classifier reads pain, not prose.
  const noteConcerns: ConcernRow[] = block.log
    .filter((e) => e.date >= since14 && e.note)
    .map((e) => ({ concern_type: "note", body_part: null, description: e.note!, severity: null, status: "active", last_mentioned_at: `${e.date}T12:00:00Z` }));
  return {
    injury: classifyInjury(null, painLogs, block.athlete.injury_history),
    medical: detectMedicalEscalation(noteConcerns, painLogs),
    painDays: painLogs.length,
  };
}

/** The web app's missed-session policy, with its inputs read from the block. */
export function missedDecision(block: PlanBlock, today: string, h: Health): MissedPolicyDecision & { weeksBelow: number } {
  const cfg = DEFAULT_MISSED_POLICY;
  const weeks = completedWeeks(block, today);
  const lastRun = block.log.length ? block.log[block.log.length - 1].date : null;
  const lastMissed = block.history.last_missed_adapt;
  const newConcern = lastMissed != null && block.log.some((e) => e.date > lastMissed && (e.pain?.length || false));
  const near = block.sessions.some((s) => s.status === "planned" && s.date >= today && (
    (s.type === "race" && s.date <= addDaysYMD(today, cfg.raceWindowDays)) ||
    (s.pinned && s.date <= addDaysYMD(today, cfg.pinnedWindowDays))));
  const decision = decideMissedSessionAction({
    today, lastMissedAdaptAt: lastMissed, lastRebuildAt: block.history.last_rebuild, lastRunLoggedAt: lastRun,
    completedWeeks: weeks, newHealthConcernSince: newConcern || h.medical.raised, raceOrPinnedNear: near, config: cfg,
  });
  return { ...decision, weeksBelow: consecutiveWeeksBelow(weeks, cfg.structuralBelowPct) };
}

/** Restoration: the athlete has met their targets and parts of the plan sit below authored. */
export function restoration(block: PlanBlock, today: string, h: Health): { due: boolean; reason: string } {
  const weeks = completedWeeks(block, today);
  const open = restorationWindowOpen(weeks, h.injury.active || h.medical.raised, DEFAULT_RESTORATION);
  const hasDrift = block.sessions.some((s) => {
    if (s.status !== "planned" || s.date < today) return false;
    const a = authoredOf(s);
    return a.km != null && s.km != null && a.km > 0 && s.km < a.km * (1 - DEFAULT_RESTORATION.driftPct / 100);
  });
  const r = shouldRunRestorationReview({ today, windowOpen: open, hasDrift, lastReviewAt: block.history.last_restoration, config: DEFAULT_RESTORATION });
  return { due: r.run, reason: r.reason };
}

/** The web app's check-in timing for a new plan, with a summary in its words. */
export function checkin(block: PlanBlock, today: string): { kind: CheckinKind; title: string; text: string } | null {
  const benchmark = block.sessions.find((s) => s.week === 1 && s.seg?.some((g) => g.phase === BENCHMARK_PHASE));
  const kind = dueCheckin({
    today,
    planCreatedAt: block.history.plan_created ?? block.made,
    firstSessionDate: block.history.first_session ?? block.sessions[0]?.date ?? null,
    done: block.history.checkins_done,
    benchmarkCompleted: benchmark?.status === "completed",
  });
  if (!kind) return null;
  const first = block.history.first_session ?? block.plan.start;
  const end = addDaysYMD(first, 13);
  const window = block.sessions.filter((s) => s.date >= first && s.date <= end && s.date < today);
  const logs = block.log.filter((e) => e.date >= first && e.date <= end);
  const rpes = logs.map((e) => e.rpe).filter((x): x is number => x != null);
  const summary = checkinSummary(kind, {
    plannedSessions: window.length,
    completedSessions: window.filter((s) => s.status === "completed").length,
    plannedRunKm: window.reduce((a, s) => a + (s.km ?? 0), 0),
    actualRunKm: logs.reduce((a, e) => a + e.km, 0),
    avgRpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
  });
  return { kind, ...summary };
}

/** Days since a date, for plain-language reporting. */
export const daysSince = (d: string | null, today: string) => (d ? daysBetweenYMD(d, today) : null);
