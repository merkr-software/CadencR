import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen } from "@/test-utils";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import {
  activateFeatureTab,
  getFocusedTab,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import type { TabKind } from "@/stores/feature-layout-schema";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WorkspacePool } from "./WorkspacePool";
import { useWorkspaceActive } from "./workspace-activity";
import { PREWARM_HOLD_MS } from "./workspace-pool-hooks";
import { WORKSPACE_POOL_LIMIT, type WorkspaceTarget } from "./workspace-pool-state";
import { requestWorkspacePrewarm } from "./workspace-prewarm";

const mocks = vi.hoisted(() => ({
  /** Extra content a test puts inside a workspace. */
  content: new Map<string, ReactNode>(),
  mounts: new Map<string, number>(),
  renders: new Map<string, number>(),
  markRead: vi.fn(),
  saveLastOpened: vi.fn(),
  hydrate: vi.fn(),
}));

// A stand-in for the workspace that keeps what decides when it renders: the
// session sampler and the side-tab gate and stagger.
vi.mock("@/components/WebSocketSessionFeatureBlock", async () => {
  const { useEffect } = await import("react");
  const { useWorkspaceSession } = await import("@/hooks/useWorkspaceSession");
  const { useAgentFirstNonAgentWork, useStaggeredTabReadiness } =
    await import("@/components/useAgentFirstNonAgentWork");
  return {
    WebSocketSessionFeatureBlock: ({ sessionId }: { sessionId: string }) => {
      mocks.renders.set(sessionId, (mocks.renders.get(sessionId) ?? 0) + 1);
      useWorkspaceSession(sessionId);
      const workEnabled = useAgentFirstNonAgentWork({
        enabled: true,
        immediate: false,
        resetKey: sessionId,
      });
      useStaggeredTabReadiness({ enabled: workEnabled, immediateTab: null, resetKey: sessionId });
      useEffect(() => {
        mocks.mounts.set(sessionId, (mocks.mounts.get(sessionId) ?? 0) + 1);
      }, [sessionId]);
      return (
        <div data-testid={`workspace-${sessionId}`}>
          <ActivityProbe sessionId={sessionId} />
          {mocks.content.get(sessionId)}
        </div>
      );
    },
  };
});

vi.mock("@/contexts/ResolvedModelContext", () => ({
  ResolvedModelProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/stores/for-me-ack", () => ({
  useMarkFeatureRead: (featureId: number) => mocks.markRead(featureId),
}));

vi.mock("@/hooks/useSaveLastOpenedFeature", () => ({
  useSaveLastOpenedFeature: (projectId: number, featureId: number) =>
    mocks.saveLastOpened(projectId, featureId),
}));

vi.mock("@/lib/conversation-preload", () => ({
  hydratePreloadedConversation: (featureId: number) => mocks.hydrate(featureId),
}));

function ActivityProbe({ sessionId }: { sessionId: string }) {
  const active = useWorkspaceActive();
  return <span data-testid={`activity-${sessionId}`}>{active ? "active" : "hidden"}</span>;
}

function target(featureId: number, focusTab?: TabKind): WorkspaceTarget {
  return {
    sessionId: `ws-feature-${featureId}`,
    cwd: "/repo",
    featureId,
    projectId: 1,
    focusTab,
  };
}

function isMounted(featureId: number): boolean {
  return screen.queryByTestId(`workspace-ws-feature-${featureId}`) !== null;
}

function rendersOf(featureId: number): number {
  return mocks.renders.get(`ws-feature-${featureId}`) ?? 0;
}

/** The pool slot around a mocked workspace. */
function slotOf(featureId: number): HTMLElement {
  const slot = screen
    .getByTestId(`workspace-ws-feature-${featureId}`)
    .closest("[data-workspace-slot]");
  if (!(slot instanceof HTMLElement)) throw new Error(`no slot for feature ${featureId}`);
  return slot;
}

