import type { FileTree } from "@pierre/trees";
import {
  FilesIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  SearchIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GitDiffTreeDisplayMode } from "./useGitDiffTreeDisplaySetting";

function TreeHeaderIconButton({
  icon: Icon,
  label,
  tooltip,
  pressed,
  disabled,
  pending,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tooltip: string;
  pressed?: boolean;
  disabled?: boolean;
  pending?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <ShortcutTooltip label={tooltip} alignRight className="shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          pressed && "bg-accent text-foreground",
          disabled && "cursor-not-allowed hover:bg-transparent hover:text-muted-foreground",
        )}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Icon className="size-3.5" aria-hidden />
        )}
      </Button>
    </ShortcutTooltip>
  );
}

export function GitDiffTreeHeader({
  model,
  fileCount,
  conflictCount,
  displayMode,
  isDisplayModePending,
  onDisplayModeChange,
  onCollapse,
}: {
  model: FileTree;
  fileCount: number;
  conflictCount: number;
  displayMode: GitDiffTreeDisplayMode;
  isDisplayModePending: boolean;
  onDisplayModeChange: (displayMode: GitDiffTreeDisplayMode) => void;
  onCollapse?: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const filenamesOnly = displayMode === "filenames";
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {t("workspace.git.gitDiffFileTree.changedFiles", "{{count, number}} changed files", {
          count: fileCount,
          defaultValue_zero: "{{count, number}} changed files",
          defaultValue_one: "{{count, number}} changed file",
        })}
      </span>
      {conflictCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--acc-orange)]"
          aria-label={t(
            "workspace.git.gitDiffFileTree.unresolvedConflicts",
            "{{count, number}} unresolved Git conflicts",
            { count: conflictCount, defaultValue_one: "{{count, number}} unresolved Git conflict" },
          )}
        >
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          {conflictCount}{" "}
          {conflictCount === 1
            ? t("workspace.git.gitDiffFileTree.conflict", "conflict")
            : t("workspace.git.gitDiffFileTree.conflicts", "conflicts")}
        </span>
      ) : null}
      <TreeHeaderIconButton
        icon={FilesIcon}
        label={t("workspace.git.gitDiffFileTree.showFilenamesOnly", "Show filenames only")}
        tooltip={
          isDisplayModePending
            ? t(
                "workspace.git.gitDiffFileTree.updatingGlobalFileListPreference",
                "Updating global file-list preference…",
              )
            : filenamesOnly
              ? t("workspace.git.gitDiffFileTree.showDirectoryTree", "Show directory tree")
              : t(
                  "workspace.git.gitDiffFileTree.showFilenamesOnlyHideDirectoryFolders",
                  "Show filenames only — hide directory folders",
                )
        }
        pressed={filenamesOnly}
        disabled={isDisplayModePending}
        pending={isDisplayModePending}
        onClick={() => onDisplayModeChange(filenamesOnly ? "tree" : "filenames")}
      />
      <TreeHeaderIconButton
        icon={SearchIcon}
        label={t("workspace.git.gitDiffFileTree.searchChangedFiles", "Search changed files")}
        tooltip={t("workspace.git.gitDiffFileTree.searchChangedFiles", "Search changed files")}
        onClick={() => model.openSearch()}
      />
      {onCollapse ? (
        <TreeHeaderIconButton
          icon={PanelLeftCloseIcon}
          label={t("workspace.git.gitDiffFileTree.collapseGitFileList", "Collapse Git file list")}
          tooltip={t(
            "workspace.git.gitDiffFileTree.collapseChangedFilesSidebar",
            "Collapse changed-files sidebar",
          )}
          onClick={onCollapse}
        />
      ) : null}
    </div>
  );
}
