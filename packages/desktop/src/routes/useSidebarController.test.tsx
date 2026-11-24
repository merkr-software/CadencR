// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sidebar panel is absent in the phone layout. Flipping back mounts it
 * at the state it will show and drives it only once the panel reported its
 * first size (before that its handle throws).
 */

const mocks = vi.hoisted(() => ({
  settings: {
    sidebar_left_width: "300",
    sidebar_collapsed: "false",
  } as Record<string, string>,
  writes: [] as [string, string][],
  writeResult: true,
}));

vi.mock("@/hooks/useSetting", () => ({
  useSetting: (key: string) => ({
    value: mocks.settings[key] ?? null,
    isFetched: true,
    setValue: (value: string) => {
      mocks.writes.push([key, value]);
      return Promise.resolve(mocks.writeResult);
    },
  }),
}));
vi.mock("@/hooks/useSidebarAutoCollapse", () => ({
  useSidebarAutoCollapse: () => ({ autoCollapsed: false, onUserToggle: () => false }),
}));

import { useSidebarController } from "./useSidebarController";

interface FakePanel extends PanelImperativeHandle {
  ready: boolean;
  calls: string[];
}

/** A panel handle that throws until its group derived its constraints, like the library's. */
function fakePanel(collapsed: boolean, width = 300): FakePanel {
  let isCollapsed = collapsed;
  let size = collapsed ? 0 : width;
  const guard = (name: string): void => {
    if (!panel.ready) throw new Error(`${name} before the group is ready`);
    panel.calls.push(name);
  };
  const panel: FakePanel = {
    ready: false,
    calls: [],
    collapse: () => {
      guard("collapse");
      isCollapsed = true;
      size = 0;
    },
    expand: () => guard("expand"),
    getSize: () => {
      guard("getSize");
      return { asPercentage: size / 10, inPixels: size };
    },
    isCollapsed: () => {
      guard("isCollapsed");
      return isCollapsed;
    },
    resize: (next) => {
      guard("resize");
      isCollapsed = false;
      size = Number.parseFloat(String(next));
    },
  };
  return panel;
}

function mountController(isMobile: boolean) {
  return renderHook(({ mobile }: { mobile: boolean }) => useSidebarController(mobile), {
    initialProps: { mobile: isMobile },
  });
}

beforeEach(() => {
  mocks.settings = { sidebar_left_width: "300", sidebar_collapsed: "false" };
  mocks.writes = [];
  mocks.writeResult = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useSidebarController across a layout flip", () => {
  it("mounts the panel collapsed when the desktop state is collapsed", () => {
    mocks.settings.sidebar_collapsed = "true";
    const view = mountController(true);
    view.rerender({ mobile: false });
    expect(view.result.current.defaultLeftSize).toBe("0px");
  });

  it("mounts the panel at the stored width when the desktop state is expanded", () => {
    const view = mountController(true);
    view.rerender({ mobile: false });
    expect(view.result.current.defaultLeftSize).toBe("300px");
  });

  it("does not drive the panel until it reported its first size", () => {
    mocks.settings.sidebar_collapsed = "true";
    const view = mountController(true);
    const panel = fakePanel(true);
    view.result.current.sidebarPanelRef.current = panel;
    // The panel mounts with the desktop layout; its handle still throws.
    view.rerender({ mobile: false });
    expect(() => act(() => view.result.current.setCollapsed(false))).not.toThrow();
    expect(mocks.writes).toContainEqual(["sidebar_collapsed", "false"]);

    // Its first resize: the group is ready, the panel is driven.
    panel.ready = true;
    act(() => view.result.current.onSidebarResize());
    expect(panel.calls).toContain("isCollapsed");
  });

  it("does not put a panel back after a failed write once the phone layout took over", async () => {
    vi.useFakeTimers();
    mocks.writeResult = false;
    const view = mountController(false);
    const panel = fakePanel(false, 360);
    panel.ready = true;
    view.result.current.sidebarPanelRef.current = panel;
    act(() => view.result.current.handleLayoutChanged());
    // The phone layout unmounts the panel before the write answers.
    view.rerender({ mobile: true });
    panel.ready = false;
    panel.calls.length = 0;
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(mocks.writes).toContainEqual(["sidebar_left_width", "360"]);
    expect(panel.calls).toEqual([]);
  });
});

describe("useSidebarController with a docked phone sidebar", () => {
  it("starts expanded, collapses to the rail and keeps the drawer's state apart", () => {
    const view = renderHook(
      ({ docked }: { docked: boolean }) => useSidebarController(true, docked),
      { initialProps: { docked: true } },
    );
    expect(view.result.current.collapsed).toBe(false);

    act(() => view.result.current.setCollapsed(true));
    expect(view.result.current.collapsed).toBe(true);
    // A navigation closes the drawer, never a docked sidebar.
    act(() => view.result.current.closeMobileDrawer());
    expect(view.result.current.collapsed).toBe(true);
    act(() => view.result.current.setCollapsed(false));
    expect(view.result.current.collapsed).toBe(false);

    // Turned upright: the drawer, closed, whatever the docked sidebar showed.
    view.rerender({ docked: false });
    expect(view.result.current.collapsed).toBe(true);
    // Nothing reaches the desktop's persisted state.
    expect(mocks.writes).toEqual([]);
  });
});
