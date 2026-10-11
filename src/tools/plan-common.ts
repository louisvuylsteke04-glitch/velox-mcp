import { z } from "zod";
import { decodeBlock, encodeBlock, MAX_BLOCK_CHARS } from "../block/codec";
import type { PlanBlock } from "../block/schema";

export const PlanBlockText = z
  .string()
  .max(MAX_BLOCK_CHARS)
  .describe("The athlete's current Vēlox plan block, exactly as Vēlox last returned it (the JSON saved in their Claude Project).");

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Parse the block or produce the plain-sentence error result to return. */
export function readBlock(text: string): { block: PlanBlock; edited: boolean } | { error: ReturnType<typeof errorResult> } {
  const r = decodeBlock(text);
  if (!r.ok) return { error: errorResult(r.error) };
  return { block: r.block, edited: r.edited };
}

export const EDITED_NOTE = "Note: this plan block was changed by hand since Vēlox last returned it. It was read as given.";

/** The block as the last content item, with the instruction to save it. */
export function blockContent(block: PlanBlock) {
  return {
    type: "text" as const,
    text: `PLAN BLOCK. Save this in the athlete's Claude Project exactly as is, replacing the previous one, and pass it to Vēlox next time:\n\`\`\`json\n${encodeBlock(block)}\n\`\`\``,
  };
}
