import { describe, expect, it, vi } from "vitest";
import { BotIcon, BoxIcon } from "lucide-react";
import { render, renderHook, screen } from "@/test-utils";
import type { FeatureTabs } from "@/components/feature-layout/types";
import { useSessionTabs, type UseSessionTabsArgs } from "./WebSocketSessionFeatureBlockTabs";

vi.mock("./WebSocketSessionAgentTab", () => ({
  useAgentTab: () => ({ label: "Agent", Icon: BotIcon, content: <p>transcript</p> }),
}));
vi.mock("@/components/plugin-tabs/usePluginTabDefs", () => ({
  usePluginTabDefs: () => ({
    plugin: { "plugin:board": { label: "Board", Icon: BoxIcon, content: <p>board guest</p> } },
    replacements: { git: { label: "Review", Icon: BoxIcon, content: <p>review guest</p> } },
  }),
}));

const NONE_READY = { editor: false, git: false, terminal: false, browser: false, preview: false };

function renderTabs(pluginTabsReady: boolean): FeatureTabs {
  const args = {
    sessionId: "ws-feature-1",
    featureId: 1,
    layoutFeatureId: 1,
    projectId: 2,
    data: { gitBranch: undefined, effectiveCwd: "/repo", projectPath: "/repo" },
    controls: { ws: { sendPrompt: vi.fn() } },
    refs: { agent: { current: null }, terminal: { current: null }, editor: { current: null } },
    agentVisible: true,
    tabReady: NONE_READY,
    pluginTabsReady,
    hotkeysEnabled: true,
    sendFromGitTab: vi.fn(),
    openAgentFileInEditor: vi.fn(),
    pluginTabsEnabled: true,
    openingPreview: true,
  } as unknown as UseSessionTabsArgs;
  return renderHook(() => useSessionTabs(args)).result.current;
}

function renderContent(tabs: FeatureTabs, tab: keyof FeatureTabs): void {
  render(<div data-testid="tab">{tabs[tab]?.content}</div>);
}

describe("custom tabs and the side tabs' gate", () => {
  it("wait behind the closed gate, placed or in a built-in's place", () => {
    const tabs = renderTabs(false);
    renderContent(tabs, "plugin:board");
    renderContent(tabs, "git");

    expect(screen.queryByText("board guest")).not.toBeInTheDocument();
    expect(screen.queryByText("review guest")).not.toBeInTheDocument();
    expect(document.querySelector('[data-deferred-tab="Board"]')).not.toBeNull();
    expect(document.querySelector('[data-deferred-tab="Review"]')).not.toBeNull();
    // The tab itself stays: label and icon keep their place in the strip.
    expect(tabs["plugin:board"]?.label).toBe("Board");
  });

  it("open with the gate, all at once", () => {
    const tabs = renderTabs(true);
    renderContent(tabs, "plugin:board");
    renderContent(tabs, "git");

    expect(screen.getByText("board guest")).toBeInTheDocument();
    expect(screen.getByText("review guest")).toBeInTheDocument();
  });
});
