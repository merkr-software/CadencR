import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import type { LayoutNode } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

import { SplitTreeRenderer } from "./SplitTreeRenderer";
import type { FeatureTabs } from "./types";

let reportLayout: ((layout: Record<string, number>) => void) | undefined;
const resizePanel = vi.fn();
/** The panel's size as the group last laid it out, read before each resize. */
let panelSize = { asPercentage: 4, inPixels: 40 };
let reportPanelSize: ((size: { asPercentage: number; inPixels: number }) => void) | undefined;
/** Panels' laid-out lengths, by panel id: fractional, unlike `inPixels`. */
const panelLengths: Record<string, number> = {};
/** Panels mounted so far, by id: like the library, a panel hands over its element once. */
const mountedPanels = new Set<string>();

vi.mock("@/lib/auto-layout/auto-layout-controller", () => ({ noteUserLayoutChange: vi.fn() }));
/** Slots handed to the pop pane ("term"), oldest first. */
const slots: unknown[] = [];

vi.mock("./TabPane", () => ({
  TabPane: ({ leaf, slot }: { leaf: { id: string }; slot?: unknown }): null => {
    if (leaf.id === "term") slots.push(slot);
    return null;
  },
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChanged,
    "data-pop-motion": popMotion,
  }: {
    children: ReactNode;
    onLayoutChanged: (layout: Record<string, number>) => void;
    "data-pop-motion"?: boolean;
  }): ReactNode => {
    reportLayout = onLayoutChanged;
    return <div data-pop-motion={popMotion}>{children}</div>;
  },
  ResizablePanel: ({
    children,
    id,
    panelRef,
    elementRef,
    onResize,
  }: {
    children: ReactNode;
    id: string;
    panelRef?: { current: unknown };
    elementRef?: { current: unknown };
    onResize?: (size: { asPercentage: number; inPixels: number }) => void;
  }): ReactNode => {
    if (panelRef) panelRef.current = { resize: resizePanel, getSize: () => panelSize };
    if (onResize) reportPanelSize = onResize;
    if (!mountedPanels.has(id)) {
      mountedPanels.add(id);
      const length = (): number => panelLengths[id] ?? 0;
      if (elementRef)
        elementRef.current = {
          getBoundingClientRect: () => ({ width: length(), height: length() }),
        };
    }
    return children;
  },
  // Like the library's Separator: `aria-disabled` only while disabled.
  ResizableHandle: ({ disabled }: { disabled?: boolean }): ReactNode => (
    <div data-testid="handle" aria-disabled={disabled || undefined} />
  ),
}));

const FEATURE_ID = 3;

/** Fake timers that also drive animation frames. */
const FRAME_TIMERS: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"] = [
  "setTimeout",
  "clearTimeout",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

const split: LayoutNode = {
  type: "split",
  orientation: "horizontal",
  sizes: [62.5, 37.5],
  children: [
    { type: "leaf", id: "root", tabIds: ["agent"], activeTabId: "agent" },
    { type: "leaf", id: "side", tabIds: ["browser"], activeTabId: "browser" },
  ],
};

function splitTree(node: LayoutNode): ReactNode {
  return (
    <SplitTreeRenderer featureId={FEATURE_ID} node={node} path={[]} tabs={{} as FeatureTabs} />
  );
}

function renderSplit(node: LayoutNode): ReturnType<typeof render> {
  return render(splitTree(node));
}

