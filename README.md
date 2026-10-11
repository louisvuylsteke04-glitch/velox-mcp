# Vēlox

**An open-source running coach for Claude.**
Free. Nothing stored. Your data stays between you, Strava and Claude.

Vēlox is an [MCP](https://modelcontextprotocol.io) server. Add it to Claude as a connector, connect Strava, and Claude coaches you with the Vēlox method: training load, zones, race prediction, a periodised plan, and a plan that adapts to how your runs actually went.

## How it works

```
Strava connector ──runs──▶ Claude ──runs + plan──▶ Vēlox (computes, stores nothing)
                             ▲                            │
   your Claude Project keeps └──── analysis + new plan ◀──┘
   your plan between chats
```

- **Claude is the coach.** Vēlox gives it a deterministic, tested engine to coach with. Vēlox never calls an AI model.
- **No accounts, no database.** Your plan is a small text block Claude keeps in your Claude Project.
- **Running only**, for now.

## Use it

1. **Add the connector.** In Claude, open Settings, then Connectors, and add a custom connector with the Vēlox URL (shown on the Vēlox site).
2. **Connect Strava** in the same place.
3. **Make a Claude Project** called Vēlox and paste in the instructions from the site (also the `velox://setup/project-instructions` resource).
4. In the Project, say **Set me up**.

After a run, tell Claude how it went. On Sundays, ask for your weekly review. Your plan lives in the Project as one file, `velox-plan.json`.

## What is inside

| Tool | What it does |
|---|---|
| `velox_analyze_training` | Fitness, fatigue, form, injury-risk ratio and a weekly table from your runs |
| `velox_zones_and_paces` | Heart-rate zones and training paces |
| `velox_predict_race` | Race-time prediction with a range, from ten published models and the Vēlox predictor |
| `velox_build_plan` | A periodised plan from your own history, shaped by Claude as the coach |
| `velox_get_sessions` | Any week's sessions with warm-up, main set, cool-down and paces |
| `velox_log_run` | Logs a run and how it felt, and says what a coach should act on |
| `velox_adapt_plan` | Applies Claude's changes after the safety rules |
| `velox_review_week` | Last week against the plan, missed sessions, restoration and check-ins |

Prompts: `velox_setup`, `velox_todays_run`, `velox_weekly_review`, `velox_race_week`. Resources: the coaching method, how to adapt, how to shape a plan, and the Project instructions.

## Status

Close to a first release. The engine is ported from the Vēlox web app and matches it on golden fixtures. See [`docs/PLAN.md`](docs/PLAN.md), and [`docs/DEPLOY.md`](docs/DEPLOY.md) to run it.

| Milestone | Status |
|---|---|
| M1 Scaffold, `velox_ping` | done |
| M2 Load, zones, race prediction | done |
| M3 Plan engine and plan block | done |
| M4 Logging runs and adapting the plan | done |
| M5 Coaching prompts, deploy, setup guide | in review |

## Develop

```bash
npm install
npm run dev        # http://localhost:3000, MCP endpoint at /api/mcp
npm run check      # typecheck, lint, tests
```

Try it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3000/api/mcp
```

## Contributing

Issues and pull requests are welcome. The project has one maintainer, who reviews and merges every change.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service, you share your changes under the same license.
