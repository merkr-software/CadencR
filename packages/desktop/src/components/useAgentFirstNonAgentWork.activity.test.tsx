import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import type { TabKind } from "@/stores/feature-layout-schema";
import {
  HIDDEN_SIDE_TABS_GRACE_MS,
  useAgentFirstNonAgentWork,
  useStaggeredTabReadiness,
} from "./useAgentFirstNonAgentWork";

/** One `act` per frame: each step is scheduled by the commit before it. */
function advanceFrames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) {
    act(() => void vi.advanceTimersByTime(20));
  }
}

/** The grace, then the idle period the close waits for (a timer in this DOM). */
const PAST_GRACE_MS = HIDDEN_SIDE_TABS_GRACE_MS + 6_000;

interface Props {
  immediateTab: TabKind | null;
}

/** The gate and stagger as a workspace wires them (`useNonAgentTabReadiness`). */
function renderReadiness(activity: WorkspaceActivityController, immediateTab: TabKind | null) {
  let renders = 0;
  const hook = renderHook(
    ({ immediateTab: tab }: Props) => {
      renders += 1;
      const workEnabled = useAgentFirstNonAgentWork({
        enabled: true,
        immediate: tab !== null,
        resetKey: "ws-feature-1",
      });
      const tabReady = useStaggeredTabReadiness({
        enabled: workEnabled,
        immediateTab: tab,
        resetKey: "ws-feature-1",
      });
      return { workEnabled, tabReady };
    },
    {
      initialProps: { immediateTab },
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      ),
    },
  );
  return { ...hook, renders: () => renders };
}

const revealedCount = (ready: Record<string, boolean>): number =>
  Object.values(ready).filter(Boolean).length;

describe("side tabs of a workspace kept mounted but hidden", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("open nothing while hidden, even for a focused side tab", () => {
    const { result, rerender } = renderReadiness(createWorkspaceActivity(false), "terminal");
    advanceFrames(10);
    expect(result.current.workEnabled).toBe(false);
    expect(result.current.tabReady.terminal).toBe(false);

    rerender({ immediateTab: null });
    advanceFrames(10);
    expect(result.current.workEnabled).toBe(false);
  });

  it("open at once when shown on a focused side tab", () => {
    const activity = createWorkspaceActivity(false);
    const { result } = renderReadiness(activity, "terminal");

    // No frame advanced: open in the commit that shows it.
    act(() => activity.set(true));

    expect(result.current.workEnabled).toBe(true);
    expect(result.current.tabReady.terminal).toBe(true);
  });

  it("open one paint after being shown on the agent, then stagger in", () => {
    const activity = createWorkspaceActivity(false);
    const { result } = renderReadiness(activity, null);

    act(() => activity.set(true));
    expect(result.current.workEnabled).toBe(false);

    advanceFrames(1);
    expect(result.current.workEnabled).toBe(true);
    expect(revealedCount(result.current.tabReady)).toBe(0);
    advanceFrames(1);
    expect(result.current.tabReady).toMatchObject({ editor: true, git: false });
  });

  it("stop staggering while hidden and resume when shown", () => {
    const activity = createWorkspaceActivity(true);
    const { result } = renderReadiness(activity, null);
    advanceFrames(3);
    expect(result.current.tabReady).toMatchObject({ editor: true, git: true, terminal: false });

    act(() => activity.set(false));
    advanceFrames(10);
    expect(revealedCount(result.current.tabReady)).toBe(2);

    act(() => activity.set(true));
    advanceFrames(3);
    expect(revealedCount(result.current.tabReady)).toBe(5);
  });

  it("change nothing when shown again within the grace", () => {
    const activity = createWorkspaceActivity(true);
    const { result, renders } = renderReadiness(activity, null);
    advanceFrames(10);
    expect(revealedCount(result.current.tabReady)).toBe(5);
    const rendersBefore = renders();

    act(() => activity.set(false));
    act(() => void vi.advanceTimersByTime(HIDDEN_SIDE_TABS_GRACE_MS - 1_000));
    act(() => activity.set(true));
    advanceFrames(10);
    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));

    expect(renders()).toBe(rendersBefore);
    expect(result.current.workEnabled).toBe(true);
    expect(revealedCount(result.current.tabReady)).toBe(5);
  });

  it("close after the grace, then open and stagger again like a first open", () => {
    const activity = createWorkspaceActivity(true);
    const { result } = renderReadiness(activity, null);
    advanceFrames(10);
    expect(revealedCount(result.current.tabReady)).toBe(5);

    act(() => activity.set(false));
    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));
    expect(result.current.workEnabled).toBe(false);
    expect(revealedCount(result.current.tabReady)).toBe(0);

    act(() => activity.set(true));
    expect(result.current.workEnabled).toBe(false);
    advanceFrames(1);
    expect(result.current.workEnabled).toBe(true);
    expect(revealedCount(result.current.tabReady)).toBe(0);
    advanceFrames(1);
    expect(result.current.tabReady).toMatchObject({ editor: true, git: false });
  });

  it("stay open when shown while the close is in flight", () => {
    const activity = createWorkspaceActivity(true);
    const { result } = renderReadiness(activity, null);
    advanceFrames(10);
    expect(revealedCount(result.current.tabReady)).toBe(5);

    act(() => activity.set(false));
    act(() => {
      // The grace runs out and the close is dispatched as a transition, which
      // `act` holds until its end: the workspace is shown before it commits.
      vi.advanceTimersByTime(PAST_GRACE_MS);
      activity.set(true);
    });
    advanceFrames(10);

    expect(result.current.workEnabled).toBe(true);
    expect(revealedCount(result.current.tabReady)).toBe(5);
  });

  it("reopen at once after the grace when shown on a focused side tab", () => {
    const activity = createWorkspaceActivity(true);
    const { result } = renderReadiness(activity, "git");
    advanceFrames(10);

    act(() => activity.set(false));
    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));
    expect(result.current.tabReady.git).toBe(false);

    act(() => activity.set(true));
    expect(result.current.tabReady.git).toBe(true);
  });

  it("stay open for a workspace outside a pool", () => {
    // No provider: the always-active default of an embedded card.
    const { result } = renderHook(() =>
      useAgentFirstNonAgentWork({ enabled: true, immediate: false, resetKey: "a" }),
    );
    advanceFrames(1);
    expect(result.current).toBe(true);

    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));
    expect(result.current).toBe(true);
  });
});
