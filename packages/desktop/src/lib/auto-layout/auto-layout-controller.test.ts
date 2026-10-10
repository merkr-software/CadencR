import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoLayoutStore } from "@/stores/auto-layout-store";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import { findPaneContaining, useFeatureLayoutStore } from "@/stores/feature-layout-store";

import {
  noteUserLayoutChange,
  noteUserPrompt,
  registerAutoLayoutTarget,
  requestAutoReveal,
  resetAutoLayoutControllerForTests,
  undoAutoLayout,
} from "./auto-layout-controller";
import { handleAgentBrowserActivity } from "./agent-browser-activity";
import { resolveAutoLayoutMode } from "./auto-layout-mode";

const FEATURE = 7;
const WIDE = { width: 1400, height: 900 };

function browserPaneId(): string | undefined {
  const state = useFeatureLayoutStore.getState().features[FEATURE];
  return state ? findPaneContaining(state.splitRoot, "browser")?.id : undefined;
}

function register(size: { width: number; height: number } | null = WIDE) {
  return registerAutoLayoutTarget(FEATURE, { measure: () => size });
}

beforeEach(() => {
  resetAutoLayoutControllerForTests();
  useFeatureLayoutStore.setState({ features: { [FEATURE]: flatLayoutState() } });
  useAutoLayoutStore.setState({ pulse: {}, revealed: {}, undo: {}, agentBrowserActive: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestAutoReveal", () => {
  it("declines when no shell with auto layout on is registered", () => {
    expect(requestAutoReveal(FEATURE, "browser", "user-link")).toBe("declined");
    register()();
    expect(requestAutoReveal(FEATURE, "browser", "user-link")).toBe("declined");
    expect(browserPaneId()).toBe("root");
  });

  it("splits the browser beside the agent and pulses the toggle", () => {
    register();
    expect(requestAutoReveal(FEATURE, "browser", "agent")).toBe("split");
    expect(browserPaneId()).not.toBe("root");
    const auto = useAutoLayoutStore.getState();
    expect(auto.pulse[FEATURE]).toBe(1);
    expect(auto.revealed[FEATURE]?.kind).toBe("split");
    expect(auto.undo[FEATURE]).toEqual(flatLayoutState());
  });

  it("hands back to manual behaviour when the shell is too small to split", () => {
    register({ width: 500, height: 400 });
    expect(requestAutoReveal(FEATURE, "browser", "user-link")).toBe("declined");
  });

  it("reports a tab that is already showing as a noop", () => {
    register();
    requestAutoReveal(FEATURE, "browser", "user-link");
    expect(requestAutoReveal(FEATURE, "browser", "user-link")).toBe("noop");
  });

  it("gives the agent one reveal per turn, so a dismissal sticks until the next prompt", () => {
    register();
    requestAutoReveal(FEATURE, "browser", "agent");
    undoAutoLayout(FEATURE);
    expect(browserPaneId()).toBe("root");

    requestAutoReveal(FEATURE, "browser", "agent");
    expect(browserPaneId()).toBe("root");

    noteUserPrompt(FEATURE);
    requestAutoReveal(FEATURE, "browser", "agent");
    expect(browserPaneId()).not.toBe("root");
  });

  it("holds agent reveals off while the user is arranging the layout, but not link clicks", () => {
    vi.useFakeTimers();
    register();
    noteUserLayoutChange(FEATURE);
    expect(requestAutoReveal(FEATURE, "browser", "agent")).toBe("held");
    expect(browserPaneId()).toBe("root");

    requestAutoReveal(FEATURE, "browser", "user-link");
    expect(browserPaneId()).not.toBe("root");
  });

  it("lets the agent reveal again once the cooldown has passed", () => {
    vi.useFakeTimers();
    register();
    noteUserLayoutChange(FEATURE);
    vi.advanceTimersByTime(8_000);
    requestAutoReveal(FEATURE, "browser", "agent");
    expect(browserPaneId()).not.toBe("root");
  });

  it("drops the undo snapshot after a structural manual change", () => {
    register();
    requestAutoReveal(FEATURE, "browser", "user-link");
    noteUserLayoutChange(FEATURE, { structural: true });
    expect(useAutoLayoutStore.getState().undo[FEATURE]).toBeUndefined();
  });
});

describe("handleAgentBrowserActivity", () => {
  it("flags activity for a few seconds and only reveals when a page is opened", () => {
    vi.useFakeTimers();
    register();
    handleAgentBrowserActivity({ scopeId: FEATURE, action: "interact" });
    expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBe(true);
    expect(browserPaneId()).toBe("root");

    handleAgentBrowserActivity({ scopeId: FEATURE, action: "open" });
    expect(browserPaneId()).not.toBe("root");

    vi.advanceTimersByTime(3_000);
    expect(useAutoLayoutStore.getState().agentBrowserActive[FEATURE]).toBeUndefined();
  });
});

describe("resolveAutoLayoutMode", () => {
  it("lets the feature override win over the workspace default", () => {
    expect(resolveAutoLayoutMode(undefined, null)).toBe(false);
    expect(resolveAutoLayoutMode(undefined, "true")).toBe(true);
    expect(resolveAutoLayoutMode("off", "true")).toBe(false);
    expect(resolveAutoLayoutMode("on", "false")).toBe(true);
  });
});
