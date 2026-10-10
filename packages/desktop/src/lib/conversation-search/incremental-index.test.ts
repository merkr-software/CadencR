// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { ConversationSearchIndex } from "./incremental-index";

function block(id: string, content: string): AgentBlockData {
  return { id, type: "text", content };
}

function row(value: AgentBlockData): DisplayItem {
  return { kind: "block", key: value.id, block: value };
}

describe("ConversationSearchIndex", () => {
  it("resolves compact per-block counts to document-ordered match offsets", () => {
    const first = block("first", "fox fox");
    const second = block("second", "fox");
    const flow: DisplayItem = { kind: "flow", key: "flow:first", blocks: [first, second] };
    const last = block("last", "fox fox fox");

    const snapshot = new ConversationSearchIndex().update([flow, row(last)], "FOX");

    expect(snapshot.matchCount).toBe(6);
    expect(snapshot.matchAt(0)).toEqual({ blockId: "first", rowIndex: 0, occurrenceInBlock: 0 });
    expect(snapshot.matchAt(2)).toEqual({ blockId: "second", rowIndex: 0, occurrenceInBlock: 0 });
    expect(snapshot.matchAt(5)).toEqual({ blockId: "last", rowIndex: 1, occurrenceInBlock: 2 });
    expect(snapshot.matchAt(6)).toBeNull();
  });

  it("preserves a match identity through prepend and reorder", () => {
    const first = block("first", "needle");
    const active = block("active", "needle needle");
    const index = new ConversationSearchIndex();
    const initial = index.update([row(first), row(active)], "needle");
    const identity = initial.identityAt(2);
    expect(identity).not.toBeNull();

    const prepended = block("prepended", "needle");
    const moved = index.update([row(active), row(prepended), row(first)], "needle");

    expect(identity && moved.ordinalOf(identity)).toBe(1);
    expect(moved.matchAt(1)).toEqual({
      blockId: "active",
      rowIndex: 0,
      occurrenceInBlock: 1,
    });
  });

  it("scans only appended blocks and drops deleted blocks without rescanning survivors", () => {
    let scans = 0;
    const index = new ConversationSearchIndex({ onBlockScan: () => (scans += 1) });
    const first = block("first", "needle");
    const survivor = block("survivor", "needle");
    expect(index.update([row(first), row(survivor)], " needle ").matchCount).toBe(2);
    expect(scans).toBe(2);

    const appended = block("appended", "needle");
    expect(index.update([row(first), row(survivor), row(appended)], "NEEDLE").matchCount).toBe(3);
    expect(scans).toBe(3);

    expect(index.update([row(appended), row(survivor)], "needle").matchCount).toBe(2);
    expect(scans).toBe(3);
  });

  it("rescans canonical replacements and retains logical identity by block id", () => {
    let scans = 0;
    const index = new ConversationSearchIndex({ onBlockScan: () => (scans += 1) });
    const original = block("canonical", "needle needle");
    const initial = index.update([row(original)], "needle");
    const identity = initial.identityAt(1);
    const replacement = block("canonical", "needle needle needle");

    const replaced = index.update([row(replacement)], "needle");

    expect(scans).toBe(2);
    expect(replaced.matchCount).toBe(3);
    expect(identity && replaced.ordinalOf(identity)).toBe(1);
  });

  it("uses the display-row identity when duplicate block ids are replaced", () => {
    const first = block("duplicate", "needle");
    const active = block("duplicate", "needle");
    const index = new ConversationSearchIndex();
    const initial = index.update(
      [
        { kind: "block", key: "duplicate", block: first },
        { kind: "block", key: "duplicate#1", block: active },
      ],
      "needle",
    );
    const identity = initial.identityAt(1);
    const replacement = block("duplicate", "needle");

    const replaced = index.update(
      [
        { kind: "block", key: "duplicate", block: first },
        { kind: "block", key: "duplicate#1", block: replacement },
      ],
      "needle",
    );

    expect(identity && replaced.ordinalOf(identity)).toBe(1);
  });

  it("invalidates only a Bash call whose paired result changes", () => {
    let scans = 0;
    const index = new ConversationSearchIndex({ onBlockScan: () => (scans += 1) });
    const bash: AgentBlockData = {
      id: "bash",
      type: "tool_call",
      content: "",
      toolName: "Bash",
      toolUseId: "tool-use",
      toolArgs: '{"command":"run"}',
    };
    const prose = block("prose", "needle");
    const firstResult: AgentBlockData = {
      id: "result-1",
      type: "tool_result",
      content: '{"output":"needle"}',
    };
    const firstMap = new Map([["tool-use", firstResult]]);
    expect(index.update([row(bash), row(prose)], "needle", firstMap).matchCount).toBe(2);
    expect(scans).toBe(2);

    const irrelevantMapCopy = new Map(firstMap);
    index.update([row(bash), row(prose)], "needle", irrelevantMapCopy);
    expect(scans).toBe(2);

    const equivalentResultMap = new Map([["tool-use", { ...firstResult }]]);
    index.update([row(bash), row(prose)], "needle", equivalentResultMap);
    expect(scans).toBe(2);

    const changedResult = { ...firstResult, id: "result-2", content: '{"output":"none"}' };
    const changedMap = new Map([["tool-use", changedResult]]);
    expect(index.update([row(bash), row(prose)], "needle", changedMap).matchCount).toBe(1);
    expect(scans).toBe(3);
  });

  it("rescans only one dirty tail block in a 6,000-block, 120,000-match transcript", () => {
    let scans = 0;
    const index = new ConversationSearchIndex({ onBlockScan: () => (scans += 1) });
    const content = `${"needle ".repeat(20)}`;
    const blocks = Array.from({ length: 6_000 }, (_, number) => block(String(number), content));
    const initial = index.update(blocks.map(row), "needle");
    expect(initial.matchCount).toBe(120_000);
    expect(scans).toBe(6_000);

    const nextBlocks = blocks.slice();
    nextBlocks[nextBlocks.length - 1] = block("5999", `${content}needle`);
    const updated = index.update(nextBlocks.map(row), "needle");

    expect(updated.matchCount).toBe(120_001);
    expect(updated.matchAt(120_000)).toEqual({
      blockId: "5999",
      rowIndex: 5_999,
      occurrenceInBlock: 20,
    });
    expect(scans).toBe(6_001);
  });

  it("keeps independent query caches per index instance", () => {
    let firstScans = 0;
    let secondScans = 0;
    const shared = block("same-id", "alpha beta");
    const first = new ConversationSearchIndex({ onBlockScan: () => (firstScans += 1) });
    const second = new ConversationSearchIndex({ onBlockScan: () => (secondScans += 1) });

    expect(first.update([row(shared)], "alpha").matchCount).toBe(1);
    expect(second.update([row(shared)], "beta").matchCount).toBe(1);
    expect(first.update([row(shared)], "alpha").matchCount).toBe(1);
    expect({ firstScans, secondScans }).toEqual({ firstScans: 1, secondScans: 1 });
  });

  it("releases cached search state when cleared", () => {
    let scans = 0;
    const index = new ConversationSearchIndex({ onBlockScan: () => (scans += 1) });
    const shared = block("shared", "needle");
    index.update([row(shared)], "needle");
    index.clear();
    index.update([row(shared)], "needle");
    expect(scans).toBe(2);
  });
});
