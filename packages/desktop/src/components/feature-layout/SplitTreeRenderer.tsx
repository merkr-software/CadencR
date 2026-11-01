import { type ReactNode } from "react";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { LayoutNode, LayoutSplit } from "@/stores/feature-layout-schema";
import {
  useFeatureLayoutStore,
  useFocusedPaneId,
  type SplitPath,
} from "@/stores/feature-layout-store";
import { storedSplitPath } from "@/stores/feature-layout-tree";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";

import { usePopPanel } from "./use-pop-panel";
import { TabPane } from "./TabPane";
import type { FeatureTabActivationHandlers, FeatureTabs, PaneSlot } from "./types";

interface SplitTreeRendererProps extends FeatureTabActivationHandlers {
  featureId: number;
  node: LayoutNode;
  /** Path from the root split node to the current `node`, in terms of child indices (0 / 1). */
  path: SplitPath;
  tabs: FeatureTabs;
  splitsEnabled?: boolean;
  /** Trailing controls for the root pane's strip (see `FeatureLayoutShell`). */
  rootStripActions?: ReactNode;
  /** Where `node` sits in its parent split; absent for the tree's root node. */
  slot?: PaneSlot;
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
export function SplitTreeRenderer(props: SplitTreeRendererProps): ReactNode {
  const { node } = props;
  if (node.type === "split") return <SplitRenderer {...props} node={node} />;
  return (
    <TabPane
      featureId={props.featureId}
      leaf={node}
      tabs={props.tabs}
      onTerminalActivate={props.onTerminalActivate}
      onEditorActivate={props.onEditorActivate}
      splitsEnabled={props.splitsEnabled ?? true}
      rootStripActions={props.rootStripActions}
      slot={props.slot}
    />
  );
}

function SplitRenderer({
  featureId,
  node,
  path,
  ...childProps
}: SplitTreeRendererProps & { node: LayoutSplit }): ReactNode {
  const setSplitSizes = useFeatureLayoutStore((s) => s.setSplitSizes);
  const focusedPaneId = useFocusedPaneId(featureId);
  const pop = usePopPanel(node, focusedPaneId);

  const pathKey = path.join("-");
  const ids = [`panel-${pathKey}-0`, `panel-${pathKey}-1`] as const;
  const [defaultA, defaultB] = node.sizes ?? [50, 50];

  // `onLayoutChanged` fires after the user releases (or keyboard-nudges) a
  // resize handle, and we persist the result so it survives reloads. It also
  // fires once on mount with the default sizes — that report changes nothing,
  // and must neither hold off agent reveals nor teach `autoShares` a size the
  // user never picked. A folded pop pane's header is not a size either: the
  // split keeps the share the pane pops back to.
  const onLayoutChanged = (layout: Record<string, number>): void => {
    const sizeA = layout[ids[0]];
    const sizeB = layout[ids[1]];
    if (typeof sizeA !== "number" || typeof sizeB !== "number") return;
    if (pop.folded) return;
    if (isSameSize(sizeA, defaultA) && isSameSize(sizeB, defaultB)) return;
    noteUserLayoutChange(featureId);
    // `node` may come from a view that hid an unavailable plugin pane; size
    // the split it stands for in the stored layout.
    setSplitSizes(featureId, storedSplitPath(node, path), [sizeA, sizeB]);
  };

  const renderChild = (index: 0 | 1): ReactNode => {
    const popping = pop.index === index;
    return (
      <ResizablePanel
        id={ids[index]}
        defaultSize={index === 0 ? defaultA : defaultB}
        minSize={popping ? pop.foldedSize : 10}
        panelRef={pop.panelRefs[index]}
        elementRef={pop.elementRefs[index]}
        onResize={popping ? pop.onResize : undefined}
        // A sliding pop pane is laid out at its open size inside the moving
        // panel: anchor it here and clip what is not uncovered yet.
        className={popping ? "relative" : undefined}
        style={popping ? { overflow: "hidden" } : undefined}
      >
        <SplitTreeRenderer
          {...childProps}
          featureId={featureId}
          node={node.children[index]}
          path={[...path, index]}
          slot={{
            orientation: node.orientation,
            index,
            pops: popping,
            popCollapsed: popping && pop.collapsed,
            slidingPx: popping ? pop.slidingPx : null,
            onFoldedSize: pop.onFoldedSize,
          }}
        />
      </ResizablePanel>
    );
  };

  return (
    <ResizablePanelGroup
      orientation={node.orientation}
      onLayoutChanged={onLayoutChanged}
      data-pop-motion={pop.slidingPx !== null || undefined}
      className="h-full"
    >
      {renderChild(0)}
      {/* Transparent handle: the floating-block padding around each pane
          provides the visual gap, so the handle just needs to stay grabbable
          (its ::after pseudo gives a generous hit zone) without painting a
          gray divider line. A folded pop pane opens by click, not by drag:
          its disabled handle shows nothing and takes no pointer. */}
      <ResizableHandle className="bg-transparent" disabled={pop.folded} />
      {renderChild(1)}
    </ResizablePanelGroup>
  );
}
