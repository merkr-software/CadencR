import {
  CodeIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AgentIcon } from "@/components/AgentIcon";
import type { TabKind } from "@/stores/feature-layout-schema";

import { PhoneTabBar } from "./PhoneTabBar";

const tabRail = vi.hoisted(() => ({ rail: null as "left" | "right" | null }));
vi.mock("@/hooks/useTabRail", () => ({ useTabRail: () => tabRail.rail }));
import type { FeatureTabs } from "./types";

const tabs: FeatureTabs = {
  agent: { label: "Agent", Icon: AgentIcon, content: null },
  terminal: { label: "Terminal", Icon: TerminalIcon, content: null },
  git: {
    label: "Git",
    Icon: GitCompareArrowsIcon,
    content: null,
    badge: <span>feature/x</span>,
    barBadge: <span>●2</span>,
  },
  editor: { label: "Editor", Icon: CodeIcon, content: null },
  browser: { label: "Browser", Icon: GlobeIcon, content: null },
  preview: { label: "Preview", Icon: FileTextIcon, content: null },
  "plugin:notes": { label: "Notes", Icon: FileTextIcon, content: null, closable: true },
};

const TAB_IDS: TabKind[] = [
  "agent",
  "terminal",
  "git",
  "editor",
  "browser",
  "preview",
  "plugin:notes",
];

function renderBar(activeTabId: TabKind | null = "agent") {
  const onActivateTab = vi.fn();
  const onCloseTab = vi.fn();
  render(
    <PhoneTabBar
      featureId={3}
      activeTabId={activeTabId}
      tabIds={TAB_IDS}
      tabs={tabs}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
    />,
  );
  return { onActivateTab, onCloseTab };
}

describe("PhoneTabBar", () => {
  it("is a vertical rail where the layout asks for one, moved with Up and Down", () => {
    tabRail.rail = "right";
    try {
      renderBar("agent");
      const bar = screen.getByRole("tablist", { name: "Conversation tabs" });
      expect(bar).toHaveAttribute("aria-orientation", "vertical");
      expect(bar).toHaveAttribute("data-rail", "right");
      const agent = screen.getByRole("tab", { name: "Agent" });
      agent.focus();
      fireEvent.keyDown(agent, { key: "ArrowDown" });
      expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
      fireEvent.keyDown(document.activeElement ?? bar, { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
    } finally {
      tabRail.rail = null;
    }
  });

  it("lists Agent, Terminal, Git, Files and More as tabs, the active one selected", () => {
    renderBar("git");
    const bar = screen.getByRole("tablist", { name: "Conversation tabs" });
    const names = within(bar)
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(names).toEqual(["Agent", "Terminal", "Git●2", "Files", "More"]);
    expect(screen.getByRole("tab", { name: /^Git/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "false");
    // Roving tabindex: only the active tab is in the Tab order.
    expect(screen.getByRole("tab", { name: /^Git/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the first tab in the Tab order while no tab it shows is active", () => {
    renderBar(null);
    const stops = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("tabindex") === "0")
      .map((tab) => tab.textContent);
    expect(stops).toEqual(["Agent"]);
  });

  it("activates a tab through the pane's handler", () => {
    const { onActivateTab } = renderBar();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(onActivateTab).toHaveBeenCalledWith("editor");
  });

  it("opens the other tabs from More and activates the one picked", () => {
    const { onActivateTab } = renderBar();
    fireEvent.click(screen.getByRole("tab", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More tabs" });
    const rows = within(sheet)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(rows).toEqual(["Browser", "Preview", "Notes", "Close Notes"]);

    fireEvent.click(within(sheet).getByRole("button", { name: "Preview" }));
    expect(onActivateTab).toHaveBeenCalledWith("preview");
    expect(screen.queryByRole("dialog", { name: "More tabs" })).not.toBeInTheDocument();
  });

  it("selects More while one of its tabs is active and closes a custom tab from the sheet", () => {
    const { onCloseTab } = renderBar("browser");
    expect(screen.getByRole("tab", { name: "More" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More tabs" });
    expect(within(sheet).getByRole("button", { name: "Browser" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Notes" }));
    expect(onCloseTab).toHaveBeenCalledWith("plugin:notes");
  });

  it("moves focus between tabs with the arrow keys", () => {
    renderBar();
    const agent = screen.getByRole("tab", { name: "Agent" });
    agent.focus();
    fireEvent.keyDown(agent, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "More" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? agent, { key: "Home" });
    expect(agent).toHaveFocus();
  });
});
