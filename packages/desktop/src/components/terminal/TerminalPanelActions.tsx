import { memo } from "react";
import { SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import type { SplitOrientation } from "@/hooks/useTerminalState";

const ICON_BTN =
  "flex size-6 items-center justify-center rounded text-[var(--terminal-panel-icon)] transition-colors hover:bg-[var(--terminal-panel-icon-bg-hover)] hover:text-[var(--terminal-panel-icon-hover)]";

interface TerminalPanelActionsProps {
  hasLeaves: boolean;
  onClose: () => void;
  onSplit: (orientation: SplitOrientation) => void;
}

export const TerminalPanelActions = memo(function TerminalPanelActions({
  hasLeaves,
  onClose,
  onSplit,
}: TerminalPanelActionsProps): React.ReactNode {
  return (
    <div className="absolute right-2 top-1 z-10 flex items-center gap-0.5">
      <ShortcutTooltip label="Split vertical" keys={["cmd", "D"]}>
        <button
          type="button"
          aria-label="Split terminal horizontally"
          onClick={() => onSplit("horizontal")}
          className={ICON_BTN}
        >
          <SplitSquareHorizontal className="size-3.5" />
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Split horizontal" keys={["cmd", "shift", "D"]} alignRight>
        <button
          type="button"
          aria-label="Split terminal vertically"
          onClick={() => onSplit("vertical")}
          className={ICON_BTN}
        >
          <SplitSquareVertical className="size-3.5" />
        </button>
      </ShortcutTooltip>
      {hasLeaves && (
        <ShortcutTooltip label="Close terminal" keys={["cmd", "W"]} alignRight>
          <button type="button" aria-label="Close terminal" onClick={onClose} className={ICON_BTN}>
            <X className="size-3" />
          </button>
        </ShortcutTooltip>
      )}
    </div>
  );
});

TerminalPanelActions.displayName = "TerminalPanelActions";
