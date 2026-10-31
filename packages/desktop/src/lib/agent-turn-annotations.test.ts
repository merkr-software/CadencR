import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import {
  buildRowAnnotations,
  reuseRowAnnotations,
  type TurnFooter,
} from "./agent-turn-annotations";

function buildTurnFooters(items: DisplayItem[], turnActive: boolean): Map<string, TurnFooter> {
  const footers = new Map<string, TurnFooter>();
  for (const [key, annotation] of buildRowAnnotations(items, turnActive)) {
    if (annotation.footer) footers.set(key, annotation.footer);
  }
  return footers;
}

function block(id: string, type: AgentBlockData["type"], extra: Partial<AgentBlockData> = {}) {
  return { id, type, content: id, ...extra } satisfies AgentBlockData;
}

function rows(...blocks: AgentBlockData[]): DisplayItem[] {
  return blocks.map((b) => ({ kind: "block", key: b.id, block: b }));
}

const prompt = (id: string) => block(id, "user_message", { createdAt: `${id}-at` });
const reply = (id: string, model: string) => block(id, "text", { model, createdAt: `${id}-at` });

describe("buildTurnFooters", () => {
  it("puts one footer on each finished turn's last row", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("tool1", "tool_call", { createdAt: "tool1-at" }),
      reply("t2", "opus"),
      prompt("u2"),
      reply("t3", "opus"),
    );

    const footers = buildTurnFooters(items, false);

    expect([...footers.keys()]).toEqual(["t2", "t3"]);
    expect(footers.get("t2")).toEqual({ models: ["opus"], endedAt: "t2-at" });
  });

  it("leaves the turn still in flight without a footer", () => {
    const items = rows(prompt("u1"), reply("t1", "opus"), prompt("u2"), reply("t2", "opus"));

    expect([...buildTurnFooters(items, true).keys()]).toEqual(["t1"]);
  });

  it("joins the live turn summary when the turn ends on it", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("summary", "turn_summary", { createdAt: "summary-at" }),
    );

    expect(buildTurnFooters(items, false).get("summary")).toEqual({
      models: ["opus"],
      endedAt: "summary-at",
    });
  });

  it("lists the models a turn ran on in the order they wrote", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      reply("t2", "sonnet"),
      reply("t3", "opus"),
    );

    expect(buildTurnFooters(items, false).get("t3")?.models).toEqual(["opus", "sonnet", "opus"]);
  });

  it("keeps a steer awaiting the agent's receipt inside the running turn", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("steer", "user_message", { promptDeliveryState: "pending_agent" }),
      reply("t2", "opus"),
    );

    expect([...buildTurnFooters(items, false).keys()]).toEqual(["t2"]);
  });

  it("keeps a finished turn's line while another agent's message awaits receipt", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("summary", "turn_summary"),
      block("sent", "user_message", { promptDeliveryState: "pending_agent" }),
    );

    // The pending message makes the session busy without opening a turn.
    expect([...buildTurnFooters(items, true).keys()]).toEqual(["summary"]);
  });

  it("keeps a turn open past an error it runs on from", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("lost", "error", { content: "Connection lost while streaming. Reconnecting…" }),
    );

    expect(buildTurnFooters(items, true).size).toBe(0);
  });

  it("closes the exchange before a steer the agent received", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("steer", "user_message", { promptDeliveryState: "received_agent" }),
      reply("t2", "opus"),
    );

    expect([...buildTurnFooters(items, true).keys()]).toEqual(["t1"]);
  });

  it("reads the models of prose summary mode folded into a recap", () => {
    const recap = block("recap", "tool_summary", { childBlocks: [reply("t1", "gpt")] });
    const items = rows(prompt("u1"), recap, reply("t2", "gpt"));

    expect(buildTurnFooters(items, false).get("t2")?.models).toEqual(["gpt"]);
  });

  it("ends a compact-flow turn on its folded run", () => {
    const items: DisplayItem[] = [
      ...rows(prompt("u1"), reply("t1", "opus")),
      { kind: "flow", key: "flow:tool1", blocks: [block("tool1", "tool_call")] },
    ];

    expect([...buildTurnFooters(items, false).keys()]).toEqual(["flow:tool1"]);
  });

  it("skips a turn with no attributed prose", () => {
    const items = rows(prompt("u1"), block("tool1", "tool_call"), reply("t1", ""));

    expect(buildTurnFooters(items, false).size).toBe(0);
  });
});

describe("buildRowAnnotations model switches", () => {
  function switches(items: DisplayItem[]) {
    const out: Record<string, unknown> = {};
    for (const [key, annotation] of buildRowAnnotations(items, false)) {
      if (annotation.modelSwitch) out[key] = annotation.modelSwitch;
    }
    return out;
  }

  it("marks nothing while the model holds", () => {
    expect(
      switches(rows(prompt("u1"), reply("t1", "opus"), prompt("u2"), reply("t2", "opus"))),
    ).toEqual({});
  });

  it("opens the turn a switch took effect in (applied at the next turn)", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "gpt-a"),
      prompt("u2"),
      block("think", "thinking"),
      reply("t2", "gpt-b"),
    );

    expect(switches(items)).toEqual({ think: { from: "gpt-a", to: "gpt-b" } });
  });

  it("marks the first reply the new model wrote when it switched mid-turn", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      block("tool1", "tool_call"),
      reply("t2", "sonnet"),
    );

    expect(switches(items)).toEqual({ t2: { from: "opus", to: "sonnet" } });
  });

  it("opens a compact-flow turn on its folded run", () => {
    const items: DisplayItem[] = [
      ...rows(prompt("u1"), reply("t1", "opus"), prompt("u2")),
      { kind: "flow", key: "flow:tool1", blocks: [block("tool1", "tool_call")] },
      ...rows(reply("t2", "sonnet")),
    ];

    expect(switches(items)).toEqual({ "flow:tool1": { from: "opus", to: "sonnet" } });
  });

  it("carries the switch across turns without prose", () => {
    const items = rows(
      prompt("u1"),
      reply("t1", "opus"),
      prompt("u2"),
      block("tool1", "tool_call"),
      prompt("u3"),
      reply("t3", "sonnet"),
    );

    expect(switches(items)).toEqual({ t3: { from: "opus", to: "sonnet" } });
  });

  it("drops a switch summary mode folded together with its way back", () => {
    const recap = block("recap", "tool_summary", {
      childBlocks: [reply("c1", "sonnet"), reply("c2", "opus")],
    });
    const items = rows(prompt("u1"), reply("t1", "opus"), prompt("u2"), recap);

    expect(switches(items)).toEqual({});
  });

  it("starts from the first attributed model, never before it", () => {
    expect(switches(rows(prompt("u1"), reply("t1", ""), reply("t2", "opus")))).toEqual({});
  });
});

describe("reuseRowAnnotations", () => {
  it("returns the previous map when no footer changed", () => {
    const items = rows(prompt("u1"), reply("t1", "opus"));
    const previous = buildRowAnnotations(items, false);

    expect(reuseRowAnnotations(previous, buildRowAnnotations(items, false))).toBe(previous);
  });

  it("keeps unchanged footers by identity when another one changes", () => {
    const first = rows(prompt("u1"), reply("t1", "opus"), prompt("u2"));
    const previous = buildRowAnnotations(first, true);
    const next = reuseRowAnnotations(
      previous,
      buildRowAnnotations([...first, ...rows(reply("t2", "opus"))], false),
    );

    expect(next).not.toBe(previous);
    expect(next.get("t1")).toBe(previous.get("t1"));
    expect(next.get("t2")?.footer?.models).toEqual(["opus"]);
  });
});
