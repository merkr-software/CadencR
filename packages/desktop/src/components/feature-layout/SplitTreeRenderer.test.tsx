import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import type { LayoutNode } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

import { SplitTreeRenderer } from "./SplitTreeRenderer";
import type { FeatureTabs } from "./types";

let reportLayout: ((layout: Record<string, number>) => void) | undefined;

vi.mock("@/lib/auto-layout/auto-layout-controller", () => ({ noteUserLayoutChange: vi.fn() }));
vi.mock("./TabPane", () => ({ TabPane: (): null => null }));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChanged,
  }: {
    children: ReactNode;
    onLayoutChanged: (layout: Record<string, number>) => void;
  }): ReactNode => {
    reportLayout = onLayoutChanged;
    return children;
  },
  ResizablePanel: ({ children }: { children: ReactNode }): ReactNode => children,
  ResizableHandle: (): null => null,
}));

const FEATURE_ID = 3;

const split: LayoutNode = {
  type: "split",
  orientation: "horizontal",
  sizes: [62.5, 37.5],
  children: [
    { type: "leaf", id: "root", tabIds: ["agent"], activeTabId: "agent" },
    { type: "leaf", id: "side", tabIds: ["browser"], activeTabId: "browser" },
  ],
};

function renderSplit(node: LayoutNode): void {
  render(
    <SplitTreeRenderer featureId={FEATURE_ID} node={node} path={[]} tabs={{} as FeatureTabs} />,
  );
}

describe("SplitTreeRenderer", () => {
  beforeEach(() => {
    reportLayout = undefined;
    vi.mocked(noteUserLayoutChange).mockClear();
    useFeatureLayoutStore.setState({ features: {} });
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
});
