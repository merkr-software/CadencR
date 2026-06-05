import type { ReactNode } from "react";
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

export function TerminalSplitTree(props: TerminalSplitTreeProps): ReactNode {
  const { expectedCwd, node, onDismissWarning, onFocusPane, onRegisterPlaceholder, onRestartPane } =
    props;
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
  const handleClassName =
    node.orientation === "vertical"
      ? "!h-0.5 !w-full bg-[var(--terminal-panel-handle-bg)] hover:bg-[var(--terminal-panel-handle-bg-hover)] transition-colors"
      : "bg-[var(--terminal-panel-handle-bg)] hover:bg-[var(--terminal-panel-handle-bg-hover)] transition-colors";
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
}
