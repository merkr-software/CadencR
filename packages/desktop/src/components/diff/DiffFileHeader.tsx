import type { ReactElement, ReactNode } from "react";
import { ChevronDown, ChevronRight, PencilIcon } from "lucide-react";
import type { ThemeAppearance } from "@/lib/themes";
import { CopyButton } from "./CopyButton";
import { NumStat } from "@/components/NumStat";
import { Checkbox } from "@/components/ui/checkbox";
import { pierreDiffCountColors } from "./DiffStatusIcon";

interface DiffFileHeaderProps {
  displayName: string;
  additions: number;
  deletions: number;
  isCollapsed: boolean;
  isFocused: boolean;
  isFileViewed: boolean;
  showViewedCheckbox: boolean;
  statusIcon?: ReactNode;
  themeAppearance: ThemeAppearance;
  onToggle: () => void;
  onOpenFileInEditor?: () => void;
  onMarkViewed: () => void;
  onUnmarkViewed: () => void;
}

interface DiffFileHeaderPrefixProps {
  displayName: string;
  isCollapsed: boolean;
  showName?: boolean;
  statusIcon?: ReactNode;
  onToggle: () => void;
}

interface DiffFileHeaderViewedProps {
  isFileViewed: boolean;
  onMarkViewed: () => void;
  onUnmarkViewed: () => void;
}

function DiffFileHeaderPrefix({
  displayName,
  isCollapsed,
  showName = true,
  statusIcon,
  onToggle,
}: DiffFileHeaderPrefixProps): ReactElement {
  return (
    <>
      <CopyButton
        text={displayName}
        hoverClass="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
        sizeClass="h-3.5 w-3.5"
      />
      <button
        type="button"
        className={
          showName
            ? "flex min-w-0 flex-1 items-center gap-2 text-left"
            : "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        }
        aria-label={isCollapsed ? `Expand ${displayName}` : `Collapse ${displayName}`}
        onClick={onToggle}
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        {statusIcon}
        {/* Sans, 12px — matches Pierre's expanded [data-title] so the filename
            doesn't switch fonts between collapsed and expanded states. */}
        {showName && <span className="min-w-0 flex-1 truncate text-xs">{displayName}</span>}
      </button>
    </>
  );
}

function DiffFileHeaderOpenInEditor({
  displayName,
  onOpenFileInEditor,
}: {
  displayName: string;
  onOpenFileInEditor?: () => void;
}): ReactElement | null {
  if (!onOpenFileInEditor) return null;

  return (
    <button
      type="button"
      aria-label={`Open ${displayName} in editor`}
      title="Open in editor"
      onClick={(event): void => {
        event.preventDefault();
        event.stopPropagation();
        onOpenFileInEditor();
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100 group-hover/patch-file:opacity-100"
    >
      <PencilIcon className="h-3.5 w-3.5" />
    </button>
  );
}

function DiffFileHeaderViewed({
  isFileViewed,
  onMarkViewed,
  onUnmarkViewed,
}: DiffFileHeaderViewedProps): ReactElement {
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox
        checked={isFileViewed}
        onCheckedChange={(checked: boolean | "indeterminate"): void => {
          if (checked) onMarkViewed();
          else onUnmarkViewed();
        }}
        className="h-3.5 w-3.5 cursor-pointer"
      />
      <span
        className="cursor-pointer select-none"
        onClick={(): void => {
          if (isFileViewed) onUnmarkViewed();
          else onMarkViewed();
        }}
      >
        Viewed
      </span>
    </div>
  );
}

/** Sticky file header row with collapse toggle, stats, and viewed checkbox. */
export function DiffFileHeader({
  displayName,
  additions,
  deletions,
  isCollapsed,
  isFocused,
  isFileViewed,
  showViewedCheckbox,
  statusIcon,
  themeAppearance,
  onToggle,
  onOpenFileInEditor,
  onMarkViewed,
  onUnmarkViewed,
}: DiffFileHeaderProps): ReactElement {
  const countColors = pierreDiffCountColors(themeAppearance);
  return (
    <div
      data-diff-file-header
      className={`group/header sticky top-0 z-10 flex w-full items-center gap-2 bg-sidebar px-4 py-2.5 text-sm text-foreground hover:bg-accent ${isFocused ? "ring-1 ring-inset ring-primary bg-accent" : ""}`}
    >
      <DiffFileHeaderPrefix
        displayName={displayName}
        isCollapsed={isCollapsed}
        statusIcon={statusIcon}
        onToggle={onToggle}
      />
      {/* NumStat before the edit button, zero counts hidden, and Pierre's exact
          colors — so this single header looks identical whether the file is
          collapsed or expanded over a Pierre diff body. */}
      <NumStat
        additions={additions}
        deletions={deletions}
        addColor={countColors.add}
        delColor={countColors.del}
        className="text-xs shrink-0"
      />
      <DiffFileHeaderOpenInEditor
        displayName={displayName}
        onOpenFileInEditor={onOpenFileInEditor}
      />
      {showViewedCheckbox && (
        <DiffFileHeaderViewed
          isFileViewed={isFileViewed}
          onMarkViewed={onMarkViewed}
          onUnmarkViewed={onUnmarkViewed}
        />
      )}
    </div>
  );
}
