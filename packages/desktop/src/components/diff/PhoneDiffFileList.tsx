import { memo, useCallback, useMemo, useRef, type ReactElement } from "react";
import { CheckIcon, ChevronRightIcon, Loader2Icon, MessageSquareIcon } from "lucide-react";
import { Virtuoso, type ItemContent } from "react-virtuoso";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { NumStat } from "@/components/NumStat";
import { Checkbox } from "@/components/ui/checkbox";
import { displayGitPath } from "@/lib/git-display-path";
import type { ThemeAppearance } from "@/lib/themes";
import { cn } from "@/lib/utils";
import {
  DiffStatusIcon,
  deriveChangeTypeFromStatus,
  pierreDiffCountColors,
} from "./DiffStatusIcon";
import { checkboxVisualState, toggleFileStage } from "./useGitDiffStageCheckboxes";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import { resolvedStageState } from "./useGitDiffFileTreeModel";
import type { GitStageControlState } from "./useGitStageControlState";

const ROW_HEIGHT = 56;

/** A path split for display: the file name leads, its folder under it. */
export function splitGitPath(path: string): { name: string; folder: string } {
  const shown = displayGitPath(path);
  const slash = shown.lastIndexOf("/");
  return slash < 0
    ? { name: shown, folder: "" }
    : { name: shown.slice(slash + 1), folder: shown.slice(0, slash) };
}

/**
 * A file's stage checkbox (`Checkbox`: checked when staged, mixed when
 * partly staged) in a 44px slot it fills as its target; a spinner while Git
 * has not confirmed the last tap (no optimistic tick), and an empty slot for
 * a file with nothing to stage.
 */
function PhoneStageToggle({
  file,
  control,
  actions,
}: {
  file: ChangedFile;
  control: GitStageControlState;
  actions: GitFileIndexActions;
}): ReactElement {
  const stageState = resolvedStageState(file);
  const visual = checkboxVisualState(stageState);
  const shownPath = displayGitPath(file.file);
  const pending = control.pendingPath === file.file && control.pendingAction !== null;
  let content: ReactElement | null = null;
  if (pending) {
    content = (
      <Loader2Icon
        role="status"
        aria-label={`${control.pendingAction === "reset" ? "Unstaging" : "Staging"} ${shownPath}`}
        className="size-4 animate-spin text-muted-foreground"
      />
    );
  } else if (visual) {
    const { canStage, canReset } = getGitFileActionAvailability(stageState);
    content = (
      <Checkbox
        aria-label={`Stage ${shownPath}`}
        checked={visual.indeterminate ? "indeterminate" : visual.checked}
        disabled={control.isBusy || !(visual.checked ? canReset : canStage)}
        // Controlled by Git's answer: the box changes when the file list does.
        onCheckedChange={() => toggleFileStage(file, actions)}
        className="size-[18px] phone:hit-area"
      />
    );
  }
  return (
    <span data-phone-stage-slot className="flex size-11 shrink-0 items-center justify-center">
      {content}
    </span>
  );
}

interface RowContext {
  viewedFiles: ReadonlySet<string>;
  reviewCountsByFile: ReadonlyMap<string, number> | undefined;
  stage: { control: GitStageControlState; actions: GitFileIndexActions } | null;
  appearance: ThemeAppearance;
  onOpen: (path: string) => void;
}

