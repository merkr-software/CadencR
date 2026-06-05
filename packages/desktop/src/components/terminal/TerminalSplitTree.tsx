import { memo, useMemo, type ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { SplitNode } from "@/hooks/useTerminalState";
import { PaneSlotPlaceholder } from "./PaneSlotPlaceholder";

interface TerminalSplitTreeProps {
  expectedCwd: string | null;
  node: SplitNode;
  onDismissWarning: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onRegisterPlaceholder: (id: string, el: HTMLDivElement | null) => void;
  onRestartPane: (paneId: string) => void;
}

export const TerminalSplitTree = memo(function TerminalSplitTree(
  props: TerminalSplitTreeProps,
): ReactNode {
  const { expectedCwd, node, onDismissWarning, onFocusPane, onRegisterPlaceholder, onRestartPane } =
    props;
  const splitOrientation = node.type === "leaf" ? null : node.orientation;
  const handleClassName = useMemo(
    () =>
      splitOrientation === "vertical"
        ? "!h-0.5 !w-full bg-[var(--terminal-panel-handle-bg)] hover:bg-[var(--terminal-panel-handle-bg-hover)] transition-colors"
        : "bg-[var(--terminal-panel-handle-bg)] hover:bg-[var(--terminal-panel-handle-bg-hover)] transition-colors",
    [splitOrientation],
  );
  if (node.type === "leaf") {
    return (
      <PaneSlotPlaceholder
        leaf={node}
        expectedCwd={expectedCwd}
        registerPlaceholder={onRegisterPlaceholder}
        onFocus={onFocusPane}
        onRestart={onRestartPane}
        onDismiss={onDismissWarning}
      />
    );
  }
  const [a, b] = node.children;
  return (
    <ResizablePanelGroup orientation={node.orientation} className="h-full">
      <ResizablePanel minSize={10}>
        <TerminalSplitTree {...props} node={a} />
      </ResizablePanel>
      <ResizableHandle className={handleClassName} />
      <ResizablePanel minSize={10}>
        <TerminalSplitTree {...props} node={b} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}, areTerminalSplitTreePropsEqual);

TerminalSplitTree.displayName = "TerminalSplitTree";

function areTerminalSplitTreePropsEqual(
  prev: TerminalSplitTreeProps,
  next: TerminalSplitTreeProps,
): boolean {
  return (
    prev.expectedCwd === next.expectedCwd &&
    prev.node === next.node &&
    prev.onDismissWarning === next.onDismissWarning &&
    prev.onFocusPane === next.onFocusPane &&
    prev.onRegisterPlaceholder === next.onRegisterPlaceholder &&
    prev.onRestartPane === next.onRestartPane
  );
}
