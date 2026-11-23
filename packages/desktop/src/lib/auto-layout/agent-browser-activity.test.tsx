import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
  type BrowserAgentAccessRequest,
} from "@/lib/desktop-bridge";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import { findPaneContaining, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import {
  registerAutoLayoutTarget,
  resetAutoLayoutControllerForTests,
} from "./auto-layout-controller";
import {
  handleAgentBrowserAccessRequest,
  useAgentBrowserActivityListener,
} from "./agent-browser-activity";

const FEATURE = 11;

function makeRequest(
  overrides: Partial<BrowserAgentAccessRequest> = {},
): BrowserAgentAccessRequest {
  return {
    requestId: "req-1",
    tabId: "tab-1",
    scopeId: FEATURE,
    origin: "https://example.com",
    url: "https://example.com/",
    title: "Example",
    privacy: "normal",
    ...overrides,
  };
}

function browserPaneId(): string | undefined {
  const state = useFeatureLayoutStore.getState().features[FEATURE];
  return state ? findPaneContaining(state.splitRoot, "browser")?.id : undefined;
}

describe("handleAgentBrowserAccessRequest", () => {
  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
    resetAutoLayoutControllerForTests();
    useFeatureLayoutStore.setState({ features: { [FEATURE]: flatLayoutState() } });
    useAutoLayoutStore.setState({ pulsedAt: {}, revealed: {}, undo: {}, agentBrowserActive: {} });
  });

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
  });

  it("ignores requests without a scopeId", () => {
    handleAgentBrowserAccessRequest(makeRequest({ scopeId: null }));
    expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBeUndefined();
    expect(useFeatureLayoutStore.getState().features[FEATURE]?.splitRoot.type).toBe("leaf");
  });

  it("auto-reveals the browser pane in split layout when wide enough", () => {
    const unregister = registerAutoLayoutTarget(FEATURE, {
      measure: () => ({ width: 1400, height: 900 }),
    });
    try {
      handleAgentBrowserAccessRequest(makeRequest());
      expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBe(true);
      expect(browserPaneId()).not.toBe("root");
    } finally {
      unregister();
    }
  });

  it("falls back to activating the browser tab when auto-reveal declines", () => {
    // No auto-layout target registered -> requestAutoReveal returns "declined".
    handleAgentBrowserAccessRequest(makeRequest());
    expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBe(true);
    const root = useFeatureLayoutStore.getState().features[FEATURE]?.splitRoot;
    expect(root?.type).toBe("leaf");
    if (root?.type === "leaf") {
      expect(root.activeTabId).toBe("browser");
    }
  });

  it("subscribes to onBrowserAgentAccessRequest inside useAgentBrowserActivityListener", () => {
    let emitAccessRequest: ((req: BrowserAgentAccessRequest) => void) | null = null;
    const offActivity = vi.fn();
    const offAccess = vi.fn();
    setDesktopBridgeOverrideForTests({
      onBrowserAgentActivity: vi.fn(() => offActivity),
      onBrowserAgentAccessRequest: vi.fn((cb) => {
        emitAccessRequest = cb;
        return offAccess;
      }),
    });

    function Harness() {
      useAgentBrowserActivityListener();
      return null;
    }

    const { unmount } = render(<Harness />);
    act(() => emitAccessRequest?.(makeRequest()));
    expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBe(true);

    unmount();
    expect(offActivity).toHaveBeenCalledOnce();
    expect(offAccess).toHaveBeenCalledOnce();
  });
});
