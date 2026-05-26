import { act, fireEvent, render } from "@/test-utils";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketSessionFeatureBlock } from "./WebSocketSessionFeatureBlock";

const mocks = vi.hoisted(() => ({
  FeatureLayoutShell: vi.fn(() => null),
  setPaneActiveTab: vi.fn(),
  useSessionFeatureData: vi.fn(),
  useSessionControls: vi.fn(),
  useSessionRefs: vi.fn(),
  useWsSessionEffects: vi.fn(),
  useWsSessionShortcuts: vi.fn(),
  useSessionTabs: vi.fn(() => ({})),
  focusedTabId: "agent",
}));

vi.mock("@/components/FeatureTopBar", () => ({
  FeatureTopBar: () => null,
}));

vi.mock("@/components/feature-layout/FeatureLayoutContext", () => ({
  FeatureLayoutProvider: ({ children }: { children: ReactNode }) => children,
  useFeatureLayoutContext: () => null,
}));

vi.mock("@/components/editor/EditorFuzzyShortcut", () => ({
  EditorFuzzyShortcut: () => null,
}));

vi.mock("@/components/feature-layout/FeatureLayoutShell", () => ({
  FeatureLayoutShell: mocks.FeatureLayoutShell,
}));

vi.mock("@/hooks/useSaveLastOpenedFeature", () => ({
  useSaveLastOpenedFeature: vi.fn(),
}));

vi.mock("@/stores/feature-layout-store", () => {
  const state = {
    features: {},
    setPaneActiveTab: mocks.setPaneActiveTab,
  };
  const useFeatureLayoutStore = Object.assign(
    (
      selector: (state: {
        features: Record<number, unknown>;
        setPaneActiveTab: typeof mocks.setPaneActiveTab;
      }) => unknown,
    ): unknown => selector(state),
    { getState: () => state },
  );
  return {
    findPaneContaining: () => null,
    getFocusedTab: () => mocks.focusedTabId,
    isTabVisible: () => false,
    selectFeatureLayout: () => () => ({}),
    useFeatureLayoutStore,
  };
});

vi.mock("@/components/WebSocketSessionFeatureBlockHooks", () => ({
  useSessionFeatureData: mocks.useSessionFeatureData,
  useSessionControls: mocks.useSessionControls,
  useSessionRefs: mocks.useSessionRefs,
  useWsSessionEffects: mocks.useWsSessionEffects,
  useWsSessionShortcuts: mocks.useWsSessionShortcuts,
}));

vi.mock("@/components/WebSocketSessionFeatureBlockTabs", () => ({
  useSessionTabs: mocks.useSessionTabs,
}));

describe("WebSocketSessionFeatureBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.focusedTabId = "agent";
    mocks.useSessionFeatureData.mockReturnValue({
      projectPath: "/repo",
      gitStats: undefined,
      gitBranch: undefined,
      featureSettings: {},
      session: { serverSessionId: "" },
      effectiveCwd: "/repo",
      worktreeStatus: "idle",
      worktreeBranch: null,
      requestSlashCommands: vi.fn(),
      handleRetryWorktreeSetup: vi.fn(),
    });
    mocks.useSessionControls.mockReturnValue({
      ws: { sendPrompt: vi.fn() },
      featureSettings: {},
    });
    mocks.useSessionRefs.mockReturnValue({
      agent: { current: null },
      terminal: { current: null },
      editor: { current: null },
    });
  });

  it("keeps embedded sessions from auto-initializing even when active", () => {
    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
        embedded
        hotkeysEnabled
      />,
    );

    expect(mocks.useWsSessionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ autoInitSession: false, hotkeysEnabled: true }),
    );
  });

  it("allows route sessions to auto-initialize", () => {
    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
        hotkeysEnabled={false}
      />,
    );

    expect(mocks.useWsSessionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ autoInitSession: true, hotkeysEnabled: false }),
    );
  });

  it("does not mount hidden non-agent panes during route open", () => {
    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
      />,
    );

    const layoutCalls = mocks.FeatureLayoutShell.mock.calls as unknown as Array<[unknown]>;
    const props = layoutCalls.at(-1)?.[0];
    expect(props).toEqual(expect.objectContaining({ mountInactiveTabs: false }));
  });

  it("defers non-agent data and tab hydration on initial route open", () => {
    vi.useFakeTimers();

    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
      />,
    );

    expect(mocks.useSessionFeatureData).toHaveBeenLastCalledWith(
      "ws-feature-1",
      "/repo",
      1,
      2,
      expect.objectContaining({
        gitMetadataEnabled: false,
        projectLookupEnabled: false,
      }),
    );
    expect(mocks.useSessionControls).toHaveBeenLastCalledWith(
      "ws-feature-1",
      1,
      2,
      "/repo",
      expect.objectContaining({
        loadPersistedState: true,
        agentCatalogEnabled: false,
      }),
    );
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: false }),
    );
  });

  it("enables deferred non-agent work after the agent-first delay", () => {
    vi.useFakeTimers();

    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(mocks.useSessionControls).toHaveBeenLastCalledWith(
      "ws-feature-1",
      1,
      2,
      "/repo",
      expect.objectContaining({ agentCatalogEnabled: true }),
    );
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });

  it("keeps deferred non-agent work enabled after returning from a non-agent tab", () => {
    vi.useFakeTimers();

    const props = {
      sessionId: "ws-feature-1",
      cwd: "/repo",
      featureId: 1,
      projectId: 2,
    };
    const { rerender } = render(<WebSocketSessionFeatureBlock {...props} />);

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );

    mocks.focusedTabId = "editor";
    rerender(<WebSocketSessionFeatureBlock {...props} />);
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );

    mocks.focusedTabId = "agent";
    rerender(<WebSocketSessionFeatureBlock {...props} />);
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });

  it("keeps non-agent work enabled after a pre-delay manual non-agent visit", () => {
    vi.useFakeTimers();

    const props = {
      sessionId: "ws-feature-1",
      cwd: "/repo",
      featureId: 1,
      projectId: 2,
    };
    const { rerender } = render(<WebSocketSessionFeatureBlock {...props} />);
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: false }),
    );

    mocks.focusedTabId = "editor";
    rerender(<WebSocketSessionFeatureBlock {...props} />);
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );

    mocks.focusedTabId = "agent";
    rerender(<WebSocketSessionFeatureBlock {...props} />);
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });

  it("does not defer when opening directly to a non-agent tab", () => {
    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
        requestedFocusTab="git"
      />,
    );

    expect(mocks.useSessionControls).toHaveBeenLastCalledWith(
      "ws-feature-1",
      1,
      2,
      "/repo",
      expect.objectContaining({ agentCatalogEnabled: true }),
    );
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });

  it("does not defer when the restored focused tab is non-agent", () => {
    mocks.focusedTabId = "editor";

    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
      />,
    );

    expect(mocks.useSessionControls).toHaveBeenLastCalledWith(
      "ws-feature-1",
      1,
      2,
      "/repo",
      expect.objectContaining({ agentCatalogEnabled: true }),
    );
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });

  it("stamps the agent section as the drop zone and highlights only on file drags", () => {
    const { container } = render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
      />,
    );
    const section = container.querySelector<HTMLElement>(
      'section[data-agent-prompt-id="ws:ws-feature-1"]',
    );
    expect(section).not.toBeNull();
    if (!section) throw new Error("section missing");

    // Text drags must not toggle the highlight — only File drags do.
    act(() => {
      fireEvent.dragEnter(section, { dataTransfer: { types: ["text/plain"] } });
    });
    expect(section.getAttribute("data-agent-dragover")).toBeNull();

    // A real file drag flips on the highlight via `data-agent-dragover`.
    act(() => {
      fireEvent.dragEnter(section, { dataTransfer: { types: ["Files"] } });
    });
    expect(section.getAttribute("data-agent-dragover")).toBe("true");

    // Leaving the section entirely (relatedTarget outside) clears it.
    act(() => {
      fireEvent.dragLeave(section, { dataTransfer: { types: ["Files"] } });
    });
    expect(section.getAttribute("data-agent-dragover")).toBeNull();
  });

  it("hydrates an embedded non-agent tab only when that tab is focused", () => {
    mocks.focusedTabId = "terminal";

    render(
      <WebSocketSessionFeatureBlock
        sessionId="ws-feature-1"
        cwd="/repo"
        featureId={1}
        projectId={2}
        embedded
      />,
    );

    expect(mocks.useSessionControls).toHaveBeenLastCalledWith(
      "ws-feature-1",
      1,
      2,
      "/repo",
      expect.objectContaining({
        loadPersistedState: false,
        agentCatalogEnabled: false,
      }),
    );
    expect(mocks.useSessionTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ nonAgentTabsEnabled: true }),
    );
  });
});
