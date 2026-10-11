# Adapting the plan

In the Vēlox web app, an LLM coach proposed changes to the plan and a layer of code checked them. In velox-mcp, **Claude is the coach** and the same code does the checking. The rules, thresholds and wording are the web app's; `test/adapt-parity.test.ts` proves the guards and policies give identical results.

## The loop

1. **`velox_log_run`**: a run comes in with how it felt (feeling 1-5, RPE, notes, pain).
   - It is matched to its planned session (same day), and earlier unrun sessions are marked missed after a day's grace.
   - The tool reads the signals and, when the plan should change, returns the coaching rules and the NET POSITION table.
2. **`velox_adapt_plan`**: Claude, as the coach, sends its analysis and edits. They are checked, applied, and a new block is returned.
3. **`velox_review_week`**: the weekly look. It shows planned against done, catches runs that were never logged, and applies the missed-session policy, restoration and check-ins.
4. **`velox_build_plan` with `previous_block`**: used for the bigger moves (a re-entry rebuild, the week-1 recalibration, the two-week check-in). The log and history carry over.

## Signals (what calls for a change)

| Signal | Rule (from the web app) |
|---|---|
| Medical red flag | Chest pain, can't bear weight, suspected bone stress and the rest of the list, in a note or a pain report. Stop hard training, advise a professional assessment, never diagnose. |
| Injury | Pain in the last 10 days, classified by region into restrictions (no high-impact intervals, no hills, no downhill, no strides, impact off). |
| Poor day | A feeling of 2 or less. One poor day is not on its own a reason to cut; two or three are. |
| Missed sessions | The missed-session policy: adapt; skip when adapted in the last 3 days unless a health concern or a race within 14 days changes things; one re-entry rebuild after 3 straight weeks under 50% of target (14-day cooldown); nothing more until a run is logged after a rebuild. |
| Restoration | After 2 straight weeks at 90% or more of target and no active concern, step reduced sessions back toward the original plan, at most once a week. |
| Check-ins | Days 7-13, once the week-1 time trial is done: recalibrate paces. Days 14-21: re-anchor the plan on two weeks of real training. Each happens once. |

## Guards (what an edit may not do)

- **Protected sessions.** Pinned sessions and the race are never touched. No session becomes another sport or a race. One run per day.
- **Citation.** Every edited session must be cited in `analysis.net_position_reviewed` with its NET POSITION values (within 0.15).
- **Re-cut.** A session already edited twice, or already more than 25% below its original, is not cut again without a named new signal (injury, illness, structural_absence).
- **Weekly envelope.** A week that has not started must stay between 70% and 115% of its target km. An injury or illness signal lifts the floor; nothing lifts the ceiling. A breach rejects the whole edit set.
- **Horizon.** Edits for missed sessions reach at most 21 days ahead.

Every rejected item comes back with its reason. `dry_run` checks edits without applying them.
