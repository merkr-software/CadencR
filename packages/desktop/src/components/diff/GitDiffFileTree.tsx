import { GitDiffTreeHeader } from "./GitDiffTreeHeader";
import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { ContextMenuItem, ContextMenuOpenContext, FileTree } from "@pierre/trees";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { CadencrFileTree } from "@/components/file-tree/CadencrFileTree";
import { FileTreeContextMenuPortal } from "@/components/file-tree/FileTreeContextMenuPortal";
import { ContextMenuActionButton } from "@/components/ContextMenuActionItem";
import type { GitDiffTreeDisplayMode } from "./useGitDiffTreeDisplaySetting";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import { resolvedStageState } from "./useGitDiffFileTreeModel";
import { gitFileActions } from "./gitFileActions";
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
  const entries = gitFileActions({
    file,
    path: file?.file ?? parseGitTreePath(item.path),
    indexActions,
    busy: indexActions.isPending,
    onOpenFileInEditor,
    t,
  });
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
      {entries.map((entry) =>
        entry.kind === "note" ? (
          <p key={entry.id} className="px-2 py-1 text-xs text-muted-foreground" role="note">
            {entry.text}
          </p>
        ) : (
          <ContextMenuActionButton
            key={entry.id}
            icon={entry.icon}
            disabled={entry.disabled}
            className="py-1"
            onSelect={() => closeAndRun(entry.run)}
          >
            {entry.label}
          </ContextMenuActionButton>
        ),
      )}
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