describe("SplitTreeRenderer", () => {
  beforeEach(() => {
    reportLayout = undefined;
    reportPanelSize = undefined;
    resizePanel.mockClear();
    slots.length = 0;
    panelSize = { asPercentage: 4, inPixels: 40 };
    mountedPanels.clear();
    for (const id of Object.keys(panelLengths)) delete panelLengths[id];
    document.documentElement.dataset.animations = "off";
    vi.mocked(noteUserLayoutChange).mockClear();
    useFeatureLayoutStore.setState({ features: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.animations;
  });

  it("ignores the mount-time report of the sizes it already has", () => {
    renderSplit(split);
    reportLayout?.({ "panel--0": 62.5, "panel--1": 37.5 });

    expect(noteUserLayoutChange).not.toHaveBeenCalled();
    expect(useFeatureLayoutStore.getState().features[FEATURE_ID]).toBeUndefined();
  });

  it("ignores the mount-time report of the default 50/50 split", () => {
    renderSplit({ ...split, sizes: undefined });
    reportLayout?.({ "panel--0": 50, "panel--1": 50 });

    expect(noteUserLayoutChange).not.toHaveBeenCalled();
    expect(useFeatureLayoutStore.getState().features[FEATURE_ID]).toBeUndefined();
  });

  it("records a real resize as a manual layout change", () => {
    useFeatureLayoutStore.getState().setState(FEATURE_ID, {
      version: 1,
      splitRoot: split,
      focusedPaneId: null,
      appliedLayoutId: null,
    });
    renderSplit(split);
    reportLayout?.({ "panel--0": 70, "panel--1": 30 });

    expect(noteUserLayoutChange).toHaveBeenCalledWith(FEATURE_ID);
    const root = useFeatureLayoutStore.getState().features[FEATURE_ID]?.splitRoot;
    expect(root?.type === "split" ? root.sizes : null).toEqual([70, 30]);
  });

  describe("pop pane", () => {
    const popSplit: LayoutNode = {
      ...split,
      orientation: "vertical",
      children: [
        split.children[0],
        { type: "leaf", id: "term", tabIds: ["terminal"], activeTabId: "terminal", pop: true },
      ],
    };
    const seed = (focusedPaneId: string, splitRoot: LayoutNode = popSplit): void =>
      useFeatureLayoutStore.getState().setState(FEATURE_ID, {
        version: 1,
        splitRoot,
        focusedPaneId,
        appliedLayoutId: null,
      });
    const focus = (paneId: string): void =>
      act(() => useFeatureLayoutStore.getState().setFocusedPane(FEATURE_ID, paneId));

    it("folds to its header while another pane has focus, and pops to its share on focus", () => {
      seed("root");
      renderSplit(popSplit);
      expect(resizePanel).toHaveBeenLastCalledWith("40px");

      act(() => useFeatureLayoutStore.getState().setFocusedPane(FEATURE_ID, "term"));
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");

      act(() => useFeatureLayoutStore.getState().setFocusedPane(FEATURE_ID, "root"));
      expect(resizePanel).toHaveBeenLastCalledWith("40px");
    });

    it("disables its resize handle while folded and enables it once open", () => {
      seed("root");
      const view = renderSplit(popSplit);
      const handle = view.getByTestId("handle");
      expect(handle.getAttribute("aria-disabled")).toBe("true");

      focus("term");
      expect(handle.hasAttribute("aria-disabled")).toBe(false);
    });

    it("folds again when the group lays the folded panel out at another size", () => {
      seed("root");
      renderSplit(popSplit);
      resizePanel.mockClear();

      panelLengths["panel--1"] = 114;
      reportPanelSize?.({ asPercentage: 10, inPixels: 114 });
      expect(resizePanel).toHaveBeenCalledWith("40px");

      resizePanel.mockClear();
      panelLengths["panel--1"] = 40.2;
      reportPanelSize?.({ asPercentage: 4, inPixels: 40 });
      expect(resizePanel).not.toHaveBeenCalled();
    });

    it("folds again when a window resize grows it by less than the whole pixel reported", () => {
      seed("root");
      renderSplit(popSplit);
      resizePanel.mockClear();

      // The group reports `offsetHeight`; the card already sits off the edge
      // the panes beside it line up on.
      panelLengths["panel--1"] = 40.5;
      reportPanelSize?.({ asPercentage: 4, inPixels: 40 });
      expect(resizePanel).toHaveBeenCalledWith("40px");
    });

    it("measures the panel that pops, even when it starts popping after mount", () => {
      const pinned: LayoutNode = {
        ...popSplit,
        children: [
          split.children[0],
          { type: "leaf", id: "term", tabIds: ["terminal"], activeTabId: "terminal" },
        ],
      };
      seed("root", pinned);
      const view = renderSplit(pinned);
      panelLengths["panel--0"] = 760;
      panelLengths["panel--1"] = 40.5;

      seed("root");
      view.rerender(splitTree(popSplit));
      resizePanel.mockClear();
      reportPanelSize?.({ asPercentage: 4, inPixels: 40 });
      expect(resizePanel).toHaveBeenCalledWith("40px");

      resizePanel.mockClear();
      panelLengths["panel--1"] = 40;
      reportPanelSize?.({ asPercentage: 4, inPixels: 40 });
      expect(resizePanel).not.toHaveBeenCalled();
    });

    it("with animations on, slides the pane in at its open size, then lets it fill the panel", () => {
      vi.useFakeTimers();
      document.documentElement.dataset.animations = "on";
      seed("root");
      const { container } = render(
        <SplitTreeRenderer
          featureId={FEATURE_ID}
          node={popSplit}
          path={[]}
          tabs={{} as FeatureTabs}
        />,
      );
      expect(slots.at(-1)).toMatchObject({ popCollapsed: true, slidingPx: null });

      // 40px is 4% of a 1000px group: the 37.5% share opens at 375px.
      focus("term");
      expect(slots.at(-1)).toMatchObject({ popCollapsed: false, slidingPx: 375 });
      expect(container.querySelector("[data-pop-motion]")).not.toBeNull();

      act(() => vi.advanceTimersByTime(270));
      expect(slots.at(-1)).toMatchObject({ popCollapsed: false, slidingPx: null });
      expect(container.querySelector("[data-pop-motion]")).toBeNull();

      // Folding slides out from the size the pane had, then shows the header.
      panelSize = { asPercentage: 37.5, inPixels: 375 };
      focus("root");
      expect(slots.at(-1)).toMatchObject({ popCollapsed: false, slidingPx: 375 });
      act(() => vi.advanceTimersByTime(270));
      expect(slots.at(-1)).toMatchObject({ popCollapsed: true, slidingPx: null });
    });

    it("with animations on, resizes the sliding panel two frames after the toggle", () => {
      vi.useFakeTimers({ toFake: FRAME_TIMERS });
      document.documentElement.dataset.animations = "on";
      seed("root");
      renderSplit(popSplit);
      resizePanel.mockClear();

      focus("term");
      expect(slots.at(-1)).toMatchObject({ slidingPx: 375 });
      expect(resizePanel).not.toHaveBeenCalled();
      act(() => vi.advanceTimersToNextFrame());
      expect(resizePanel).not.toHaveBeenCalled();
      act(() => vi.advanceTimersToNextFrame());
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
    });

    it("holds the pane for the whole transition, timed from the resize", () => {
      vi.useFakeTimers({ toFake: FRAME_TIMERS });
      document.documentElement.dataset.animations = "on";
      seed("root");
      renderSplit(popSplit);
      focus("term");
      act(() => vi.advanceTimersToNextFrame());
      act(() => vi.advanceTimersToNextFrame());
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
      // The hold ends a full transition after the resize, frames included.
      act(() => vi.advanceTimersByTime(219));
      expect(slots.at(-1)).toMatchObject({ slidingPx: 375 });
      act(() => vi.advanceTimersByTime(1));
      expect(slots.at(-1)).toMatchObject({ slidingPx: null });
    });

    it("drops a deferred resize when focus flips back, or the split unmounts, first", () => {
      vi.useFakeTimers({ toFake: FRAME_TIMERS });
      document.documentElement.dataset.animations = "on";
      seed("root");
      const view = renderSplit(popSplit);
      resizePanel.mockClear();

      focus("term");
      act(() => vi.advanceTimersToNextFrame());
      focus("root");
      act(() => vi.advanceTimersToNextFrame());
      act(() => vi.advanceTimersToNextFrame());
      expect(resizePanel).not.toHaveBeenCalledWith("37.5%");
      expect(resizePanel).toHaveBeenLastCalledWith("40px");
      act(() => vi.advanceTimersByTime(220));
      expect(slots.at(-1)).toMatchObject({ popCollapsed: true, slidingPx: null });
      expect(view.container.querySelector("[data-pop-motion]")).toBeNull();

      resizePanel.mockClear();
      focus("term");
      view.unmount();
      act(() => vi.advanceTimersByTime(300));
      expect(resizePanel).not.toHaveBeenCalled();
    });

    it("still ends a slide whose deferred resize a re-run replaced", () => {
      vi.useFakeTimers({ toFake: FRAME_TIMERS });
      document.documentElement.dataset.animations = "on";
      seed("root");
      const view = renderSplit(popSplit);
      focus("term");
      act(() => vi.advanceTimersToNextFrame());

      // The pane measures its header between the two frames: not a toggle.
      act(() => (slots.at(-1) as { onFoldedSize: (px: number) => void }).onFoldedSize(36));
      act(() => vi.advanceTimersByTime(220));
      expect(slots.at(-1)).toMatchObject({ slidingPx: null });
      expect(view.container.querySelector("[data-pop-motion]")).toBeNull();
    });

    it("opens a pane unpinned mid-slide at its share and ends the slide", () => {
      vi.useFakeTimers({ toFake: FRAME_TIMERS });
      document.documentElement.dataset.animations = "on";
      seed("root");
      const view = renderSplit(popSplit);
      focus("term");
      act(() => vi.advanceTimersToNextFrame());

      act(() => useFeatureLayoutStore.getState().setPanePop(FEATURE_ID, "term", false));
      view.rerender(splitTree(useFeatureLayoutStore.getState().features[FEATURE_ID]!.splitRoot));
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
      expect(view.container.querySelector("[data-pop-motion]")).toBeNull();
      act(() => vi.advanceTimersByTime(300));
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
    });

    it("keeps the open size when a slide reverses midway", () => {
      vi.useFakeTimers();
      document.documentElement.dataset.animations = "on";
      seed("root");
      renderSplit(popSplit);
      focus("term");
      expect(slots.at(-1)).toMatchObject({ slidingPx: 375 });

      // Mid-transition the panel measures a partial size against its target share.
      panelSize = { asPercentage: 37.5, inPixels: 200 };
      act(() => vi.advanceTimersByTime(100));
      focus("root");
      expect(slots.at(-1)).toMatchObject({ popCollapsed: false, slidingPx: 375 });

      panelSize = { asPercentage: 4, inPixels: 250 };
      focus("term");
      expect(slots.at(-1)).toMatchObject({ slidingPx: 375 });
    });

    it("lets a fold slide run instead of re-folding it every frame", () => {
      vi.useFakeTimers();
      document.documentElement.dataset.animations = "on";
      seed("term");
      renderSplit(popSplit);
      panelSize = { asPercentage: 37.5, inPixels: 375 };
      focus("root");
      resizePanel.mockClear();

      reportPanelSize?.({ asPercentage: 20, inPixels: 200 });
      expect(resizePanel).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(270));
      reportPanelSize?.({ asPercentage: 10, inPixels: 114 });
      expect(resizePanel).toHaveBeenCalledWith("40px");
    });

    it("opens a pane showing a native view without sliding", () => {
      document.documentElement.dataset.animations = "on";
      const browserSplit: LayoutNode = {
        ...popSplit,
        children: [
          split.children[0],
          { type: "leaf", id: "term", tabIds: ["browser"], activeTabId: "browser", pop: true },
        ],
      };
      seed("root", browserSplit);
      renderSplit(browserSplit);
      focus("term");
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
      expect(slots.at(-1)).toMatchObject({ popCollapsed: false, slidingPx: null });
    });

    it("opens a folded pane at its share once it stops popping", () => {
      seed("root");
      const view = renderSplit(popSplit);
      expect(resizePanel).toHaveBeenLastCalledWith("40px");

      act(() => useFeatureLayoutStore.getState().setPanePop(FEATURE_ID, "term", false));
      view.rerender(splitTree(useFeatureLayoutStore.getState().features[FEATURE_ID]!.splitRoot));
      expect(resizePanel).toHaveBeenLastCalledWith("37.5%");
    });

    it("does not slide a pane that starts popping open, when its sibling stops", () => {
      vi.useFakeTimers();
      document.documentElement.dataset.animations = "on";
      seed("root");
      const view = renderSplit(popSplit);

      // The open root side becomes the pop pane; the folded side opens at its share.
      const swapped: LayoutNode = {
        ...popSplit,
        children: [
          { type: "leaf", id: "agentp", tabIds: ["agent"], activeTabId: "agent", pop: true },
          { type: "leaf", id: "term", tabIds: ["terminal"], activeTabId: "terminal" },
        ],
      };
      act(() => seed("agentp", swapped));
      view.rerender(splitTree(swapped));
      expect(slots.at(-1)).toMatchObject({ pops: false, popCollapsed: false });
      expect(resizePanel).toHaveBeenCalledWith("37.5%");
      expect(view.container.querySelector("[data-pop-motion]")).toBeNull();
    });

    it("opens at a usable share even when stored at its header size", () => {
      seed("root", { ...popSplit, sizes: [97, 3] });
      renderSplit({ ...popSplit, sizes: [97, 3] });
      focus("term");
      expect(resizePanel).toHaveBeenLastCalledWith("10%");
    });

    it("folds to the header size the pane measured", () => {
      seed("root");
      renderSplit(popSplit);
      const slot = slots.at(-1) as { onFoldedSize: (px: number) => void };
      act(() => slot.onFoldedSize(36.4));
      expect(resizePanel).toHaveBeenLastCalledWith("36.4px");
    });

    it("never stores the folded header as the split's size", () => {
      seed("root");
      renderSplit(popSplit);
      reportLayout?.({ "panel--0": 99, "panel--1": 1 });

      expect(noteUserLayoutChange).not.toHaveBeenCalled();
      const root = useFeatureLayoutStore.getState().features[FEATURE_ID]?.splitRoot;
      expect(root?.type === "split" ? root.sizes : null).toEqual([62.5, 37.5]);
    });
  });
});
