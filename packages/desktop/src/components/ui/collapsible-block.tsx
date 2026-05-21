import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleBlockProps {
  /** Total number of items in the list */
  totalCount: number;
  /** Number of items to show when collapsed (shows last N) */
  visibleCount: number;
  /** Unit label for the truncation indicator (e.g. "lines", "actions") */
  unit: string;
  /** Header content (icons, labels, etc.) — placed before the toggle button */
  header: ReactNode;
  /** Render the visible slice of items */
  children: (range: { showAll: boolean }) => ReactNode;
  /**
   * When true, the whole body can be toggled open/closed via the header and
   * starts closed. The header (and its command) stays visible while closed.
   */
  collapsible?: boolean;
  /** Class for the outer wrapper */
  className?: string;
  /** Class for the header bar */
  headerClassName?: string;
  /** Class for the toggle button */
  toggleClassName?: string;
  /** Class for the body/content area */
  bodyClassName?: string;
  /** Class for the truncation indicator */
  truncationClassName?: string;
}

export function CollapsibleBlock({
  totalCount,
  visibleCount,
  unit,
  header,
  children,
  collapsible = false,
  className,
  headerClassName,
  toggleClassName,
  bodyClassName,
  truncationClassName,
}: CollapsibleBlockProps) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(!collapsible);
  const needsCollapse = totalCount > visibleCount;
  const hiddenCount = totalCount - visibleCount;

  const toggleOpen = (): void => setOpen((value) => !value);
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleOpen();
    }
  };

  return (
    <div className={cn("my-1 rounded-md border overflow-hidden", className)}>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-xs",
          collapsible && "cursor-pointer select-none",
          headerClassName,
        )}
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        onClick={collapsible ? toggleOpen : undefined}
        onKeyDown={collapsible ? onHeaderKeyDown : undefined}
      >
        {collapsible && (
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          />
        )}
        {header}
        {open && needsCollapse && (
          <button
            type="button"
            className={cn("shrink-0", toggleClassName)}
            onClick={(event) => {
              event.stopPropagation();
              setShowAll(!showAll);
            }}
          >
            {showAll ? `Show last ${visibleCount}` : `Show all ${totalCount}`}
          </button>
        )}
      </div>
      {open && (
        <div className={bodyClassName}>
          {!showAll && needsCollapse && (
            <div className={cn("text-xs", truncationClassName)}>
              ... ({hiddenCount} {unit} above)
            </div>
          )}
          {children({ showAll: showAll || !needsCollapse })}
        </div>
      )}
    </div>
  );
}
