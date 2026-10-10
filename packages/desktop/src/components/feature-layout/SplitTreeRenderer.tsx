import { type ReactNode } from "react";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { LayoutNode } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore, type SplitPath } from "@/stores/feature-layout-store";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";

import { TabPane } from "./TabPane";
import type { FeatureTabActivationHandlers, FeatureTabs } from "./types";

interface SplitTreeRendererProps extends FeatureTabActivationHandlers {
  featureId: number;
  node: LayoutNode;
  /** Path from the root split node to the current `node`, in terms of child indices (0 / 1). */
  path: SplitPath;
  tabs: FeatureTabs;
  splitsEnabled?: boolean;
}

/** Panel sizes are float percentages; anything finer than this is rounding. */
const SIZE_EPSILON = 0.1;

function isSameSize(reported: number, current: number): boolean {
  return Math.abs(reported - current) < SIZE_EPSILON;
}

/**
 * Recursively renders a `LayoutNode` tree. Splits map to `ResizablePanelGroup`,
 * leaves to `<TabPane>`. Resize events bubble up to the store so sizes
 * persist across reloads.
 */
export function SplitTreeRenderer({
  featureId,
  node,
  path,
  tabs,
  onTerminalActivate,
  onEditorActivate,
  splitsEnabled = true,
}: SplitTreeRendererProps): ReactNode {
  const setSplitSizes = useFeatureLayoutStore((s) => s.setSplitSizes);

  if (node.type === "leaf") {
    return (
      <TabPane
        featureId={featureId}
        leaf={node}
        tabs={tabs}
        onTerminalActivate={onTerminalActivate}
        onEditorActivate={onEditorActivate}
        splitsEnabled={splitsEnabled}
      />
    );
  }

  const pathKey = path.join("-");
  const idA = `panel-${pathKey}-0`;
  const idB = `panel-${pathKey}-1`;
  const [a, b] = node.children;
  const [defaultA, defaultB] = node.sizes ?? [50, 50];

  // `onLayoutChanged` fires after the user releases (or keyboard-nudges) a
  // resize handle, and we persist the result so it survives reloads. It also
  // fires once on mount with the default sizes — that report changes nothing,
  // and must neither hold off agent reveals nor teach `autoShares` a size the
  // user never picked.
  const onLayoutChanged = (layout: Record<string, number>): void => {
    const sizeA = layout[idA];
    const sizeB = layout[idB];
    if (typeof sizeA !== "number" || typeof sizeB !== "number") return;
    if (isSameSize(sizeA, defaultA) && isSameSize(sizeB, defaultB)) return;
    noteUserLayoutChange(featureId);
    setSplitSizes(featureId, path, [sizeA, sizeB]);
  };

  return (
    <ResizablePanelGroup
      orientation={node.orientation}
      onLayoutChanged={onLayoutChanged}
      className="h-full"
    >
      <ResizablePanel id={idA} defaultSize={defaultA} minSize={10}>
        <SplitTreeRenderer
          featureId={featureId}
          node={a}
          path={[...path, 0]}
          tabs={tabs}
          onTerminalActivate={onTerminalActivate}
          onEditorActivate={onEditorActivate}
          splitsEnabled={splitsEnabled}
        />
      </ResizablePanel>
      {/* Transparent handle: the floating-block padding around each pane
          provides the visual gap, so the handle just needs to stay grabbable
          (its ::after pseudo gives a generous hit zone) without painting a
          gray divider line. */}
      <ResizableHandle className="bg-transparent" />
      <ResizablePanel id={idB} defaultSize={defaultB} minSize={10}>
        <SplitTreeRenderer
          featureId={featureId}
          node={b}
          path={[...path, 1]}
          tabs={tabs}
          onTerminalActivate={onTerminalActivate}
          onEditorActivate={onEditorActivate}
          splitsEnabled={splitsEnabled}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
