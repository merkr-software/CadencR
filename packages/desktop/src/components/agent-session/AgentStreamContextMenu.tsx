import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyAs, type ExportFormat } from "@/lib/markdown-export";
import { fragmentToMarkdown } from "@/lib/selection-to-markdown";
import { RotateCcwIcon, GitBranchIcon } from "lucide-react";
import { type AgentBlockData } from "../AgentBlock";
import { useMessageBranchActions } from "./use-message-branch-actions";

type CopyScope = "selection-or-block" | "block";

interface AgentStreamContextMenuProps {
  block: AgentBlockData;
  children: React.ReactNode;
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
 */
function AgentStreamContextMenu({ block, children }: AgentStreamContextMenuProps) {
  const selectionMarkdownRef = useRef<string>("");
  const savedRangesRef = useRef<Range[] | null>(null);
  const isRestoringRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  function applySavedRanges() {
    const ranges = savedRangesRef.current;
    if (!ranges || ranges.length === 0) return;
    const live = window.getSelection();
    if (!live) return;
    isRestoringRef.current = true;
    live.removeAllRanges();
    for (const r of ranges) live.addRange(r);
    // The `selectionchange` event for our own modification fires async; clear
    // the guard on the next tick.
    setTimeout(() => {
      isRestoringRef.current = false;
    }, 0);
  }

  function captureOnRightMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 2) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      selectionMarkdownRef.current = "";
      savedRangesRef.current = null;
      return;
    }
    // Reconstruct markdown from the selected DOM fragment so that list
    // bullets, headings, code fences, link URLs, emphasis markers etc. are
    // preserved (Selection.toString() drops all of them).
    const ranges: Range[] = [];
    let markdown = "";
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      ranges.push(range.cloneRange());
      markdown += fragmentToMarkdown(range.cloneContents());
    }
    // `fragmentToMarkdown` already trims; fall back to plain selection text
    // only when the walker produced nothing (e.g. selection of a bare <hr>).
    selectionMarkdownRef.current = markdown || sel.toString();
    savedRangesRef.current = ranges;
    // Initial restore after WebKit's default deselection on right-click.
    requestAnimationFrame(applySavedRanges);
  }

  // While the menu is open, re-apply the saved selection any time the
  // browser collapses it (Radix focusing a menu item triggers this).
  useEffect(() => {
    if (!menuOpen) {
      savedRangesRef.current = null;
      return;
    }
    function onSelectionChange() {
      if (isRestoringRef.current) return;
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed) return; // user has a live selection
      applySavedRanges();
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [menuOpen]);

  function copy(format: ExportFormat, scope: CopyScope) {
    const sel = selectionMarkdownRef.current.trim();
    const text = scope === "block" || !sel ? block.content : sel;
    return copyAs(format, text);
  }

  // Rewind/Fork target a persisted user message; the shared hook resolves the
  // message id and gates on session liveness.
  const { canBranch, rewind, fork } = useMessageBranchActions(block);

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div onMouseDownCapture={captureOnRightMouseDown}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copy("plain", "selection-or-block")}>
          Copy
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => void copy("markdown", "selection-or-block")}>
              Markdown
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copy("slack", "selection-or-block")}>
              Slack mrkdwn
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copy("plain", "selection-or-block")}>
              Plain text
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copy("markdown", "block")}>
          Copy block as Markdown
        </ContextMenuItem>
        {canBranch && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={rewind}>
              <RotateCcwIcon className="size-4" />
              Rewind to here
            </ContextMenuItem>
            <ContextMenuItem onSelect={fork}>
              <GitBranchIcon className="size-4" />
              Fork from here
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default memo(AgentStreamContextMenu);
