import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { withoutBrief } from "./side-conversation-blocks";

const block = (id: string, type: AgentBlockData["type"], generated = false): AgentBlockData => ({
  id,
  type,
  content: id,
  origin: generated ? { originKind: "session_generated" } : null,
});

describe("withoutBrief", () => {
  it("drops the service-written brief and keeps the rest", () => {
    const blocks = [block("brief", "user_message", true), block("answer", "text")];
    expect(withoutBrief(blocks).map((entry) => entry.id)).toEqual(["answer"]);
  });

  it("keeps a prompt the person wrote", () => {
    const blocks = [block("prompt", "user_message"), block("answer", "text")];
    expect(withoutBrief(blocks)).toBe(blocks);
  });
});
