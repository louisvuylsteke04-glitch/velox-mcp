/**
 * Golden parity generator for adaptation: runs the ORIGINAL web-app guards
 * (lib/adapt-guards.ts), missed-session policy and restoration window on the
 * scenarios in test/golden/adapt-fixtures.ts and writes test/golden/adapt.json.
 *
 *   cd /path/to/Velox && npx tsx /path/to/velox-mcp/scripts/golden/generate-adapt.ts /path/to/Velox
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { A_PLAN_START, A_TODAY, FORWARD, GUARD_CASES, GUARD_CONFIG, POLICY_CASES, RESTORATION_CASES, RESTORATION_CONFIG, WEEK_TARGETS } from "../../test/golden/adapt-fixtures";

const VELOX = resolve(process.argv[2] ?? ".");
const lib = (p: string) => join(VELOX, "lib", p);

async function main() {
  const g = await import(lib("adapt-guards.ts"));
  const m = await import(lib("missed-session-policy.ts"));
  const guards: Record<string, unknown> = {};
  for (const c of GUARD_CASES) {
    guards[c.key] = g.applyEditGuards({
      edit: c.edit, analysis: g.parseAdaptAnalysis(c.analysis), forward: FORWARD, weekTargets: WEEK_TARGETS,
      planStart: A_PLAN_START, today: A_TODAY, config: GUARD_CONFIG, enforceCitation: true, enforceFloor: true, horizonMaxDate: c.horizon,
    });
  }
  const policy: Record<string, unknown> = {};
  for (const c of POLICY_CASES) policy[c.key] = m.decideMissedSessionAction(c.input);
  const restoration: Record<string, unknown> = {};
  for (const c of RESTORATION_CASES) restoration[c.key] = m.restorationWindowOpen(c.weeks, c.concern, RESTORATION_CONFIG);
  const net = g.netPositionLines(FORWARD);
  writeFileSync(join(resolve(__dirname, "../../test/golden"), "adapt.json"), JSON.stringify({ guards, policy, restoration, net }));
  console.log(`wrote test/golden/adapt.json (${GUARD_CASES.length} guard, ${POLICY_CASES.length} policy, ${RESTORATION_CASES.length} restoration cases)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