const PhoneDiffFileRow = memo(function PhoneDiffFileRow({
  file,
  context,
}: {
  file: ChangedFile;
  context: RowContext;
}): ReactElement {
  const { name, folder } = splitGitPath(file.file);
  const reviews = context.reviewCountsByFile?.get(file.file) ?? 0;
  const viewed = context.viewedFiles.has(file.file);
  const conflicted = resolvedStageState(file) === FileStageState.conflicted;
  const colors = pierreDiffCountColors(context.appearance);
  return (
    <div
      data-phone-diff-row={file.file}
      className="flex h-14 items-center border-b border-border/60"
    >
      {context.stage && (
        <PhoneStageToggle
          file={file}
          control={context.stage.control}
          actions={context.stage.actions}
        />
      )}
      <button
        type="button"
        aria-label={`Open ${displayGitPath(file.file)}`}
        onClick={() => context.onOpen(file.file)}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-2.5 pr-2 text-left hover:bg-accent/50",
          !context.stage && "pl-4",
        )}
      >
        <DiffStatusIcon
          type={deriveChangeTypeFromStatus(file.status)}
          appearance={context.appearance}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-sm font-medium", viewed && "text-muted-foreground")}>
            {name}
          </span>
          {folder && <span className="truncate text-xs text-muted-foreground">{folder}</span>}
        </span>
        {conflicted && (
          <span className="shrink-0 text-[11px] text-[var(--acc-orange)]">Conflict</span>
        )}
        {reviews > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
            <MessageSquareIcon className="size-3" aria-hidden />
            {reviews}
          </span>
        )}
        {viewed && (
          <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Viewed" />
        )}
        <NumStat
          additions={file.additions}
          deletions={file.deletions}
          addColor={colors.add}
          delColor={colors.del}
          className="shrink-0 text-xs"
        />
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </div>
  );
});

const renderRow: ItemContent<ChangedFile, RowContext> = (_index, file, context) => (
  <PhoneDiffFileRow file={file} context={context} />
);

/** A scroll offset to restore, or a row to bring to the middle. */
export type PhoneDiffListScrollTarget = { top: number } | { index: number };

interface PhoneDiffFileListProps {
  /** In diff order (`sortChangedFilesForDiff`). */
  files: ChangedFile[];
  viewedFiles: ReadonlySet<string>;
  supportsViewed: boolean;
  reviewCountsByFile: ReadonlyMap<string, number> | undefined;
  /**
   * Present where the index can change (the working tree): rows get a stage
   * box, held while a request or its confirmation is in flight.
   */
  stage: { control: GitStageControlState; actions: GitFileIndexActions } | null;
  appearance: ThemeAppearance;
  /** Where the list opens: where it was when a file opened, or the file stepped to. */
  scrollTarget: PhoneDiffListScrollTarget;
  onOpen: (path: string, scrollTop: number) => void;
}

/**
 * The phone layout's first Git step: every changed file full width, one 56px
 * row each (stage box, status, name over its folder, review count, viewed,
 * +/− counts), virtualized. A row opens that file's diff.
 */
export const PhoneDiffFileList = memo(function PhoneDiffFileList({
  files,
  viewedFiles,
  supportsViewed,
  reviewCountsByFile,
  stage,
  appearance,
  scrollTarget,
  onOpen,
}: PhoneDiffFileListProps): ReactElement {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const open = useCallback(
    (path: string) => onOpen(path, scrollerRef.current?.scrollTop ?? 0),
    [onOpen],
  );
  const context = useMemo<RowContext>(
    () => ({ viewedFiles, reviewCountsByFile, stage, appearance, onOpen: open }),
    [appearance, open, reviewCountsByFile, stage, viewedFiles],
  );
  const setScroller = useCallback((element: HTMLElement | Window | null) => {
    scrollerRef.current = element instanceof HTMLElement ? element : null;
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-4 text-xs text-muted-foreground">
        <span>
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </span>
        {supportsViewed && (
          <span aria-live="polite">
            {files.filter((file) => viewedFiles.has(file.file)).length}/{files.length} viewed
          </span>
        )}
      </div>
      <Virtuoso
        className="min-h-0 flex-1"
        data={files}
        context={context}
        fixedItemHeight={ROW_HEIGHT}
        {...("index" in scrollTarget
          ? { initialTopMostItemIndex: { index: scrollTarget.index, align: "center" as const } }
          : { initialScrollTop: scrollTarget.top })}
        computeItemKey={(_index, file) => file.file}
        itemContent={renderRow}
        scrollerRef={setScroller}
      />
    </div>
  );
});
