import { describe, expect, it } from "vitest";
import { composerPropsEqual } from "./composer-props-equal";
import type { AgentSessionProps } from "./types";

const onSend = (): void => {};
const onStop = (): void => {};

function session(overrides: Partial<AgentSessionProps> = {}): AgentSessionProps {
  return {
    agentType: "session",
    blocks: [],
    status: "agent",
    onSend,
    onStop,
    ...overrides,
  };
}

describe("composerPropsEqual", () => {
  const onCollapse = (): void => {};

  it("ignores transcript churn that keeps the first-prompt state", () => {
    const block = { id: "a", type: "text", content: "he" } as const;
    const prev = {
      sessionProps: session({
        blocks: [block],
        lifecycle: undefined,
        turnClock: undefined,
      }),
      onCollapse,
    };
    const delta = {
      sessionProps: session({
        blocks: [{ ...block, content: "hello" }],
        lifecycle: { phase: "active" },
        turnClock: {
          startedAtMs: 1,
          waitingMs: 0,
          waitingSinceMs: null,
          model: null,
        },
      }),
      onCollapse,
    };
    expect(composerPropsEqual(prev, delta)).toBe(true);
  });

  it("re-renders when the first prompt lands or a callback changes", () => {
    const empty = { sessionProps: session(), onCollapse };
    expect(
      composerPropsEqual(empty, {
        sessionProps: session({
          blocks: [{ id: "a", type: "text", content: "x" }],
        }),
        onCollapse,
      }),
    ).toBe(false);
    expect(
      composerPropsEqual(empty, {
        sessionProps: session(),
        onCollapse: () => {},
      }),
    ).toBe(false);
    expect(
      composerPropsEqual(empty, {
        sessionProps: session({ onStop: () => {} }),
        onCollapse,
      }),
    ).toBe(false);
    expect(
      composerPropsEqual(empty, {
        sessionProps: session({ status: "idle" }),
        onCollapse,
      }),
    ).toBe(false);
  });
});
