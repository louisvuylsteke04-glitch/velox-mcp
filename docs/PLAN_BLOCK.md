# The plan block

Vēlox stores nothing. Everything it needs to keep coaching an athlete lives in the **plan block**: a small JSON document the athlete keeps in their Claude Project and Claude passes to the tools on every call.

## Lifecycle

1. `velox_build_plan` returns a new block as its last content item.
2. Claude saves it in the athlete's Claude Project, replacing the previous one.
3. Every later call that reads or changes the plan takes `plan_block` and, if it changes anything, returns the new block to save.

## Format (version 1)

Compact JSON. Field order and whitespace do not matter.

| Field | What it holds |
|---|---|
| `velox` | Format version, `1`. |
| `made` | The day the plan was built. |
| `athlete` | Name, birth date, sex, experience, max and rest HR, past injuries, preferences, and the training **paces** with what they stand on (race result, race run, predictor, or easy-run ratio). |
| `goal` | Race type, date, distance (ultra only) and target time, or `null` for a general block. |
| `plan` | Start Monday, length, the coach's notes, every week's phase, target km and long-run cap, and the **blueprint** (the coach's weekly template, quality focus and long-run texture per phase, and week overrides). |
| `sessions` | One entry per session: `id` (its date, `.2` for a second session that day), `date`, `week`, `type`, `km`, and when set `min`, `zone`, `title`, `pinned`. |
| `log` | Runs, feelings and notes the athlete logged (from M4). |
| `history` | Dates of the last rebuild, adaptation and restoration (from M4). |
| `check` | Checksum of everything above. |

Session fields left out mean their default: `status` planned, `edits` 0, `min` and `zone` none. Once a session is edited, `authored` keeps the values it was born with, so an adaptation is always measured against the original plan.

## What is not stored

Warm-up, main set and cool-down, target paces and the coach's note for each session are **rebuilt** by the engine whenever they are read. They come from the session, its week's phase, the athlete's paces and the blueprint, with the same code that built the plan, so they are always exactly what the plan would carry. Only what cannot be rebuilt is stored: the assessment week's time trial (`seg`) and its note (`cue`).

Tests (`test/block.test.ts`) build a plan for every persona, turn it into a block, rebuild every session from the block, and require the result to equal the original.

## Size

About 110 characters per session. A 14-week half marathon plan is around 11,000 characters (about 3,000 tokens); a 27-week ultra plan around 20,000. The server refuses blocks over 200,000 characters.

## Integrity

- A block that is not complete JSON (cut off when copying) is refused with a plain sentence asking for the last block.
- A block from another version is refused with its version number.
- A block whose content no longer matches its checksum (edited by hand) is read as given, and the reply says so.
