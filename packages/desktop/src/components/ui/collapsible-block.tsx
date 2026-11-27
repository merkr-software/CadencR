import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { useUiTranslation } from "@/lib/i18n/ui";

interface CollapsibleBlockProps {
  /** Total number of items in the list */
  totalCount: number;
  /** Number of items to show when collapsed (shows last N) */
  visibleCount: number;
  /** Older items exist outside the local preview; expanding loads them. */
  hasMore?: boolean;
  /** Complete truncation notice, formatted with the caller's unit. */
  formatHiddenCount: (count: number) => string;
  /** Header content (icons, labels, etc.) — placed before the toggle button */
  header: ReactNode;
  /**
   * Optional header slot rendered *after* the inner "Show last N / Show all N"
   * toggle, so callers can place their own controls (e.g. a fold chevron) at
   * the very end of the header bar without putting them ahead of the toggle.
   */
  headerTrailing?: ReactNode;
  /** Render the visible slice of items */
  children: (range: { showAll: boolean }) => ReactNode;
  /** Class for the outer wrapper */
  className?: string;
  /** Class for the header bar */
  headerClassName?: string;
  /** Class for the inner "Show last N / Show all N" toggle button */
  toggleClassName?: string;
  /** Class for the body/content area */
  bodyClassName?: string;
  /** Class for the truncation indicator */
  truncationClassName?: string;
  /**
   * Outer body fold. When true, the body is not rendered at all — only the
   * header remains. Used by the auto-collapse verbosity mode and by callers
   * that own their own outer toggle.
   */
  bodyHidden?: boolean;
  /**
   * Click handler for the entire header row. When provided, clicking anywhere
   * on the header (except inner buttons that `stopPropagation`) fires this.
   * Used to mirror the collapse toggle so the whole row is a click target,
   * matching the behavior of other tool blocks.
   */
  onHeaderClick?: () => void;
}

/**
 * Two collapse axes — one shows the last N / all N lines (controlled by an
 * inline button that only appears when `totalCount > visibleCount`), the
 * other completely hides the body (`bodyHidden`). Callers can drive either,
 * neither, or both.
 */
export function CollapsibleBlock({
  totalCount,
  visibleCount,
  hasMore = false,
  formatHiddenCount,
  header,
  headerTrailing,
  children,
  className,
  headerClassName,
  toggleClassName,
  bodyClassName,
  truncationClassName,
  bodyHidden = false,
  onHeaderClick,
}: CollapsibleBlockProps) {
  const { t } = useUiTranslation();
  const [showAll, setShowAll] = useState(false);
  const needsCollapse = hasMore || totalCount > visibleCount;
  const hiddenCount = Math.max(0, totalCount - visibleCount);

  return (
    <div className={cn("my-1 rounded-md border overflow-hidden", className)}>
      <div
        onClick={onHeaderClick}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-xs",
          onHeaderClick && "cursor-pointer",
          headerClassName,
        )}
      >
        {header}
        {!bodyHidden && needsCollapse && (
          <button
            type="button"
            className={cn("shrink-0", toggleClassName)}
            onClick={(e) => {
              e.stopPropagation();
              suppressAutoScrollPin();
              setShowAll((prev) => !prev);
            }}
          >
            {showAll
              ? t("conversation.stream.collapsibleBlock.showLast", "Show last {{count, number}}", {
                  count: visibleCount,
                })
              : hasMore
                ? t("conversation.stream.collapsibleBlock.loadPrevious", "Load previous lines")
                : t("conversation.stream.collapsibleBlock.showAll", "Show all {{count, number}}", {
                    count: totalCount,
                  })}
          </button>
        )}
        {headerTrailing}
      </div>
      <CollapsibleSection open={!bodyHidden}>
        <div className={bodyClassName}>
          {!showAll && needsCollapse && (
            <div className={cn("text-xs", truncationClassName)}>
              {hasMore
                ? t(
                    "conversation.stream.collapsibleBlock.earlierOutputAvailable",
                    "... (earlier output available)",
                  )
                : formatHiddenCount(hiddenCount)}
            </div>
          )}
          {children({ showAll: showAll || !needsCollapse })}
        </div>
      </CollapsibleSection>
    </div>
  );
}
