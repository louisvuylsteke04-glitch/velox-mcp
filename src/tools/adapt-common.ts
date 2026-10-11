import { ADAPT_INTRO, ADAPT_RULES, ADAPT_THINK, ADAPT_RESTORATION } from "../engine/policy/coach-text";
import { netPositionTable } from "../block/adapt";
import type { PlanBlock } from "../block/schema";

export const TRIGGERS = ["run_logged", "missed_session", "run_note", "wellness_logged", "calendar_edit", "preferences_change", "restoration_review"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** What Claude needs to adapt like the Vēlox coach: the rules and the NET POSITION table. */
export function adaptBrief(block: PlanBlock, today: string, trigger: Trigger): string {
  const table = netPositionTable(block, today);
  return [
    `TO ADAPT (trigger: ${trigger}): decide as the coach, then call velox_adapt_plan with your analysis and edits, or leave the plan as it is and say why. Use dry_run first if unsure.`,
    "",
    ADAPT_INTRO,
    "",
    ADAPT_THINK,
    "",
    ADAPT_RULES,
    ...(trigger === "restoration_review" ? ["", ADAPT_RESTORATION] : []),
    "",
    "NET POSITION (forward sessions; cite these values exactly in analysis.net_position_reviewed for every session you edit):",
    ...table,
  ].join("\n");
}
