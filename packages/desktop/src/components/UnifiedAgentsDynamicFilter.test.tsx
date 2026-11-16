// @vitest-environment jsdom
// Pinned to jsdom: suggestions open from focus/caret state, which happy-dom does not reproduce.
import { createRef, useState, type ReactElement, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/api/generated";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import {
  UnifiedAgentsDynamicFilter,
  type UnifiedAgentsFilterInputHandle,
} from "@/components/UnifiedAgentsDynamicFilter";

vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: ({ projectId, className }: { projectId: number; className?: string }) => (
    <span className={className} data-testid={`project-color-dot-${projectId}`} />
  ),
}));

const PROJECTS: Project[] = [
  { created_at: "2026-01-01 00:00:00", id: 1, name: "Core App", path: "/repo/core" },
  { created_at: "2026-01-01 00:00:00", id: 2, name: "Agent Lab", path: "/repo/agent-lab" },
];

describe("UnifiedAgentsDynamicFilter", () => {
  it("focuses the first matching agent on Enter when no suggestion is available", () => {
    const onValueChange = vi.fn();
    const onEnter = vi.fn();

    render(
      <UnifiedAgentsDynamicFilter
        value="agent name"
        projects={[]}
        onValueChange={onValueChange}
        onEnter={onEnter}
      />,
    );

    const textbox = screen.getByRole("textbox");
    textbox.focus();
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("agent name");
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(textbox);
    expect(textbox).toHaveTextContent("agent name");
  });

  it("renders project suggestions with their color dot", async () => {
    const inputRef = createRef<UnifiedAgentsFilterInputHandle>();

    render(
      <UnifiedAgentsDynamicFilter
        value="/project:agent"
        projects={PROJECTS}
        inputRef={inputRef}
        onValueChange={vi.fn()}
      />,
    );

    await focusFilter(inputRef);
    const suggestion = await screen.findByText("Agent Lab");

    expect(
      suggestion.closest("button")?.querySelector('[data-testid="project-color-dot-2"]'),
    ).not.toBeNull();
  });

  it("does not style the plain space inserted after a filter token", async () => {
    const inputRef = createRef<UnifiedAgentsFilterInputHandle>();

    render(
      <UnifiedAgentsDynamicFilter
        value="/sort:message"
        projects={PROJECTS}
        inputRef={inputRef}
        onValueChange={vi.fn()}
      />,
    );

    await focusFilter(inputRef);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: " " });

    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe("/sort:message "));
    const textSpans = Array.from(
      screen.getByRole("textbox").querySelectorAll("[data-lexical-text]"),
    );
    const spaceSpan = textSpans.find((span: Element): boolean => span.textContent === " ");

    expect(spaceSpan?.parentElement?.getAttribute("style") ?? "").not.toContain(
      "--unified-agents-filter-token",
    );
  });

  it("focuses the filter editor when the surrounding filter bar is clicked", async () => {
    render(<UnifiedAgentsDynamicFilter value="agent" projects={[]} onValueChange={vi.fn()} />);

    const textbox = screen.getByRole("textbox");
    const shell = textbox.parentElement;
    expect(shell).not.toBeNull();

    fireEvent.mouseDown(shell!);

    await waitFor(() => expect(document.activeElement).toBe(textbox));
  });

  it("marks the filter bar as a no-drag island inside the titlebar", () => {
    render(<UnifiedAgentsDynamicFilter value="" projects={[]} onValueChange={vi.fn()} />);

    expect(screen.getByRole("textbox").parentElement).toHaveClass("titlebar-no-drag");
  });

  it("does not refocus the editor when Enter commits to normalized filter text", async () => {
    render(<NormalizingFilterHarness />);

    const textbox = screen.getByRole("textbox");
    textbox.focus();
    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => expect(textbox).toHaveTextContent("/last:5 /sort:created"));
    expect(document.activeElement).not.toBe(textbox);
  });
});

async function focusFilter(
  inputRef: RefObject<UnifiedAgentsFilterInputHandle | null>,
): Promise<void> {
  await act(async () => {
    inputRef.current?.focus();
  });
}

function NormalizingFilterHarness(): ReactElement {
  const [value, setValue] = useState("");
  return (
    <UnifiedAgentsDynamicFilter
      value={value}
      projects={[]}
      onValueChange={() => setValue("/last:5 /sort:created")}
      onEnter={vi.fn()}
    />
  );
}
