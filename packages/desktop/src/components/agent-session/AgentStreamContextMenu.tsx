import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ContextMenuActionItem,
  ContextMenuSubActionTrigger,
} from "@/components/ContextMenuActionItem";
import { copyAs, type ExportFormat } from "@/lib/markdown-export";
import { rangeToEmailHtml } from "@/lib/email-export";
import {
  captureSelectionSnapshot,
  selectionSnapshotToMarkdown,
  type SelectionSnapshot,
} from "@/lib/selection-to-markdown";
import { ClipboardCopyIcon, FileTextIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { type AgentBlockData } from "../AgentBlock";
import { useMessageBranchActions } from "./use-message-branch-actions";
import { useTouchSafeTriggerProps } from "@/hooks/useTouchSafeTriggerProps";
import { COPY_AS_FORMATS } from "./CopyAsMenu";

type CopyScope = "selection-or-block" | "block";

interface AgentStreamContextMenuProps {
  block: AgentBlockData;
  children: React.ReactNode;
  copyContent?: string;
  branchingEnabled?: boolean;
}

interface AgentStreamMenuItemsProps {
  branchingEnabled: boolean;
  block: AgentBlockData;
  copy: (format: ExportFormat, scope: CopyScope) => void;
}

function applySavedRanges(
  savedSelection: { current: SelectionSnapshot | null },
  isRestoring: { current: boolean },
): void {
  const ranges = savedSelection.current?.ranges;
  const live = window.getSelection();
  if (!ranges?.length || !live) return;
  isRestoring.current = true;
  live.removeAllRanges();
  for (const range of ranges) live.addRange(range);
  setTimeout(() => {
    isRestoring.current = false;
  }, 0);
}

/**
 * Per-block context menu for the agent stream. Wraps each `AgentStreamItem`.
 *
 * Selection persistence — the hard part:
 *
 *   - On right-click `mousedown`, snapshot both the selection text AND the
 *     underlying `Range` objects. WebKit clears the visual selection on the
 *     right-click default action when the click lands outside the highlight,
 *     so reading in `onContextMenu` would already be too late.
 *   - WebKit *also* clears the selection every time Radix moves DOM focus to
 *     a hovered/keyboard-focused menu item. To keep the highlight visible
 *     while the menu is open, we attach a `selectionchange` listener that
 *     re-applies the saved ranges whenever the selection collapses back to
 *     empty, gated by an `isRestoringRef` flag to avoid the obvious loop.
 *   - When the selection is empty at right-click time, the menu items fall
 *     back to operating on the whole block's raw markdown (`block.content`).
 *
 * Wrapping the per-item Virtuoso row (rather than the scroller itself)
 * keeps `block` correctly bound: Virtuoso recycles DOM nodes, so a single
 * outer trigger would drift across blocks during scroll.
 *
 * Touch devices get no menu (see `useTouchSafeTriggerProps`); the copy
 * formats they need live on the message action rows (`CopyAsMenu`).
 */
function AgentStreamContextMenu({
  block,
  children,
  copyContent = block.content,
  branchingEnabled = true,
}: AgentStreamContextMenuProps) {
  const blockRangeRef = useRef<Range | null>(null);
  const savedSelectionRef = useRef<SelectionSnapshot | null>(null);
  const isRestoringRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerProps = useTouchSafeTriggerProps();

  function captureOnRightMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 2) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      savedSelectionRef.current = null;
      const blockRange = document.createRange();
      blockRange.selectNodeContents(e.currentTarget);
      blockRangeRef.current = blockRange;
      return;
    }
    savedSelectionRef.current = captureSelectionSnapshot(sel);
    // Initial restore after WebKit's default deselection on right-click.
    requestAnimationFrame(() => applySavedRanges(savedSelectionRef, isRestoringRef));
  }

  // While the menu is open, re-apply the saved selection any time the
  // browser collapses it (Radix focusing a menu item triggers this).
  useEffect(() => {
    if (!menuOpen) {
      savedSelectionRef.current = null;
      return;
    }
    function onSelectionChange() {
      if (isRestoringRef.current) return;
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed) return; // user has a live selection
      applySavedRanges(savedSelectionRef, isRestoringRef);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [menuOpen]);

  const copy = useCallback(
    (format: ExportFormat, scope: CopyScope): void => {
      const selection = savedSelectionRef.current;
      const useBlock = scope === "block" || !selection;
      const text = useBlock ? copyContent : selectionSnapshotToMarkdown(selection);
      const ranges = useBlock
        ? blockRangeRef.current
          ? [blockRangeRef.current]
          : []
        : selection.ranges;
      const emailHtml =
        format === "email" ? ranges.map((range) => rangeToEmailHtml(range)).join("") : undefined;
      void copyAs(format, text, emailHtml);
    },
    [copyContent],
  );

  // Rewind/Fork target a persisted user message; the shared hook resolves the
  // message id and gates on session liveness.
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild {...triggerProps}>
        <div onMouseDownCapture={captureOnRightMouseDown}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <AgentStreamMenuItems branchingEnabled={branchingEnabled} block={block} copy={copy} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const AgentStreamMenuItems = memo(function AgentStreamMenuItems({
  branchingEnabled,
  block,
  copy,
}: AgentStreamMenuItemsProps) {
  return (
    <>
      <ContextMenuActionItem
        icon={ClipboardCopyIcon}
        shortcutKeys={["mod", "c"]}
        onSelect={() => copy("plain", "selection-or-block")}
      >
        Copy
      </ContextMenuActionItem>
      <ContextMenuSub>
        <ContextMenuSubActionTrigger icon={ClipboardCopyIcon}>Copy as</ContextMenuSubActionTrigger>
        <ContextMenuSubContent>
          {COPY_AS_FORMATS.map(({ format, label, icon }) => (
            <ContextMenuActionItem
              key={format}
              icon={icon}
              onSelect={() => copy(format, "selection-or-block")}
            >
              {label}
            </ContextMenuActionItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuActionItem icon={FileTextIcon} onSelect={() => copy("markdown", "block")}>
        Copy block as Markdown
      </ContextMenuActionItem>
      {branchingEnabled && <AgentStreamBranchItems block={block} />}
    </>
  );
});

const AgentStreamBranchItems = memo(function AgentStreamBranchItems({
  block,
}: {
  block: AgentBlockData;
}) {
  const { canBranch, rewind, fork } = useMessageBranchActions(block);
  if (!canBranch) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuActionItem icon={RotateCcwIcon} onSelect={rewind}>
        Rewind to here
      </ContextMenuActionItem>
      <ContextMenuActionItem icon={GitBranchIcon} onSelect={fork}>
        Fork from here
      </ContextMenuActionItem>
    </>
  );
});

export default memo(AgentStreamContextMenu);
