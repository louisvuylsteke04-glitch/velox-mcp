/**
 * Plan block text format: compact JSON. Whitespace does not matter (the block
 * is parsed and re-serialised), so a block reformatted by an editor still
 * checks out. A changed value does not, and is reported.
 */
import { PlanBlockV1, BLOCK_VERSION, type PlanBlock } from "./schema";

/** Hard cap on a block's size, so an oversized payload is refused. */
export const MAX_BLOCK_CHARS = 200_000;

/** 32-bit FNV-1a, hex. Not security: only notices a truncated or edited block. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON with object keys sorted, so key order never changes the checksum. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function checksumOf(block: Omit<PlanBlock, "check"> | PlanBlock): string {
  const { check: _ignored, ...rest } = block as PlanBlock;
  void _ignored;
  return fnv1a(canonical(rest));
}

/** Fill every default, so the checksum is the same for a compact and a full block. */
function normalise(block: Omit<PlanBlock, "check">): PlanBlock {
  return PlanBlockV1.parse({ ...block, check: "" });
}

export function sealBlock(block: Omit<PlanBlock, "check">): PlanBlock {
  const full = normalise(block);
  return { ...full, check: checksumOf(full) };
}

/** Compact text: fields at their defaults are left out. */
export function encodeBlock(block: PlanBlock): string {
  return JSON.stringify({
    ...block,
    sessions: block.sessions.map((s) => {
      const out: Record<string, unknown> = { ...s };
      if (s.min == null) delete out.min;
      if (s.zone == null) delete out.zone;
      if (s.status === "planned") delete out.status;
      if (s.edits === 0) delete out.edits;
      return out;
    }),
  });
}

export type DecodeResult =
  | { ok: true; block: PlanBlock; edited: boolean }
  | { ok: false; error: string };

export function decodeBlock(text: string): DecodeResult {
  if (text.length > MAX_BLOCK_CHARS) return { ok: false, error: "This plan block is too large. Paste the block exactly as Vēlox last returned it." };
  let raw: unknown;
  try {
    const t = text.trim().replace(/^```(?:json|velox)?\s*/i, "").replace(/\s*```$/, "");
    raw = JSON.parse(t);
  } catch {
    return { ok: false, error: "This plan block is not complete JSON. It may have been cut off. Paste the full block Vēlox last returned." };
  }
  if (raw && typeof raw === "object" && "velox" in raw && (raw as { velox: unknown }).velox !== BLOCK_VERSION) {
    return { ok: false, error: `This plan block is version ${String((raw as { velox: unknown }).velox)}, and this server reads version ${BLOCK_VERSION}.` };
  }
  const parsed = PlanBlockV1.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `This plan block does not read as a Vēlox plan (${first?.path.join(".") || "root"}: ${first?.message ?? "invalid"}). Paste the block Vēlox last returned.` };
  }
  return { ok: true, block: parsed.data, edited: checksumOf(parsed.data) !== parsed.data.check };
}
