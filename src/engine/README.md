# Engine

The coaching engine, ported from the Vēlox web app. Running only.

Rules, enforced by ESLint (`eslint.config.mjs`):

- Pure functions only. Same input, same output.
- `today` is always an argument. No `Date.now()`, no `new Date()` without an argument.
- No `process.env`, network, filesystem, logging, randomness, or framework imports.
- The engine never imports from `src/tools`, `src/server.ts` or `app/`.

Empty until M2. See `docs/PLAN.md`.
