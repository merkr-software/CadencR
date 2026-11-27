// @vitest-environment jsdom
// Pinned to jsdom: suggestions open from focus/caret state, which happy-dom does not reproduce.
import { createRef, useState, type ReactElement, type RefObject } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
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
  {
    created_at: "2026-01-01 00:00:00",
    id: 1,
    name: "Core App",
    path: "/repo/core",
    path_missing: false,
  },
  {
    created_at: "2026-01-01 00:00:00",
    id: 2,
    name: "Agent Lab",
    path: "/repo/agent-lab",
    path_missing: false,
  },
];

beforeAll(() => {
  // Lexical measures the selection even though jsdom has no caret geometry.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

afterEach(async () => {
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
  uiI18n.removeResourceBundle("fr", "ui");
});

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

  it("translates the open suggestions without losing focus, selection, or filter syntax", async () => {
    const inputRef = createRef<UnifiedAgentsFilterInputHandle>();
    const onValueChange = vi.fn();

    render(
      <UnifiedAgentsDynamicFilter
        value="Auth bug /sort:-"
        projects={PROJECTS}
        inputRef={inputRef}
        onValueChange={onValueChange}
      />,
    );

    await focusFilter(inputRef);
    const textbox = screen.getByRole("textbox", { name: "Filter agents" });
    const message = (await screen.findByText("/sort:-message")).closest("button");
    expect(message).toHaveTextContent("Ascending order");
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(message).toHaveAttribute("data-selected", "true");

    uiI18n.addResourceBundle("fr", "ui", {
      agents: {
        filter: { suggestions: { ascending: "Ordre croissant" } },
        unifiedAgentsFilterEditorShell: { filterAgents: "Filtrer les agents" },
      },
    });
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });

    expect(screen.getByRole("textbox", { name: "Filtrer les agents" })).toBe(textbox);
    expect(document.activeElement).toBe(textbox);
    expect(textbox.textContent).toBe("Auth bug /sort:-");
    expect(screen.getByText("/sort:-message").closest("button")).toBe(message);
    expect(message).toHaveTextContent("Ordre croissant");
    expect(message).toHaveAttribute("data-selected", "true");
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(textbox.textContent).toBe("Auth bug /sort:-message "));
  });

  it("translates open filter help and preserves literal syntax and project names", async () => {
    render(<UnifiedAgentsDynamicFilter value="" projects={PROJECTS} onValueChange={vi.fn()} />);

    expect(screen.getByText("for project, time, sort…", { exact: false })).toHaveTextContent("/");
    fireEvent.click(screen.getByRole("button", { name: "Explain agent filter language" }));
    const dialog = await screen.findByRole("dialog", { name: "Agent filter language" });
    expect(screen.getByText("/key:value")).toBeVisible();
    expect(screen.getByText('/last:5 /sort:created /project:"Core App"')).toBeVisible();

    uiI18n.addResourceBundle("fr", "ui", {
      agents: {
        filter: { help: { description: "Tapez <syntax/> pour filtrer." } },
        unifiedAgentsFilterHelpDialog: { agentFilterLanguage: "Filtres des agents" },
      },
    });
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });

    expect(screen.getByRole("dialog", { name: "Filtres des agents" })).toBe(dialog);
    expect(dialog).toHaveTextContent("Tapez /key:value pour filtrer.");
    expect(screen.getByText('/last:5 /sort:created /project:"Core App"')).toBeVisible();
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
  await act(async () => {
    const textbox = screen.getByRole("textbox");
    const text = textbox.querySelector("[data-lexical-text]:last-child")?.lastChild;
    if (!text) throw new Error("Expected a Lexical text node");
    document.getSelection()?.collapse(text, text.textContent?.length ?? 0);
    document.dispatchEvent(new Event("selectionchange"));
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
