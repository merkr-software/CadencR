import {
  BotIcon,
  CodeIcon,
  GitCompareArrowsIcon,
  FileTextIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { flatLayoutState, type TabKind } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useTabHostRegistry } from "@/stores/tab-host-registry";

import { TabContentRegistry } from "./TabContentRegistry";
import type { FeatureTabs } from "./types";

const FEATURE_ID = 3;

const tabs: FeatureTabs = {
  agent: { label: "Agent", Icon: BotIcon, content: <span>agent-body</span> },
  terminal: { label: "Terminal", Icon: TerminalIcon, content: <span>terminal-body</span> },
  git: { label: "Git", Icon: GitCompareArrowsIcon, content: <span>git-body</span> },
  editor: { label: "Editor", Icon: CodeIcon, content: <span>editor-body</span> },
  browser: { label: "Browser", Icon: GlobeIcon, content: <span>browser-body</span> },
  preview: { label: "Preview", Icon: FileTextIcon, content: <span>preview-body</span> },
};

function mountedTabs(): TabKind[] {
  return [...document.querySelectorAll<HTMLElement>("[data-tab-mount]")]
    .filter((el) => el.textContent)
    .map((el) => el.dataset.tabMount as TabKind);
}

describe("TabContentRegistry", () => {
  beforeEach(() => {
    useFeatureLayoutStore.setState({ features: {} });
    useTabHostRegistry.setState({ hosts: {} });
    for (const el of document.querySelectorAll("[data-tab-mount]")) el.remove();
  });

  it("mounts only the visible tab, then keeps visited tabs mounted", () => {
    const view = render(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={tabs}
        layoutState={flatLayoutState("agent")}
        mountVisibleOnly
      />,
    );
    expect(mountedTabs()).toEqual(["agent"]);

    view.rerender(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={tabs}
        layoutState={flatLayoutState("terminal")}
        mountVisibleOnly
      />,
    );
    // Terminal became visible; agent stays mounted so its live session (xterm,
    // WS) survives the switch.
    expect(mountedTabs().sort()).toEqual(["agent", "terminal"]);
  });

  it("mounts every tab when mountVisibleOnly is off", () => {
    render(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={tabs}
        layoutState={flatLayoutState("agent")}
      />,
    );
    expect(mountedTabs().sort()).toEqual([
      "agent",
      "browser",
      "editor",
      "git",
      "preview",
      "terminal",
    ]);
  });

  // The visited-tab effect is keyed on a joined string rather than on
  // `layoutState`, precisely so a new-but-equivalent layout object — which is
  // what the shell produced on every render before it was memoized — is inert.
  it("ignores a new layout object that describes the same visible tabs", () => {
    const view = render(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={tabs}
        layoutState={flatLayoutState("agent")}
        mountVisibleOnly
      />,
    );
    view.rerender(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={tabs}
        layoutState={flatLayoutState("agent")}
        mountVisibleOnly
      />,
    );
    expect(mountedTabs()).toEqual(["agent"]);
  });

  it("creates a plugin tab's mount while it is defined and placed, and removes it after", () => {
    const GRAPH = "plugin:graph" as const;
    const withGraph: FeatureTabs = {
      ...tabs,
      [GRAPH]: {
        label: "Graph",
        Icon: GlobeIcon,
        content: <span>graph-body</span>,
        closable: true,
      },
    };
    const placed = flatLayoutState("agent", [GRAPH]);
    const graphMount = (): Element | null => document.querySelector(`[data-tab-mount="${GRAPH}"]`);

    const view = render(
      <TabContentRegistry featureId={FEATURE_ID} tabs={tabs} layoutState={placed} />,
    );
    expect(graphMount()).toBeNull();

    // Defined but not placed: the mount exists but stays empty and detached.
    view.rerender(
      <TabContentRegistry
        featureId={FEATURE_ID}
        tabs={withGraph}
        layoutState={flatLayoutState("agent")}
      />,
    );
    expect(mountedTabs()).not.toContain(GRAPH);

    view.rerender(
      <TabContentRegistry featureId={FEATURE_ID} tabs={withGraph} layoutState={placed} />,
    );
    const mount = graphMount();
    expect(mount?.textContent).toBe("graph-body");

    // Same mount across re-renders with a fresh `tabs` object.
    view.rerender(
      <TabContentRegistry featureId={FEATURE_ID} tabs={{ ...withGraph }} layoutState={placed} />,
    );
    expect(graphMount()).toBe(mount);

    view.rerender(<TabContentRegistry featureId={FEATURE_ID} tabs={tabs} layoutState={placed} />);
    expect(graphMount()).toBeNull();
    expect(mount?.isConnected).toBe(false);
    expect(mountedTabs().sort()).toEqual([
      "agent",
      "browser",
      "editor",
      "git",
      "preview",
      "terminal",
    ]);
  });
});
