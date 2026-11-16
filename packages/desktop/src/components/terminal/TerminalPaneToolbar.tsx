import { memo } from "react";
import { SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { SplitOrientation } from "@/hooks/useTerminalState";

const ICON_BTN =
  "flex size-6 items-center justify-center rounded text-[var(--terminal-panel-icon)] transition-colors hover:bg-[var(--terminal-panel-icon-bg-hover)] hover:text-[var(--terminal-panel-icon-hover)]";

interface TerminalPaneToolbarProps {
  onSplit: (orientation: SplitOrientation) => void;
  onClose: () => void;
  canClose: boolean;
}

/** Floating split/close actions pinned to the top-right of the terminal panel. */
export const TerminalPaneToolbar = memo(function TerminalPaneToolbar({
  onSplit,
  onClose,
  canClose,
}: TerminalPaneToolbarProps) {
  // Labels follow the registry and the pane context menu: `"horizontal"` is
  // `terminal-split-h` ("Split horizontal"), `"vertical"` is `-v`.
  const splitHorizontalKeys = useShortcutKeys("terminal-split-h");
  const splitVerticalKeys = useShortcutKeys("terminal-split-v");
  return (
    <div className="absolute right-2 top-1 z-10 flex items-center gap-0.5">
      <ShortcutTooltip label="Split horizontal" keys={splitHorizontalKeys}>
        <button
          type="button"
          aria-label="Split terminal horizontally"
          onClick={() => onSplit("horizontal")}
          className={ICON_BTN}
        >
          <SplitSquareHorizontal className="size-3.5" />
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Split vertical" keys={splitVerticalKeys} alignRight>
        <button
          type="button"
          aria-label="Split terminal vertically"
          onClick={() => onSplit("vertical")}
          className={ICON_BTN}
        >
          <SplitSquareVertical className="size-3.5" />
        </button>
      </ShortcutTooltip>
      {canClose && (
        <ShortcutTooltip label="Close terminal" alignRight>
          <button
            type="button"
            aria-label="Close terminal pane"
            onClick={onClose}
            className={ICON_BTN}
          >
            <X className="size-3" />
          </button>
        </ShortcutTooltip>
      )}
    </div>
  );
});
