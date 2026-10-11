/**
 * The plan's week-number anchor.
 *
 * `training_plans.plan_start_date` is the athlete's training block anchor: the
 * Monday their week 1 began. It is the origin every stored `week_number` is
 * measured from, which means it must never move once sessions exist.
 *
 * It used to move. An in-place regeneration rewrote plan_start_date to the
 * current Monday and renumbered the sessions it inserted from 1, while every
 * past session kept the numbering of the ORIGINAL start. The two numberings
 * then collided inside one plan: on athlete 7's plan 31, week 2 held sessions
 * dated both 2026-06-16 and 2026-08-23. Anything that groups by week_number —
 * the weekly load bars, the phase strip, the "week N of M" counter, and the
 * mid-cycle phase detection that feeds the next regeneration — read those two
 * real weeks as one.
 *
 * The fix is to keep the anchor fixed and number freshly generated weeks from
 * it. Generation still runs over a window that starts on the current Monday
 * (the coach plans from today forward); only the numbering is offset back onto
 * the original origin.
 */

import { daysBetweenYMD } from "../dates";

/**
 * The longest a single training block is allowed to run before a regeneration
 * is treated as the start of a new one. A year of continuous build is not a
 * block any athlete is in; past this the anchor resets rather than stacking
 * weeks onto an origin from last season.
 */
export const MAX_BLOCK_WEEKS = 52;

/**
 * How many whole weeks the generation window starts after the anchor, so a
 * generated "week 1" can be stored as the plan week it actually is.
 *
 * Clamped at zero: an anchor in the FUTURE (a plan generated to start next
 * Monday, regenerated today) would otherwise produce negative week numbers.
 * Both dates are expected to be Mondays; a stray non-Monday floors rather than
 * rounds, which keeps the offset from ever overshooting into the next week.
 */
export function weekOffsetFromAnchor(anchorYMD: string, generationStartYMD: string): number {
  const days = daysBetweenYMD(anchorYMD, generationStartYMD);
  if (days <= 0) return 0;
  return Math.floor(days / 7);
}

/** One stored week of the plan's volume picture, as far as merging cares. */
type WeekTargetLike = { week_number: number };

/**
 * Splice freshly generated week targets onto the ones already stored.
 *
 * The weeks BEFORE the regeneration window are history the athlete has already
 * trained: their targets are what the load bars compare completed work against,
 * so dropping them would empty every past bar. The fresh targets are renumbered
 * onto the anchor and replace everything from the window's first week onward.
 */
export function mergeWeekTargets<T extends WeekTargetLike>(
  existing: readonly T[] | null | undefined,
  fresh: readonly T[],
  weekOffset: number,
): T[] {
  const renumbered = fresh.map(t => ({ ...t, week_number: t.week_number + weekOffset }));
  const firstFreshWeek = renumbered.length
    ? Math.min(...renumbered.map(t => t.week_number))
    : weekOffset + 1;

  const history = (existing ?? []).filter(
    t => Number.isFinite(t?.week_number) && t.week_number < firstFreshWeek,
  );

  return [...history, ...renumbered].sort((a, b) => a.week_number - b.week_number);
}
