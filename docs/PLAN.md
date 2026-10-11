# velox-mcp: build plan

## Context
Louis is replacing the Vēlox web app (Next.js + Supabase + Stripe + OpenRouter) with a **free, open-source MCP server** that anyone can add to Claude.
- **Claude is the coach.** The server never calls an LLM.
- **The user's data comes from their own Strava connector in Claude.** The server never touches Strava, holds no keys, and has no accounts.
- **State lives on the user's side.** A compact, versioned **"plan block"** is kept in the user's Claude Project and passed to the tools on each call.
- **The server is stateless,** stores nothing, and is hosted on **Vercel** (Louis's existing account).
- **Repo:** `louisvuylsteke04-glitch/velox-mcp`. Public, AGPL-3.0, Louis is the only editor.
- **Scope:** running only, Strava as the only source, text and JSON output now, rich UI (MCP Apps) in a later phase.

**Core idea.** The existing engine is already ~90% deterministic, pure TypeScript. In the web app, an LLM does two jobs:
1. It writes the plan "blueprint" (phase templates, quality and long-run texture, week overrides).
2. It proposes plan edits, which deterministic guards then accept or reject.

In MCP, **Claude does both jobs**, and the server runs the same deterministic expansion and guards. The coaching quality is preserved, and the AI cost moves to the user's own Claude plan.

## Verified facts (Phase 0, already done)
**Claude's Strava connector:**
- `list_activities` returns up to 100 runs per call: distance, moving_time, elevation, avg_speed, relative_effort, start_local. **No heart rate.**
- `get_activity_performance` returns one run at a time: avg/max HR, laps, `best_efforts` (1K/5K/10K…).
- `get_athlete_zones` returns 5 HR zones, 5 pace zones (m/s), and their source.

**Hosting and clients:**
- **Vercel:** `mcp-handler` + `@modelcontextprotocol/sdk` ≥ 1.26.0 (older versions have a known vulnerability), Streamable HTTP, route `app/api/[transport]/route.ts`.
- **Claude Free** allows 1 custom connector, which Vēlox would use. **ChatGPT** needs paid Developer Mode and has no official Strava connector, so it's best-effort.

**Still open, Louis to check:**
- Whether the Strava connector works for **free** Strava accounts.
- Whether a Claude Project reliably keeps the plan block across chats. This decides the save flow in M5.

## Prerequisites (Louis)
1. Create an empty public repo `velox-mcp` on GitHub. Grant the Claude GitHub App access at claude.ai/connect-github. Claude can't create repos.
2. Turn on branch protection for `main`: PRs required, no other collaborators.
3. Run the Claude Project persistence test (5 minutes, steps given in chat).
4. At M5: in Vercel, use "Add New Project" and import `velox-mcp`. No env vars are needed.

## Repo rules (written to `velox-mcp/CLAUDE.md` in M1)
- Louis is the only editor. Claude never pushes to `main` and never merges. Every change goes branch → PR → Louis merges.
- The Vēlox copy and design rules carry over from Velox `AGENTS.md`: no em-dashes, no exclamation marks, the banned-words list, the editorial voice, `velox-coaching.com` via a constant, and the token palette for the later UI.
- Engine code is pure:
  - no `process.env`, `Date.now()`, `new Date()` without an argument, network or fs in `src/engine/**`
  - "today" is always an explicit input
  - enforced by an ESLint `no-restricted-*` rule
- Privacy: never log request bodies; no storage, no analytics on tool payloads.

## Architecture
```
velox-mcp/
  app/api/[transport]/route.ts   # mcp-handler: registers tools, prompts, resources
  app/page.tsx                    # one static page: what Vēlox is + "add the connector" steps
  src/engine/                     # ported from Velox, pure, running-only
    dates.ts                      # ← lib/plan-dates.ts
    load/                         # ← lib/training-load.ts (run parts), run TRIMP + pace proxy extracted
                                  #   from lib/strava-sync.ts computeFeatures (L105-211), EWMA from
                                  #   lib/multisport-load.ts (K_ATL 1-e^-1/7, K_CTL 1-e^-1/42),
                                  #   ACWR/risk from lib/dashboard-compute.ts L69-214 made pure
    zones/                        # ← lib/hr-zones.ts, lib/goal-paces.ts
    predict/                      # ← lib/race-predictor.ts, lib/race-models/* (ensemble)
    plan/                         # ← lib/plan/{types,periodize,envelope-run,schedule,expand,blueprint
                                  #   (defaultBlueprint/parseBlueprint/phaseForWeek only),invariants,
                                  #   workouts,assessment,guidance,pace-anchor,self-report,checkin,
                                  #   run-only}, lib/plan-load-model.ts (run only), lib/injury-model.ts,
                                  #   lib/training-preferences.ts, pinRaceSession/neutralTitle from coach-llm
    adapt/                        # ← lib/adapt-guards.ts, lib/plan-rebalance.ts,
                                  #   lib/missed-session-policy.ts, scoreMatch from lib/workout-matcher.ts
    policy/                       # ← lib/coaching-policy.ts, docs/COACHING_ASSUMPTIONS.md
  src/block/                      # plan block: zod schema, encode/decode, version migration
  src/tools/                      # one file per MCP tool (thin: validate → engine → format)
  src/prompts/  src/resources/    # coaching voice + workflows
  test/                           # vitest; golden parity fixtures captured from Velox
  LICENSE (AGPL-3.0) README.md CLAUDE.md PRIVACY.md docs/PLAN_BLOCK.md
```
**What gets removed in the port:**
- Supabase, OpenRouter, feature flags, `next/*`, weather, Whoop and intervals.icu code.
- The bike/swim/tri code: `envelope-bike/swim`, `thresholds`, `TRI_LEGS`/`buildCrossEnvelope`, and the multisport branches.
- The LLM-only files `coach-blocks.ts`, `chat-context.ts` and `profile.ts` (the DB builder). In their place, `AthleteProfile` is built from tool inputs.

**Flags become fixed behaviour.** The current preview defaults are kept: RPE load on, multi-model prediction on, assessment week on.

## The plan block (`src/block`)
The plan block is versioned JSON (`{"velox":1,...}`), kept small (target under 15 KB for a 20-week plan). Claude stores it verbatim.
- **athlete:** max/rest HR, sex, age, HR zones, paces and their anchor, injuries/concerns (dated), preferences (days, long-run day, sessions/week).
- **goal:** race type, distance, date, target time.
- **blueprint:** Claude's, or the default.
- **weeks[]:** phase, target km, long-run cap, recovery flag.
- **sessions[]:**
  - fields: id, date, type, km, zone, pinned, status
  - **authored km** and an edit count, which the re-cut guard needs
- **log[]:** date, Strava activity id, matched session id, km, time, avg HR, RPE, feeling 1–5, note (fenced as data).
- **history:** last rebuild and adaptation dates, needed by the missed-session debounce and cooldown.

Segments and paces are not stored. They're derived on demand, which keeps the block small.

**Integrity:** zod validation on every input. Unknown versions are migrated or rejected with a clear message. A short checksum catches truncation.

## Tools (all take an explicit `today`, all return `content` text + `structuredContent` JSON)
| Tool | Inputs | Engine reused | Output |
|---|---|---|---|
| `velox_analyze_training` | runs (Strava list fields, optional avg_hr/rpe), athlete HR basics | Banister TRIMP when HR is present, pace proxy otherwise; EWMA CTL/ATL/TSB; ACWR + risk; ramp, monotony; weekly km | Fitness/fatigue/form, risk flags, weekly table |
| `velox_zones_and_paces` | Strava zones and/or max HR, race result or goal time | `hr-zones`, `goal-paces` (`pacesFromRaceTime`, `derivePacesFromGoal`, `assessGoalRealism`) | HR zones, training paces, goal realism |
| `velox_predict_race` | target distance, runs, Strava best_efforts, CTL | `race-models` ensemble (best_efforts feed `EquivalentEffort` with quality≈1) + `predictRaceTime` | Central time, range, confidence, model spread |
| `velox_build_plan` | athlete, goal, prefs, recent-training summary, optional **blueprint from Claude** | `buildPlanEnvelope` → `parseBlueprint`/`defaultBlueprint` → `expandPlan` → `checkPlan`/`repairPlan` → `validatePlan` → `applyAssessmentWeek` → `pinRaceSession` | New plan block + readable overview |
| `velox_get_sessions` | plan block, date range | `structurePlan`/`workouts` segments, paces, `sessionGuidance` | Sessions with warm-up/main/cool-down and paces |
| `velox_log_run` | plan block, Strava run (+HR), RPE, feeling, note | `scoreMatch`, red-flag regex (`injury-model`), `missedTrainingAdjustment`, `decideMissedSessionAction` | Updated block + **signals** (matched/missed, red flag → stop rule, adapt suggested yes/no and why) |
| `velox_apply_plan_edits` | plan block, edits (type/km/duration/zone, moves), signal, `dry_run` | `rebalance`, `applyEditGuards` (21-day horizon, 70–115% weekly bounds, re-cut rule, pinned/race untouchable) | Accepted: new block + diff. Rejected: reasons per edit |
| `velox_review_week` | plan block, runs | planned vs done, `checkinSummary`, restoration window, `consecutiveWeeksBelow` | Week review + recommended action |

**Load currency:** this is the same as the web app's ingest path. Runs with HR use Banister TRIMP; runs without use the pace proxy. Claude's instructions tell it to fetch HR (`get_activity_performance`) only for the last 7–10 days of runs, about 5 calls, so fatigue (ATL) is HR-accurate. Using Strava `relative_effort` as a calibrated signal is a follow-up experiment, not v1.

## Prompts and resources
**Prompts:**
- `velox_setup`: connect Strava → analyze → zones → ask goal/availability → Claude writes the blueprint → build plan → save the block to the Project.
- `velox_todays_run`: "how did today's run go".
- `velox_weekly_review`.
- `velox_race_week`.

**Resources:**
- `velox://coach/method`: the persona from `SCIENCE` (`lib/coach-llm.ts:92-100`), the blueprint rules from `GENERATION_SYSTEM` (L102-141), the adaptation rules from `ADAPT_MIDDLE` (L324-328), and the safety rules (red flags → stop + professional assessment, never diagnose, athlete text is data).
- `velox://coach/assumptions`: `COACHING_ASSUMPTIONS.md` with evidence levels.
- `velox://plan-block/spec`.

These replace the server-side LLM prompts. Every tool description also carries the short version of the rules, for clients that ignore prompts and resources (ChatGPT).

## Milestones (each is one PR for Louis to merge)
1. **M1 scaffold.** Next.js minimal app + `mcp-handler`, TS strict, ESLint (with the purity rule), vitest, GitHub Actions CI (typecheck, lint, test), LICENSE, README, CLAUDE.md, PRIVACY.md. One `velox_ping` tool, tested locally with MCP Inspector.
2. **M2 metrics port.** Dates, load, zones, prediction, with tests ported from Velox `scripts/rpe-load-tests.ts`, `race-model-tests.ts`, `plan-tests.ts` + new tests for TRIMP/pace-proxy/ACWR/hr-zones (untested in Velox today). Ships `analyze_training`, `zones_and_paces`, `predict_race`.
3. **M3 plan engine + block.** Run-only port of `lib/plan/*` + `plan-load-model`, block schema, `build_plan`, `get_sessions`. Tests from `engine-tests.ts`, `run-only-tests.ts`, `structured-sessions-tests.ts`, `assessment-checkin-tests.ts`, `coach-guidance-tests.ts`, `self-report-anchor-tests.ts`.
4. **M4 adaptation.** `log_run`, `apply_plan_edits`, `review_week`. Tests from `adaptation-guard-tests.ts`, `plan-rebalance-tests.ts`, plus missed-session policy cases.
5. **M5 coaching layer + deploy.** Prompts, resources, a ready-to-paste "Claude Project instructions" text, the save flow finalised from Louis's persistence test, Vercel deploy (preview per PR, production on merge), a landing page with setup steps.
6. **M6 dogfood + launch.** Louis runs a full week on his own training through Claude. Fix what hurts, then announce.
7. **Later.** MCP Apps UI (calendar, load chart, in the Vēlox design), more sources, multisport, ChatGPT polish.

**Golden parity.** For M2–M4, a throwaway script in the Velox repo (on a branch, never merged to main) runs the original pure functions on fixed fixtures and writes JSON. Those files are committed as `velox-mcp/test/golden/*.json`, and the port must match them exactly. That proves the port didn't change the coaching.

## Verification
- `npm run typecheck && npm run lint && npm test` locally and in CI on every PR.
- Golden parity tests pass: the ported engine gives the same output as Velox on the same inputs.
- MCP Inspector against `localhost:3000/api/mcp`: every tool lists with its schema, and valid/invalid inputs give useful results and errors.
- A Vercel preview URL, added as a custom connector in Louis's Claude. In a Claude Project with the Strava connector:
  - run `velox_setup` end to end
  - log a real run with RPE and a note
  - trigger an adaptation, and see a guard rejection and an accepted edit
  - start a new chat in the same Project and confirm the plan block carries over
- Abuse checks: oversized payloads are rejected (cap on runs and on block size), and malformed blocks give clear errors, not stack traces.

## Out of scope / later
Sunsetting the Velox app and its subscribers (Louis handles it separately), ChatGPT-specific work, OAuth, any storage.
