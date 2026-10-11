import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { validateEdit } from "../engine/adapt/validate";
import { applyEditGuards, parseAdaptAnalysis, DEFAULT_GUARD_CONFIG } from "../engine/adapt/guards";
import { addDaysYMD } from "../engine/dates";
import { applyEdit, forwardSessions, weekTargets } from "../block/adapt";
import { Today } from "./common";
import { EDITED_NOTE, PlanBlockText, blockContent, errorResult, readBlock } from "./plan-common";
import { TRIGGERS } from "./adapt-common";

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SessionId = z.string().max(20).describe("A session id from the plan (its date, e.g. 2026-10-28).");
const Type = z.enum(["easy", "long_run", "tempo", "interval", "threshold", "recovery", "rest"]);
const Zone = z.enum(["zone1", "zone2", "zone3", "zone4", "zone5", "race_pace"]);

const Input = z.object({
  today: Today,
  plan_block: PlanBlockText,
  trigger: z.enum(TRIGGERS).describe("What prompted this change. missed_session edits may only reach 21 days ahead."),
  reasoning: z.string().max(600).describe("2-4 sentences to the athlete, in the coach's voice: what changed and why. No em-dashes, no exclamation marks."),
  analysis: z.object({
    event: z.string().max(1500),
    net_position_reviewed: z.array(z.object({
      id: SessionId,
      authored_km: z.number().nullable(), current_km: z.number().nullable(),
      authored_min: z.number().nullable().optional(), current_min: z.number().nullable().optional(),
      times_edited: z.number().int().nullable(),
      verdict: z.string().max(400),
      new_signal: z.enum(["injury", "illness", "structural_absence"]).nullable().optional(),
    })).max(60),
    decision: z.string().max(1500),
  }).describe("Your deliberation, per the adaptation rules: every session you update, move or delete must be cited here with the NET POSITION values."),
  updates: z.array(z.object({
    id: SessionId,
    workout_type: Type.optional(),
    km: z.number().min(0).max(100).nullish(),
    min: z.number().int().min(10).max(480).nullish(),
    zone: Zone.optional(),
  })).max(40).default([]),
  moves: z.array(z.object({ id: SessionId, to_date: YMD })).max(20).default([]),
  inserts: z.array(z.object({
    date: YMD, workout_type: Type.default("easy"), km: z.number().min(0).max(100).nullish(), min: z.number().int().min(10).max(480).nullish(), zone: Zone.nullish(),
  })).max(10).default([]),
  deletes: z.array(SessionId).max(20).default([]),
  dry_run: z.boolean().default(false).describe("Check the edits against the rules without changing the plan."),
});

export function registerAdaptPlan(server: McpServer): void {
  server.registerTool(
    "velox_adapt_plan",
    {
      title: "Adapt the plan",
      description: [
        "Applies the coach's changes to upcoming sessions, after the same checks the Vēlox web app ran on its own coach: pinned sessions and the race are untouchable; no session may become another sport or a race; one run per day; every edited session must be cited in analysis with its NET POSITION values; a session already edited twice or cut more than 25% below its original is not cut again without a named new signal (injury, illness, structural_absence); a not-yet-started week must stay between 70% (unless injury or illness) and 115% of its target km; missed-session edits reach at most 21 days ahead.",
        "Items that break a rule are rejected with the reason; a week-envelope breach rejects the whole set. Get the NET POSITION table from velox_log_run or velox_review_week first. Returns the new block to save.",
      ].join(" "),
      inputSchema: Input,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (input) => {
      const read = readBlock(input.plan_block);
      if ("error" in read) return read.error;
      const { block } = read;
      const { today } = input;
      const { snapshots, idOf, numOf } = forwardSessions(block, today);
      if (!snapshots.length) return errorResult("There are no upcoming planned sessions to adapt.");

      const unknown: string[] = [];
      const n = (id: string): number => {
        const v = numOf.get(id);
        if (v == null) { unknown.push(id); return -1; }
        return v;
      };
      const raw = {
        updates: input.updates.map((u) => ({
          id: n(u.id),
          fields: {
            ...(u.workout_type ? { workout_type: u.workout_type } : {}),
            ...(u.km != null ? { target_distance_km: u.km } : {}),
            ...(u.min != null ? { target_duration_min: u.min } : {}),
            ...(u.zone ? { target_pace_zone: u.zone } : {}),
          },
        })),
        moves: input.moves.map((m) => ({ id: n(m.id), toDate: m.to_date })),
        inserts: input.inserts.map((i) => ({ date: i.date, workout_type: i.workout_type, sport: "run", target_distance_km: i.km ?? null, target_duration_min: i.min ?? null, target_pace_zone: i.zone ?? null })),
        deletes: input.deletes.map(n),
      };
      const { edit: validated, dropped } = validateEdit(raw, snapshots);
      const analysis = parseAdaptAnalysis({
        ...input.analysis,
        net_position_reviewed: input.analysis.net_position_reviewed
          .filter((e) => numOf.has(e.id))
          .map((e) => ({ ...e, id: numOf.get(e.id) })),
      });
      const horizon = input.trigger === "missed_session" ? addDaysYMD(today, DEFAULT_GUARD_CONFIG.horizonDays) : null;
      const { edit, rejections } = applyEditGuards({
        edit: validated, analysis, forward: snapshots, weekTargets: weekTargets(block), planStart: block.plan.start, today,
        config: DEFAULT_GUARD_CONFIG, enforceCitation: true, enforceFloor: true, horizonMaxDate: horizon,
      });

      const sid = (s: string) => s.replace(/id=(\d+)/g, (_m, x: string) => `id=${idOf.get(Number(x)) ?? x}`);
      const problems = [
        ...[...new Set(unknown)].map((id) => `${id}: not an upcoming planned session`),
        ...dropped.filter((d) => d.ref !== "-1").map((d) => `${d.kind} ${idOf.get(Number(d.ref)) ?? d.ref}: ${d.reason}`),
        ...rejections.map((r) => sid(r.reason)),
      ];
      const accepted = edit.updates.length + edit.moves.length + edit.inserts.length + edit.deletes.length;

      const lines: string[] = [];
      if (read.edited) lines.push(EDITED_NOTE);
      if (problems.length) lines.push(`Not accepted:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      if (!accepted) {
        lines.push(input.dry_run ? "Dry run: nothing would change." : "Nothing changed. The plan block is unchanged, so there is nothing new to save.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: { applied: false, dry_run: input.dry_run, accepted: 0, problems } };
      }
      if (input.dry_run) {
        lines.push(`Dry run: ${accepted} change${accepted === 1 ? "" : "s"} would be applied. Call again without dry_run to apply.`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: { applied: false, dry_run: true, accepted, problems } };
      }
      const { block: next, changes } = applyEdit(block, edit, idOf, { today, trigger: input.trigger });
      lines.push(`Applied ${changes.length} change${changes.length === 1 ? "" : "s"}:`);
      for (const c of changes) lines.push(`- ${c.id}: ${c.change}`);
      lines.push(`For the athlete: ${input.reasoning}`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }, blockContent(next)],
        structuredContent: { applied: true, dry_run: false, accepted, changes, problems, reasoning: input.reasoning },
      };
    },
  );
}
