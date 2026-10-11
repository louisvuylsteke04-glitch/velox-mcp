import { describe, expect, it } from "vitest";
import { rpc } from "./helpers";
import { PROMPT_NAMES, RESOURCE_URIS } from "@/src/coach";

const BANNED = /revolutionary|game-changing|powerful|amazing|best in class|cutting-edge|seamless|robust/i;

describe("coaching layer", () => {
  it("sends the workflow and safety rules as server instructions", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const ins = body.result.instructions as string;
    expect(ins).toContain("velox_build_plan");
    expect(ins).toContain("velox-plan.json");
    expect(ins).toMatch(/never diagnose/i);
  });

  it("lists the four workflows as prompts", async () => {
    const { body } = await rpc("prompts/list");
    expect(body.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
  });

  it.each(PROMPT_NAMES)("%s returns its workflow with today's date", async (name) => {
    const { body } = await rpc("prompts/get", { name, arguments: { today: "2026-10-11" } });
    const text = body.result.messages[0].content.text as string;
    expect(text.startsWith("Today is 2026-10-11.")).toBe(true);
    expect(text).toMatch(/velox_/);
  });

  it("lists and reads every resource", async () => {
    const { body } = await rpc("resources/list");
    expect(body.result.resources.map((r: { uri: string }) => r.uri).sort()).toEqual([...RESOURCE_URIS].sort());
    for (const uri of RESOURCE_URIS) {
      const read = await rpc("resources/read", { uri });
      expect(read.body.result.contents[0].text.length).toBeGreaterThan(200);
    }
  });

  it("keeps every text the athlete or Claude reads in the house voice", async () => {
    const texts: string[] = [];
    const ins = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    texts.push(ins.body.result.instructions);
    for (const name of PROMPT_NAMES) texts.push((await rpc("prompts/get", { name, arguments: {} })).body.result.messages[0].content.text);
    for (const uri of RESOURCE_URIS) texts.push((await rpc("resources/read", { uri })).body.result.contents[0].text);
    for (const t of (await rpc("tools/list")).body.result.tools) texts.push(t.description);
    for (const t of texts) {
      expect(t).not.toMatch(/—/);
      expect(t.replace(/!==|!=|\(!/g, "")).not.toMatch(/!/);
      // The method names the banned words in order to ban them; skip that one line.
      expect(t.replace(/Never use: [^\n]*/g, "")).not.toMatch(BANNED);
    }
  });
});