/** The workspace's mount effect creates its session entry; do the same. */
function connectSession(featureId: number): void {
  useWsSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [`ws-feature-${featureId}`]: createSessionEntry() },
  }));
}

/** Frames and tasks, one `act` each: every step is scheduled by the commit before it. */
function flushFrames(count = 16): void {
  for (let frame = 0; frame < count; frame += 1) act(() => void vi.advanceTimersByTime(20));
}

const focusedTabOf = (featureId: number): TabKind | null =>
  getFocusedTab(useFeatureLayoutStore.getState().features[featureId] ?? flatLayoutState());

/** Shows `count` conversations, 1 to `count`, the last one on screen. */
function showConversations(count: number) {
  const view = render(<WorkspacePool target={target(1)} />);
  act(() => connectSession(1));
  for (let featureId = 2; featureId <= count; featureId += 1) {
    view.rerender(<WorkspacePool target={target(featureId)} />);
    act(() => connectSession(featureId));
  }
  return view;
}

describe("WorkspacePool", () => {
  beforeEach(() => {
    mocks.content.clear();
    mocks.mounts.clear();
    mocks.renders.clear();
    mocks.markRead.mockClear();
    mocks.saveLastOpened.mockClear();
    mocks.hydrate.mockReset();
    useWsSessionStore.setState({ sessions: {} });
    useFeatureLayoutStore.setState({ features: {} });
  });

  afterEach(() => vi.useRealTimers());

  it("keeps the previous conversation mounted, hidden, off screen and out of reach", () => {
    showConversations(2);

    expect(slotOf(2).dataset.workspaceSlot).toBe("active");
    expect(slotOf(2).inert).toBe(false);
    expect(slotOf(2).style.left).toBe("");
    const hidden = slotOf(1);
    expect(hidden.dataset.workspaceSlot).toBe("hidden");
    expect(hidden.inert).toBe(true);
    expect(hidden.style.visibility).toBe("hidden");
    // Split handles are hit-tested by geometry: a hidden slot must not overlap.
    expect(hidden.style.left).toBe("-200vw");
    expect(hidden.style.top).toBe("");
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows a conversation again without mounting or rendering its workspace", () => {
    const view = showConversations(2);
    const rendersBefore = rendersOf(1);

    view.rerender(<WorkspacePool target={target(1)} />);

    expect(slotOf(1).dataset.workspaceSlot).toBe("active");
    expect(mocks.mounts.get("ws-feature-1")).toBe(1);
    expect(rendersOf(1)).toBe(rendersBefore);
  });

  it("hides every workspace without a target and shows the same one again (the phone inbox)", () => {
    const view = showConversations(2);
    const rendersBefore = rendersOf(2);
    mocks.markRead.mockClear();

    view.rerender(<WorkspacePool target={null} />);
    expect(slotOf(1).dataset.workspaceSlot).toBe("hidden");
    expect(slotOf(2).dataset.workspaceSlot).toBe("hidden");
    expect(slotOf(2).inert).toBe(true);
    expect(screen.getByTestId("activity-ws-feature-2")).toHaveTextContent("hidden");
    expect(mocks.markRead).not.toHaveBeenCalled();

    view.rerender(<WorkspacePool target={target(2)} />);
    expect(slotOf(2).dataset.workspaceSlot).toBe("active");
    expect(mocks.mounts.get("ws-feature-2")).toBe(1);
    expect(rendersOf(2)).toBe(rendersBefore);
  });

  it("does not render a workspace shown again in the frames and tasks that follow", () => {
    vi.useFakeTimers();
    const view = render(<WorkspacePool target={target(1)} />);
    act(() => connectSession(1));
    // Side tabs open and stagger in.
    flushFrames();
    view.rerender(<WorkspacePool target={target(2)} />);
    act(() => connectSession(2));
    flushFrames();
    const rendersBefore = rendersOf(1);

    view.rerender(<WorkspacePool target={target(1)} />);
    flushFrames();
    act(() => void vi.advanceTimersByTime(5_000));

    expect(rendersOf(1)).toBe(rendersBefore);
  });

  it("tells each workspace whether it is the one on screen", () => {
    const view = render(<WorkspacePool target={target(1)} />);
    act(() => connectSession(1));
    expect(screen.getByTestId("activity-ws-feature-1")).toHaveTextContent("active");

    view.rerender(<WorkspacePool target={target(2)} />);
    act(() => connectSession(2));

    expect(screen.getByTestId("activity-ws-feature-1")).toHaveTextContent("hidden");
    expect(screen.getByTestId("activity-ws-feature-2")).toHaveTextContent("active");
  });

  it("marks read and remembers only the conversation on screen", () => {
    const view = render(<WorkspacePool target={target(1)} />);
    view.rerender(<WorkspacePool target={target(2)} />);
    view.rerender(<WorkspacePool target={target(1)} />);

    expect(mocks.markRead.mock.calls.map(([featureId]) => featureId)).not.toContain(undefined);
    expect(mocks.markRead).toHaveBeenLastCalledWith(1);
    expect(mocks.saveLastOpened).toHaveBeenLastCalledWith(1, 1);
  });

  describe("floating layers on a switch", () => {
    let layer: HTMLElement;
    const presses: string[] = [];
    const record = (event: Event): void => {
      presses.push(`${event.type}:${event instanceof MouseEvent ? event.button : "?"}`);
    };

    beforeEach(() => {
      presses.length = 0;
      layer = document.body.appendChild(document.createElement("div"));
      layer.setAttribute("data-radix-popper-content-wrapper", "");
      document.addEventListener("pointerdown", record);
      document.addEventListener("click", record);
    });

    afterEach(() => {
      document.removeEventListener("pointerdown", record);
      document.removeEventListener("click", record);
      layer.remove();
    });

    /** A control inside workspace `featureId`, with `attributes`. */
    function controlIn(featureId: number, attributes: Record<string, string>): HTMLElement {
      const control = document.createElement("button");
      for (const [name, value] of Object.entries(attributes)) control.setAttribute(name, value);
      screen.getByTestId(`workspace-ws-feature-${featureId}`).appendChild(control);
      return control;
    }

    /** The popup trigger the open layer came from, inside workspace `featureId`. */
    const openTriggerIn = (featureId: number): HTMLElement =>
      controlIn(featureId, { "aria-haspopup": "dialog", "aria-expanded": "true" });

    it("replays a whole primary press for a layer opened from the conversation being hidden", () => {
      const view = render(<WorkspacePool target={target(1)} />);
      const trigger = openTriggerIn(1);

      view.rerender(<WorkspacePool target={target(2)} />);
      // Deferred layers (Radix popovers) dismiss on the click, not the pointerdown.
      expect(presses).toEqual(["pointerdown:0", "click:0"]);

      trigger.remove();
      view.rerender(<WorkspacePool target={target(1)} />);
      // Nothing of the hidden conversation is open: no press is made up.
      expect(presses).toHaveLength(2);
    });

    it("recognizes a context-menu area while its menu is open", () => {
      const view = render(<WorkspacePool target={target(1)} />);
      controlIn(1, { "aria-haspopup": "menu", "data-state": "open" });

      view.rerender(<WorkspacePool target={target(2)} />);

      expect(presses).toEqual(["pointerdown:0", "click:0"]);
    });

    it("leaves open a layer the conversation being hidden does not own", () => {
      // A root dialog or a sidebar popover, open while the conversation switches.
      const view = render(<WorkspacePool target={target(1)} />);

      view.rerender(<WorkspacePool target={target(2)} />);

      expect(presses).toEqual([]);
    });

    it("does not take an expanded disclosure control for a layer's trigger", () => {
      const view = render(<WorkspacePool target={target(1)} />);
      // A tool summary or a fold button: expanded, but no popup.
      controlIn(1, { "aria-expanded": "true", "data-state": "open" });

      view.rerender(<WorkspacePool target={target(2)} />);

      expect(presses).toEqual([]);
    });

    it("leaves open a layer the conversation being shown owns", () => {
      const view = showConversations(2);
      openTriggerIn(1);

      view.rerender(<WorkspacePool target={target(3)} />);

      expect(presses).toEqual([]);
    });
  });

  it("closes a Radix popover left open in the conversation being hidden", async () => {
    mocks.content.set(
      "ws-feature-1",
      <Popover defaultOpen>
        <PopoverTrigger>History</PopoverTrigger>
        <PopoverContent>Stashed drafts</PopoverContent>
      </Popover>,
    );
    const view = render(<WorkspacePool target={target(1)} />);
    expect(screen.getByText("Stashed drafts")).toBeInTheDocument();
    // Radix starts listening for outside presses a task after it opens.
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));

    // A switch made without a press: from the keyboard, or programmatically.
    view.rerender(<WorkspacePool target={target(2)} />);

    expect(screen.queryByText("Stashed drafts")).not.toBeInTheDocument();
  });

  it("unmounts a hidden conversation whose session was closed", () => {
    showConversations(2);

    act(() => useWsSessionStore.getState().release("ws-feature-1"));

    expect(isMounted(1)).toBe(false);
    expect(isMounted(2)).toBe(true);
  });

  it("unmounts a conversation closed while it was on screen, once it is hidden", () => {
    const view = render(<WorkspacePool target={target(1)} />);
    act(() => connectSession(1));
    act(() => useWsSessionStore.getState().release("ws-feature-1"));
    expect(isMounted(1)).toBe(true);

    view.rerender(<WorkspacePool target={target(2)} />);

    expect(isMounted(1)).toBe(false);
  });

  it("trims the least recently shown conversations once idle", () => {
    vi.useFakeTimers();
    showConversations(WORKSPACE_POOL_LIMIT + 1);
    // One too many, and nothing unmounted during the switches themselves.
    expect(isMounted(1)).toBe(true);

    act(() => void vi.advanceTimersByTime(3_000));

    expect(isMounted(1)).toBe(false);
    expect(isMounted(2)).toBe(true);
  });

  describe("a conversation mounted on a press", () => {
    it("is hydrated from its preload before it mounts", () => {
      render(<WorkspacePool target={target(1)} />);
      mocks.hydrate.mockImplementation(() => {
        expect(isMounted(2)).toBe(false);
      });

      act(() => requestWorkspacePrewarm(target(2)));

      expect(mocks.hydrate).toHaveBeenCalledWith(2);
      expect(isMounted(2)).toBe(true);
    });

    it("mounts hidden, then is shown without a new mount", () => {
      const view = render(<WorkspacePool target={target(1)} />);
      act(() => connectSession(1));

      act(() => requestWorkspacePrewarm(target(2)));
      act(() => connectSession(2));

      expect(slotOf(2).dataset.workspaceSlot).toBe("hidden");
      expect(screen.getByTestId("activity-ws-feature-2")).toHaveTextContent("hidden");

      view.rerender(<WorkspacePool target={target(2)} />);

      expect(slotOf(2).dataset.workspaceSlot).toBe("active");
      expect(mocks.mounts.get("ws-feature-2")).toBe(1);
    });

    it("is kept while its session entry does not exist yet", () => {
      render(<WorkspacePool target={target(1)} />);
      act(() => connectSession(1));
      act(() => requestWorkspacePrewarm(target(2)));

      // Another session moves before the prewarmed workspace has connected.
      act(() => connectSession(3));

      expect(isMounted(2)).toBe(true);
    });

    it("is shown with the tab the click asks for, without rendering its workspace", () => {
      useFeatureLayoutStore.setState({
        features: { 1: flatLayoutState("terminal"), 2: flatLayoutState("agent") },
      });
      const view = render(<WorkspacePool target={target(1)} />);
      // The press mounts it with no tab request: a press may never become a click.
      act(() => requestWorkspacePrewarm(target(2)));
      expect(focusedTabOf(2)).toBe("agent");
      const rendersBefore = rendersOf(2);

      // The click carries the tab of the conversation being left.
      view.rerender(<WorkspacePool target={target(2, "terminal")} />);

      expect(rendersOf(2)).toBe(rendersBefore);
      expect(focusedTabOf(2)).toBe("terminal");
    });

    it("does not count toward the limit, so it evicts nobody", () => {
      vi.useFakeTimers();
      showConversations(WORKSPACE_POOL_LIMIT);
      act(() => requestWorkspacePrewarm(target(WORKSPACE_POOL_LIMIT + 1)));

      // Past the trim's deadline (2 s without idle callbacks), before the
      // prewarm's hold and its idle drop (2 s + 2 s) have run out.
      act(() => void vi.advanceTimersByTime(3_000));

      for (let featureId = 1; featureId <= WORKSPACE_POOL_LIMIT + 1; featureId += 1) {
        expect(isMounted(featureId)).toBe(true);
      }
    });

    it("is kept when it comes back after leaving the pool, before it connects", () => {
      vi.useFakeTimers();
      showConversations(WORKSPACE_POOL_LIMIT + 1);
      act(() => void vi.advanceTimersByTime(3_000));
      expect(isMounted(1)).toBe(false);
      // Its session entry expires once nothing holds it.
      act(() => useWsSessionStore.getState().release("ws-feature-1"));

      // Pressed again: mounted hidden, its new entry not created yet.
      act(() => requestWorkspacePrewarm(target(1)));
      act(() => connectSession(9));

      expect(isMounted(1)).toBe(true);
    });

    it("is not the one trimmed", () => {
      vi.useFakeTimers();
      showConversations(WORKSPACE_POOL_LIMIT + 1);
      act(() => requestWorkspacePrewarm(target(9)));

      // The trim runs (at most 2 s), before the prewarm's hold has run out.
      act(() => void vi.advanceTimersByTime(2_500));

      expect(isMounted(1)).toBe(false);
      expect(isMounted(9)).toBe(true);
    });

    it("is dropped when no click shows it", () => {
      vi.useFakeTimers();
      showConversations(2);
      act(() => requestWorkspacePrewarm(target(3)));
      expect(isMounted(3)).toBe(true);

      act(() => void vi.advanceTimersByTime(PREWARM_HOLD_MS + 2_500));

      expect(isMounted(3)).toBe(false);
      expect(isMounted(1)).toBe(true);
      expect(isMounted(2)).toBe(true);
    });
  });

  describe("the tab a navigation asks for", () => {
    it("is applied to a conversation shown again", () => {
      useFeatureLayoutStore.setState({
        features: { 1: flatLayoutState("agent"), 2: flatLayoutState("agent") },
      });
      const view = showConversations(2);

      view.rerender(<WorkspacePool target={target(1, "git")} />);

      expect(focusedTabOf(1)).toBe("git");
    });

    it("is applied again when the same tab is carried over again", () => {
      useFeatureLayoutStore.setState({
        features: { 1: flatLayoutState("terminal"), 2: flatLayoutState("agent") },
      });
      const view = render(<WorkspacePool target={target(1)} />);
      view.rerender(<WorkspacePool target={target(2, "terminal")} />);
      expect(focusedTabOf(2)).toBe("terminal");

      // The user goes back to the agent in conversation 2, leaves it, returns
      // from conversation 1 still on its terminal.
      act(() => void activateFeatureTab(2, "agent"));
      view.rerender(<WorkspacePool target={target(1, "agent")} />);
      view.rerender(<WorkspacePool target={target(2, "terminal")} />);

      expect(focusedTabOf(2)).toBe("terminal");
    });

    it("waits for a layout that is not in the store yet", () => {
      const view = showConversations(2);

      view.rerender(<WorkspacePool target={target(1, "editor")} />);
      act(() => useFeatureLayoutStore.setState({ features: { 1: flatLayoutState("agent") } }));

      expect(focusedTabOf(1)).toBe("editor");
    });
  });
});
