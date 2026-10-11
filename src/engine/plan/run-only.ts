/**
 * Running goals get running sessions only (#121, RUN_ONLY_SESSIONS).
 *
 * The engine used to keep bike and swim as support sports for a runner who
 * already rides or swims, or who opted into cross-training at onboarding, and
 * the legacy and adaptation prompts could add them too. The rule now: when every
 * active goal is a running goal, the plan prescribes running, plus strength.
 * Their existing rides and swims still count toward load and fatigue; they just
 * are not prescribed.
 *
 * The engine applies it up front (assignRoles turns bike and swim off). Every
 * write path then runs the same filter as a backstop, so no path that writes
 * sessions (the legacy one-shot, an in-place rewrite, a coach adaptation) can
 * reintroduce another sport.
 *
 * Only running goals. A cyclist or swimmer keeps the short support runs the
 * engine gives them, and an athlete with any non-running goal (a triathlon later
 * in the season, a bike B race) keeps every sport those goals need.
 */

// Ported note: velox-mcp is running-only, so every plan is run-only. The web
// app's goal lookup (athleteIsRunOnly, goalsAreRunOnly) is not needed here.

/** Whether a session may sit in a run-only plan. Strength is allowed. A
 *  "cross_train" session is another sport by definition, whatever its tag. */
export function allowedInRunOnly(s: { sport?: string | null; workout_type?: string | null }): boolean {
  const sport = s.sport ?? "run";
  if (sport === "strength") return true;
  return sport === "run" && s.workout_type !== "cross_train";
}

/** Remove every session a run-only plan may not carry. Mutates; returns how many
 *  went. Dropping, never converting to a run: a converted session would add
 *  running load the volume model never planned. */
export function stripNonRunSessions<W extends { workouts: { sport?: string | null; workout_type?: string | null }[] }>(
  weeks: W[],
): number {
  let removed = 0;
  for (const w of weeks) {
    const before = w.workouts.length;
    w.workouts = w.workouts.filter(allowedInRunOnly);
    removed += before - w.workouts.length;
  }
  return removed;
}
