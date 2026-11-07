import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentStreamItem } from "./AgentStreamItem";

vi.mock("../AgentBlock", () => ({
  AgentBlock: () => <div>Rendered reply</div>,
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
