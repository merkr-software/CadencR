import { GitDiffTreeHeader } from "./GitDiffTreeHeader";
import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { ContextMenuItem, ContextMenuOpenContext, FileTree } from "@pierre/trees";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardCopyIcon,
  FilePenLineIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { CadencrFileTree } from "@/components/file-tree/CadencrFileTree";
import { FileTreeContextMenuPortal } from "@/components/file-tree/FileTreeContextMenuPortal";
import { ContextMenuActionButton } from "@/components/ContextMenuActionItem";
import { copyToClipboard } from "@/lib/clipboard";
import type { GitDiffTreeDisplayMode } from "./useGitDiffTreeDisplaySetting";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import { isUnavailableDeleteConflict, resolvedStageState } from "./useGitDiffFileTreeModel";
import { deletedConflictTooltip, openGitFileInEditor } from "./gitFileEditorHandoff";
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
  const { t } = useUiTranslation();
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
          {expanded
            ? t("workspace.git.gitDiffFileTree.collapseDiff", "Collapse diff")
            : t("workspace.git.gitDiffFileTree.revealDiff", "Reveal diff")}
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
          {t("workspace.git.gitDiffFileTree.openInEditor", "Open in Editor")}
        </ContextMenuActionButton>
      ) : null}
      {unavailableReason ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" role="note">
          {deletedConflictTooltip(t)}
        </p>
      ) : null}
      <ContextMenuActionButton
        icon={ClipboardCopyIcon}
        className="py-1"
        onSelect={() => closeAndRun(() => copyGitPath(exactPath))}
      >
        {t("workspace.git.gitDiffFileTree.copyPath", "Copy path")}
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
            ? t("workspace.git.gitDiffFileTree.staging", "Staging…")
            : unavailableReason
              ? t("workspace.git.gitDiffFileTree.stageDeletion", "Stage deletion")
              : t("workspace.git.gitDiffFileTree.stageFile", "Stage file")}
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
            ? t("workspace.git.gitDiffFileTree.unstaging", "Unstaging…")
            : t(
                "workspace.git.gitDiffFileTree.unstageFileKeepsWorktreeChanges",
                "Unstage file (keeps worktree changes)",
              )}
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
  const { t } = useUiTranslation();
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
            <p className="text-xs text-muted-foreground">
              {t("workspace.git.gitDiffFileTree.noChangedFiles", "No changed files")}
            </p>
          ) : undefined
        }
        renderContextMenu={renderContextMenu}
        aria-label={t("workspace.git.gitDiffFileTree.gitChangedFiles", "Git changed files")}
      />
    </div>
  );
}

export const GitDiffFileTree = memo(GitDiffFileTreeImpl);
export { GitDiffTreeContextMenu };

function copyGitPath(path: string): void {
  void copyToClipboard(
    path,
    translateUi("workspace.git.gitDiffFileTree.pathCopied", "Path copied"),
  );
}
