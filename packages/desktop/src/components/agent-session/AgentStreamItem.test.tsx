import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";
import { AGENT_AUTO_COLLAPSE_DELAY_MS } from "@/lib/agent-verbosity";
import { AgentStreamItem } from "./AgentStreamItem";

const blockRenders = vi.hoisted(() => [] as Array<{ id: string; collapsed: boolean }>);

vi.mock("../AgentBlock", () => ({
  AgentBlock: ({
    block,
    isCollapsedByPolicy,
  }: {
    block: { id: string };
    isCollapsedByPolicy?: boolean;
  }) => {
    blockRenders.push({ id: block.id, collapsed: isCollapsedByPolicy === true });
    return <div>Rendered reply</div>;
  },
}));

vi.mock("./AgentStreamContextMenu", () => ({
  default: ({
    branchingEnabled,
    children,
    copyContent,
  }: {
    branchingEnabled?: boolean;
    children: ReactNode;
    copyContent?: string;
  }) => (
    <div
      data-testid="stream-context-menu"
      data-branching-enabled={String(branchingEnabled)}
      data-copy-content={copyContent}
    >
      {children}
    </div>
  ),
}));

describe("AgentStreamItem", () => {
  it("keeps rich copy around generated reply rows while hiding branch actions", () => {
    render(
      <AgentStreamItem
        block={{
          id: "reply-1",
          type: "user_message",
          content:
            '<cadencr-reply from-session="3291" from-feature="1780" status="completed" link="spawned">Visible reply body</cadencr-reply>',
          origin: {
            originKind: "session_generated",
            sourceSessionId: 3291,
            sourceFeatureId: 1780,
          },
        }}
        toolResultMap={new Map()}
      />,
    );

    const menu = screen.getByTestId("stream-context-menu");
    expect(menu).toHaveAttribute("data-copy-content", "Visible reply body");
    expect(menu).toHaveAttribute("data-branching-enabled", "false");
  });

  it("leaves an agent-sent message's name and time to its sender tab", () => {
    render(
      <AgentStreamItem
        block={{
          id: "msg-1",
          type: "user_message",
          content: "Relance les gates",
          createdAt: "2026-06-18T12:00:00Z",
          origin: { originKind: "session_generated", sourceSessionId: 3, sourceFeatureId: 17 },
        }}
        toolResultMap={new Map()}
      />,
    );

    expect(screen.queryByText("User")).toBeNull();
    expect(screen.getByText("Rendered reply")).toBeInTheDocument();
  });

  it("keeps the User line on an agent-sent gate, which renders as its own card", () => {
    render(
      <AgentStreamItem
        block={{
          id: "gate-1",
          type: "user_message",
          content:
            '<cadencr-gate from-session="7" from-feature="8" kind="question" request-id="r">{}</cadencr-gate>',
          createdAt: "2026-06-18T12:00:00Z",
          origin: { originKind: "session_generated", sourceSessionId: 7, sourceFeatureId: 8 },
        }}
        toolResultMap={new Map()}
      />,
    );

    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it("keeps User on a message the person typed", () => {
    render(
      <AgentStreamItem
        block={{
          id: "msg-2",
          type: "user_message",
          content: "hello",
          createdAt: "2026-06-18T12:00:00Z",
        }}
        toolResultMap={new Map()}
      />,
    );

    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it.each([
    { type: "text", inFlow: "pt-3 pb-3", floating: "pt-3 pb-3.5" },
    { type: "user_message", inFlow: "pt-6 pb-6", floating: "pt-6 pb-5" },
  ] as const)(
    "keeps a $type's hover actions in flow, balanced, only in compact flow",
    ({ type, inFlow, floating }) => {
      const block = { id: `row-${type}`, type, content: "hello" };
      const { container, rerender } = render(
        <AgentStreamItem block={block} toolResultMap={new Map()} verbosityMode="compact" />,
      );
      const row = () => container.querySelector(`[data-block-id="row-${type}"]`);
      expect(row()).toHaveAttribute("data-stream-actions-in-flow", "true");
      expect(row()).toHaveClass(...inFlow.split(" "));

      for (const verbosityMode of ["maximal", "auto_collapse", "collapsed"] as const) {
        rerender(
          <AgentStreamItem block={block} toolResultMap={new Map()} verbosityMode={verbosityMode} />,
        );
        expect(row()).not.toHaveAttribute("data-stream-actions-in-flow");
        expect(row()).toHaveClass(...floating.split(" "));
      }
    },
  );
});

describe("AgentStreamItem fold policy", () => {
  const bash: AgentBlockData = {
    id: "bash-1",
    type: "tool_call",
    content: "",
    toolName: "Bash",
    toolUseId: "toolu-1",
  };
  const result: AgentBlockData = {
    id: "bash-1-result",
    type: "tool_result",
    content: "ok",
    toolUseId: "toolu-1",
  };
  const finished = new Map([["toolu-1", result]]);

  beforeEach(() => {
    blockRenders.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a row folded from its first render in Collapsed mode", () => {
    render(<AgentStreamItem block={bash} toolResultMap={new Map()} verbosityMode="collapsed" />);
    expect(blockRenders[0]).toEqual({ id: "bash-1", collapsed: true });
    expect(blockRenders.every((entry) => entry.collapsed)).toBe(true);
  });

  it("renders a finished historical row folded from its first render in Auto-collapse", () => {
    render(<AgentStreamItem block={bash} toolResultMap={finished} verbosityMode="auto_collapse" />);
    expect(blockRenders[0]).toEqual({ id: "bash-1", collapsed: true });
    expect(blockRenders.every((entry) => entry.collapsed)).toBe(true);
  });

  it("keeps a row that just ran open, then folds it after the delay", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AgentStreamItem
        block={bash}
        isStreaming
        toolResultMap={new Map()}
        verbosityMode="auto_collapse"
      />,
    );
    rerender(
      <AgentStreamItem block={bash} toolResultMap={finished} verbosityMode="auto_collapse" />,
    );
    expect(blockRenders.at(-1)?.collapsed).toBe(false);
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTO_COLLAPSE_DELAY_MS);
    });
    expect(blockRenders.at(-1)?.collapsed).toBe(true);
  });

  it("never folds a row in Maximal mode", () => {
    render(<AgentStreamItem block={bash} toolResultMap={finished} verbosityMode="maximal" />);
    expect(blockRenders.every((entry) => !entry.collapsed)).toBe(true);
  });
});
