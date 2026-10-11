# Engine findings inherited from the web app

The port reproduces the Vēlox web app's plan engine exactly (see `test/plan-parity.test.ts`). While building the parity tests, these behaviours of the **original engine** showed up. They are kept as they are, because changing coaching is a deliberate decision, not a side effect of a port. Each needs a call from Louis. They are live in the web app too.

## 1. Low-volume runners get about one run a week

**Seen in:** `beginner_10k` (12 km/week, 4 days available) and `no_history_5k` (15 km/week stated, no history).

The envelope asks for 3 to 6 runs a week, but the scheduler stops adding runs once another would fall under the 5 km minimum session length (`min_session_km`). What is left is one long run of about 5 km a week, under half the weekly target, and no quality work in the build phase.

**Possible fix:** lower the minimum for low-volume weeks (for example 3 km when the weekly target is under 20 km), or split the target over fewer, longer days instead of dropping volume.

## 2. Race week holds only the race

**Seen in:** every plan with a race.

Expansion leaves the final week empty, then race-day pinning adds the race. There are no shakeout or easy runs in the days before it. The invariants flag it before pinning ("week N has no sessions"), which the web app logged and ignored.

**Possible fix:** let expansion schedule race week's easy volume, then pin the race into it.

## 3. The long run can be half the week in week 1

**Seen in:** a real 16-week history (42 km/week, longest run 22.8 km). Week 1 put 21.8 of 42.9 km in the long run.

The long-run cap follows the longest recent run, while the week's volume follows the recent average, so an athlete with one big run in their history starts with a very long-run-heavy week.

**Possible fix:** cap the long run at a share of the week (30 to 35% is common) as well as at the recent longest run.
