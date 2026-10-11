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

## Status

Early. The engine is being ported from the Vēlox web app. See [`docs/PLAN.md`](docs/PLAN.md).

| Milestone | Status |
|---|---|
| M1 Scaffold, `velox_ping` | in review |
| M2 Load, zones, race prediction | planned |
| M3 Plan engine and plan block | planned |
| M4 Logging runs and adapting the plan | planned |
| M5 Coaching prompts, deploy, setup guide | planned |

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
