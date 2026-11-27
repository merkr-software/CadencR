import { useUiTranslation } from "@/lib/i18n/ui";
import { useId, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChangedFile } from "@/api/generated";
import { displayGitPath } from "@/lib/git-display-path";
import type { ThemeAppearance } from "@/lib/themes";
import { CopyButton } from "./CopyButton";
import { NumStat } from "@/components/NumStat";
import { Checkbox } from "@/components/ui/checkbox";
import { pierreDiffCountColors } from "./DiffStatusIcon";
import { GitDiffFileActionError, GitDiffFileHeaderActions } from "./GitDiffFileHeaderActions";
import type { GitFileIndexActions } from "./useGitFileIndexActions";

interface DiffFileHeaderProps {
  displayName: string;
  additions: number;
  deletions: number;
  isCollapsed: boolean;
  isFocused: boolean;
  isFileViewed: boolean;
  isViewedPending: boolean;
  showViewedCheckbox: boolean;
  statusIcon?: ReactNode;
  themeAppearance: ThemeAppearance;
  onToggle: () => void;
  onOpenFileInEditor?: () => void;
  file: ChangedFile;
  indexActions?: GitFileIndexActions;
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
  isPending: boolean;
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
  const { t } = useUiTranslation();
  // The copy button copies the real path; the label shows control characters escaped.
  const shownName = displayGitPath(displayName);
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
        aria-label={
          isCollapsed
            ? t("workspace.git.diffFileHeader.expandFile", "Expand {{file}}", { file: shownName })
            : t("workspace.git.diffFileHeader.collapseFile", "Collapse {{file}}", {
                file: shownName,
              })
        }
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
        {showName && <span className="min-w-0 flex-1 truncate text-xs">{shownName}</span>}
      </button>
    </>
  );
}

function DiffFileHeaderViewed({
  isFileViewed,
  isPending,
  onMarkViewed,
  onUnmarkViewed,
}: DiffFileHeaderViewedProps): ReactElement {
  const { t } = useUiTranslation();
  const checkboxId = useId();
  const pendingDescriptionId = `${checkboxId}-pending`;
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox
        id={checkboxId}
        checked={isFileViewed}
        disabled={isPending}
        aria-busy={isPending}
        aria-describedby={isPending ? pendingDescriptionId : undefined}
        onCheckedChange={(checked: boolean | "indeterminate"): void => {
          if (checked) onMarkViewed();
          else onUnmarkViewed();
        }}
        className="h-3.5 w-3.5 cursor-pointer"
      />
      <label
        htmlFor={checkboxId}
        className={`select-none ${isPending ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        {t("workspace.git.diffFileHeader.viewed", "Viewed")}
      </label>
      {isPending && (
        <span id={pendingDescriptionId} className="sr-only">
          {t("workspace.git.diffFileHeader.updatingViewedState", "Updating viewed state")}
        </span>
      )}
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
  isViewedPending,
  showViewedCheckbox,
  statusIcon,
  themeAppearance,
  onToggle,
  onOpenFileInEditor,
  file,
  indexActions,
  onMarkViewed,
  onUnmarkViewed,
}: DiffFileHeaderProps): ReactElement {
  const { t } = useUiTranslation();
  const countColors = pierreDiffCountColors(themeAppearance);
  return (
    <>
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
        <NumStat
          additions={additions}
          deletions={deletions}
          addColor={countColors.add}
          delColor={countColors.del}
          notice={
            file.line_count_unavailable
              ? t("workspace.git.diff.lineCountUnavailable", "Line count unavailable")
              : undefined
          }
          className="text-xs shrink-0"
        />
        <GitDiffFileHeaderActions
          file={file}
          indexActions={indexActions}
          onOpenFileInEditor={onOpenFileInEditor}
        />
        {showViewedCheckbox && (
          <DiffFileHeaderViewed
            isFileViewed={isFileViewed}
            isPending={isViewedPending}
            onMarkViewed={onMarkViewed}
            onUnmarkViewed={onUnmarkViewed}
          />
        )}
      </div>
      <GitDiffFileActionError file={file} indexActions={indexActions} />
    </>
  );
}
