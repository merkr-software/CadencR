// @vitest-environment happy-dom
import { createElement, memo, useLayoutEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  useSettledWorkspaceActive,
  useWorkspaceActive,
  whileActive,
  type WorkspaceActivityController,
} from "./workspace-activity";

describe("createWorkspaceActivity", () => {
  it("notifies subscribers after the value changed", () => {
    const activity = createWorkspaceActivity(false);
    const seen: boolean[] = [];
    activity.subscribe(() => seen.push(activity.isActive()));

    activity.set(true);
    activity.set(false);

    expect(seen).toEqual([true, false]);
  });

  it("stays quiet when set to the value it already has", () => {
    const activity = createWorkspaceActivity(true);
    const listener = vi.fn();
    activity.subscribe(listener);

    activity.set(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying an unsubscribed listener", () => {
    const activity = createWorkspaceActivity(true);
    const listener = vi.fn();
    const unsubscribe = activity.subscribe(listener);

    unsubscribe();
    activity.set(false);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("whileActive", () => {
  it("starts at once in a workspace on screen, stops when it is hidden, starts again when shown", () => {
    const activity = createWorkspaceActivity(true);
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    whileActive(activity, start);
    expect(start).toHaveBeenCalledTimes(1);

    activity.set(false);
    expect(stop).toHaveBeenCalledTimes(1);

    activity.set(true);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not start in a hidden workspace until it is shown", () => {
    const activity = createWorkspaceActivity(false);
    const start = vi.fn(() => () => {});

    whileActive(activity, start);
    expect(start).not.toHaveBeenCalled();

    activity.set(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stops what runs and follows the workspace no more once cleaned up", () => {
    const activity = createWorkspaceActivity(true);
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    const cleanup = whileActive(activity, start);
    cleanup();
    expect(stop).toHaveBeenCalledTimes(1);

    activity.set(false);
    activity.set(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("has nothing to stop when cleaned up while hidden", () => {
    const activity = createWorkspaceActivity(true);
    const stop = vi.fn();
    const cleanup = whileActive(activity, () => stop);

    activity.set(false);
    cleanup();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

function renderSettled(activity: WorkspaceActivityController) {
  return renderHook(() => useSettledWorkspaceActive(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(WorkspaceActivityProvider, { value: activity }, children),
  });
}

describe("useSettledWorkspaceActive", () => {
  it("starts from the workspace's current state", () => {
    expect(renderSettled(createWorkspaceActivity(false)).result.current).toBe(false);
    expect(renderSettled(createWorkspaceActivity(true)).result.current).toBe(true);
  });

  it("follows the workspace being shown and hidden", () => {
    const activity = createWorkspaceActivity(true);
    const hook = renderSettled(activity);

    act(() => activity.set(false));
    expect(hook.result.current).toBe(false);

    act(() => activity.set(true));
    expect(hook.result.current).toBe(true);
  });

  it("re-renders after the commit that switched, not in it", () => {
    const seen: string[] = [];
    // Memoized as a workspace is: only the activity re-renders it.
    const Probe = memo(function Probe() {
      seen.push(`${String(useWorkspaceActive())}/${String(useSettledWorkspaceActive())}`);
      return null;
    });
    // As in the pool: the slot sets its activity in a layout effect.
    function Slot({ active }: { active: boolean }) {
      const [activity] = useState(() => createWorkspaceActivity(true));
      useLayoutEffect(() => activity.set(active), [active, activity]);
      return createElement(WorkspaceActivityProvider, { value: activity }, createElement(Probe));
    }
    const view = render(createElement(Slot, { active: true }));
    seen.length = 0;

    view.rerender(createElement(Slot, { active: false }));

    // The switch's own commit sees the synchronous value only; the settled
    // one follows in a later render.
    expect(seen[0]).toBe("false/true");
    expect(seen.at(-1)).toBe("false/false");
  });
});
