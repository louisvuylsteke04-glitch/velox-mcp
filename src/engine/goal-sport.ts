/**
 * Which sport a goal belongs to. Pure, so both the API route and the plan engine
 * can share one answer instead of each deciding for itself.
 *
 * goal_type is authoritative: a marathon is running, an Ironman is triathlon. The
 * one exception is "improve_fitness", which carries no sport at all, so a cyclist
 * or a swimmer choosing base fitness has to tell us which sport they mean.
 */

export type GoalSport = "run" | "bike" | "swim" | "triathlon";

const AMBIGUOUS_SPORT_TYPES = new Set(["improve_fitness"]);
const VALID_SPORTS = new Set<GoalSport>(["run", "bike", "swim", "triathlon"]);

export function sportForGoalType(goalType: string): GoalSport {
  if (goalType === "bike_event") return "bike";
  if (goalType === "swim_event") return "swim";
  if (goalType.startsWith("triathlon")) return "triathlon";
  return "run";
}

/** goal_type wins except where it carries no sport, when the client's choice is used. */
export function resolveSport(dbGoalType: string, clientSport: unknown): GoalSport {
  if (AMBIGUOUS_SPORT_TYPES.has(dbGoalType) && typeof clientSport === "string" && VALID_SPORTS.has(clientSport as GoalSport)) {
    return clientSport as GoalSport;
  }
  return sportForGoalType(dbGoalType);
}
