import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { ContextMenuItem, ContextMenuOpenContext, FileTree } from "@pierre/trees";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardCopyIcon,
  FilePenLineIcon,
  FilesIcon,
  Loader2Icon,
  MinusIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { CadencrFileTree } from "@/components/file-tree/CadencrFileTree";
import { FileTreeContextMenuPortal } from "@/components/file-tree/FileTreeContextMenuPortal";
import { ContextMenuActionButton } from "@/components/ContextMenuActionItem";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { GitDiffTreeDisplayMode } from "./useGitDiffTreeDisplaySetting";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import { isUnavailableDeleteConflict, resolvedStageState } from "./useGitDiffFileTreeModel";
import { openGitFileInEditor } from "./gitFileEditorHandoff";
import { parseGitTreePath } from "@/lib/git-display-path";
import { useGitDiffStageCheckboxes } from "./useGitDiffStageCheckboxes";

interface GitDiffFileTreeProps {
  model: FileTree;
  files: readonly ChangedFile[];
  expandedFiles: ReadonlySet<string>;
  indexActions: GitFileIndexActions;
  displayMode: GitDiffTreeDisplayMode;
  isDisplayModePending: boolean;
  onDisplayModeChange: (displayMode: GitDiffTreeDisplayMode) => void;
  resolveFilePath: (treePath: string) => string | null;
  onToggleExpand: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  onCollapse?: () => void;
  /** When false, stage checkboxes are hidden (e.g. branch comparison mode). */
  stageCheckboxesEnabled?: boolean;
}

function eventFilePath(event: MouseEvent | KeyboardEvent): string | null {
  for (const node of event.nativeEvent.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.getAttribute("data-item-type") !== "file") continue;
    return node.getAttribute("data-item-path");
  }
  return null;
}

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

function GitDiffTreeHeader({
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
  const filenamesOnly = displayMode === "filenames";
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {fileCount} changed {fileCount === 1 ? "file" : "files"}
      </span>
      {conflictCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--acc-orange)]"
          aria-label={`${conflictCount} unresolved Git ${conflictCount === 1 ? "conflict" : "conflicts"}`}
        >
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          {conflictCount} {conflictCount === 1 ? "conflict" : "conflicts"}
        </span>
      ) : null}
      <TreeHeaderIconButton
        icon={FilesIcon}
        label="Show filenames only"
        tooltip={
          isDisplayModePending
            ? "Updating global file-list preference…"
            : filenamesOnly
              ? "Show directory tree"
              : "Show filenames only — hide directory folders"
        }
        pressed={filenamesOnly}
        disabled={isDisplayModePending}
        pending={isDisplayModePending}
        onClick={() => onDisplayModeChange(filenamesOnly ? "tree" : "filenames")}
      />
      <TreeHeaderIconButton
        icon={SearchIcon}
        label="Search changed files"
        tooltip="Search changed files"
        onClick={() => model.openSearch()}
      />
      {onCollapse ? (
        <TreeHeaderIconButton
          icon={PanelLeftCloseIcon}
          label="Collapse Git file list"
          tooltip="Collapse changed-files sidebar"
          onClick={onCollapse}
        />
      ) : null}
    </div>
  );
}

interface GitDiffTreeContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  file: ChangedFile | undefined;
  expanded: boolean;
  indexActions: GitFileIndexActions;
  onToggleExpand: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
}

function GitDiffTreeContextMenu({
  item,
  context,
  file,
  expanded,
  indexActions,
  onToggleExpand,
  onOpenFileInEditor,
}: GitDiffTreeContextMenuProps): React.JSX.Element {
  const unavailableReason = file && isUnavailableDeleteConflict(file);
  const stageState = file ? resolvedStageState(file) : FileStageState.not_applicable;
  const availability = getGitFileActionAvailability(stageState);
  const exactPath = file?.file ?? parseGitTreePath(item.path);
  const pathPending = indexActions.pendingPath === exactPath;
  const closeAndRun = (action: () => void): void => {
    context.close();
    action();
  };

  return (
    <FileTreeContextMenuPortal context={context}>
      {file ? (
        <ContextMenuActionButton
          icon={expanded ? ChevronUpIcon : ChevronDownIcon}
          className="py-1"
          onSelect={() => closeAndRun(() => onToggleExpand(file.file))}
        >
          {expanded ? "Collapse diff" : "Reveal diff"}
        </ContextMenuActionButton>
      ) : null}
      {file && onOpenFileInEditor ? (
        <ContextMenuActionButton
          icon={FilePenLineIcon}
          disabled={unavailableReason}
          className="py-1"
          onSelect={() =>
            closeAndRun(() => openGitFileInEditor(file, () => onOpenFileInEditor(file.file)))
          }
        >
          Open in Editor
        </ContextMenuActionButton>
      ) : null}
      {unavailableReason ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" role="note">
          Editor unavailable: both sides deleted this file. Stage the deletion to resolve it.
        </p>
      ) : null}
      <ContextMenuActionButton
        icon={ClipboardCopyIcon}
        className="py-1"
        onSelect={() => closeAndRun(() => void copyToClipboard(exactPath, "Path copied"))}
      >
        Copy path
      </ContextMenuActionButton>
      {file && availability.canStage ? (
        <ContextMenuActionButton
          icon={pathPending && indexActions.pendingAction === "stage" ? Loader2Icon : PlusIcon}
          disabled={indexActions.isPending}
          className="py-1"
          onSelect={() =>
            closeAndRun(() =>
              indexActions.stage(file.file, {
                conflicted: resolvedStageState(file) === FileStageState.conflicted,
              }),
            )
          }
        >
          {pathPending && indexActions.pendingAction === "stage"
            ? "Staging…"
            : unavailableReason
              ? "Stage deletion"
              : "Stage file"}
        </ContextMenuActionButton>
      ) : null}
      {file && availability.canReset ? (
        <ContextMenuActionButton
          icon={pathPending && indexActions.pendingAction === "reset" ? Loader2Icon : MinusIcon}
          disabled={indexActions.isPending}
          className="py-1"
          onSelect={() => closeAndRun(() => indexActions.reset(file.file))}
        >
          {pathPending && indexActions.pendingAction === "reset"
            ? "Unstaging…"
            : "Unstage file (keeps worktree changes)"}
        </ContextMenuActionButton>
      ) : null}
    </FileTreeContextMenuPortal>
  );
}

export function countUniqueConflicts(files: readonly ChangedFile[]): number {
  return new Set(
    files
      .filter((file) => resolvedStageState(file) === FileStageState.conflicted)
      .map((file) => file.file),
  ).size;
}

interface UseGitDiffTreeContextMenuOptions {
  fileByPath: ReadonlyMap<string, ChangedFile>;
  expandedFiles: ReadonlySet<string>;
  indexActions: GitFileIndexActions;
  resolveFilePath: (treePath: string) => string | null;
  onToggleExpand: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
}

function useGitDiffTreeContextMenu({
  fileByPath,
  expandedFiles,
  indexActions,
  resolveFilePath,
  onToggleExpand,
  onOpenFileInEditor,
}: UseGitDiffTreeContextMenuOptions) {
  return useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const filePath = resolveFilePath(item.path);
      return (
        <GitDiffTreeContextMenu
          item={item}
          context={context}
          file={filePath ? fileByPath.get(filePath) : undefined}
          expanded={filePath ? expandedFiles.has(filePath) : false}
          indexActions={indexActions}
          onToggleExpand={onToggleExpand}
          onOpenFileInEditor={onOpenFileInEditor}
        />
      );
    },
    [expandedFiles, fileByPath, indexActions, onOpenFileInEditor, onToggleExpand, resolveFilePath],
  );
}

function GitDiffFileTreeImpl({
  model,
  files,
  expandedFiles,
  indexActions,
  displayMode,
  isDisplayModePending,
  onDisplayModeChange,
  resolveFilePath,
  onToggleExpand,
  onOpenFileInEditor,
  onCollapse,
  stageCheckboxesEnabled = true,
}: GitDiffFileTreeProps): React.JSX.Element {
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.file, file])), [files]);
  const conflictCount = useMemo(() => countUniqueConflicts(files), [files]);
  useGitDiffStageCheckboxes(model, files, indexActions, stageCheckboxesEnabled);
  const activateConflict = useCallback(
    (filePath: string): void => {
      const file = fileByPath.get(filePath);
      if (!file || resolvedStageState(file) !== FileStageState.conflicted) return;
      if (onOpenFileInEditor) {
        openGitFileInEditor(file, () => onOpenFileInEditor(file.file));
      }
    },
    [fileByPath, onOpenFileInEditor],
  );
  const handleDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const filePath = eventFilePath(event);
      const resolvedPath = filePath ? resolveFilePath(filePath) : null;
      if (resolvedPath) activateConflict(resolvedPath);
    },
    [activateConflict, resolveFilePath],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      const focusedTreePath = model.getFocusedPath();
      const focusedPath = focusedTreePath ? resolveFilePath(focusedTreePath) : null;
      const focusedFile = focusedPath ? fileByPath.get(focusedPath) : undefined;
      if (!focusedPath || !focusedFile) return;
      if (resolvedStageState(focusedFile) !== FileStageState.conflicted) return;
      event.preventDefault();
      activateConflict(focusedPath);
    },
    [activateConflict, fileByPath, model, resolveFilePath],
  );
  const renderContextMenu = useGitDiffTreeContextMenu({
    fileByPath,
    expandedFiles,
    indexActions,
    resolveFilePath,
    onToggleExpand,
    onOpenFileInEditor,
  });

  return (
    <div
      className="flex h-full flex-col bg-sidebar"
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <CadencrFileTree
        model={model}
        header={
          <GitDiffTreeHeader
            model={model}
            fileCount={files.length}
            conflictCount={conflictCount}
            displayMode={displayMode}
            isDisplayModePending={isDisplayModePending}
            onDisplayModeChange={onDisplayModeChange}
            onCollapse={onCollapse}
          />
        }
        emptyState={
          files.length === 0 ? (
            <p className="text-xs text-muted-foreground">No changed files</p>
          ) : undefined
        }
        renderContextMenu={renderContextMenu}
        aria-label="Git changed files"
      />
    </div>
  );
}

export const GitDiffFileTree = memo(GitDiffFileTreeImpl);
export { GitDiffTreeContextMenu };
