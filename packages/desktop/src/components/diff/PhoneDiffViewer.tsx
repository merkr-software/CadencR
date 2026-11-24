import { useUiTranslation } from "@/lib/i18n/ui";
import { useMemo, type ReactElement, type RefObject } from "react";
import type { ChangedFile } from "@/api/generated";
import type { ReviewNavigationTarget } from "@/lib/pr-review-threads";
import type { ThemeAppearance } from "@/lib/themes";
import { gitFileActions } from "./gitFileActions";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import type { OpenDiffInEditor } from "./OpenDiffInEditorContext";
import { PhoneCommitBar } from "./PhoneCommitBar";
import { PhoneDiffFileList } from "./PhoneDiffFileList";
import { PhoneDiffFileStep, type PhoneDiffFileActions } from "./PhoneDiffFileStep";
import { sortChangedFilesForDiff } from "./useGitDiffFileTreeModel";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import { useGitStageControlState } from "./useGitStageControlState";
import { usePhoneDiffSteps, usePhoneNavigationAdapter } from "./usePhoneDiffSteps";

/** Renders the shared diff pane (`DiffContent`) for the given files, none collapsed. */
export type RenderDiffFiles = (files: ChangedFile[]) => ReactElement;

export interface PhoneDiffViewerProps {
  featureId: number;
  files: ChangedFile[];
  renderFiles: RenderDiffFiles;
  /** The diff pane `renderFiles` scrolls in: half-page keys scroll it. */
  diffAreaRef: RefObject<HTMLDivElement | null>;
  /** Names the list: "Changes", "vs main", "Files". */
  backLabel: string;
  /** The working tree's own changes: the list ends on the Commit bar. */
  showCommitBar: boolean;
  viewedFiles: ReadonlySet<string>;
  supportsViewed: boolean;
  isViewedPending: boolean;
  markFileViewed: (path: string) => void;
  unmarkFileViewed: (path: string) => void;
  indexActions: GitFileIndexActions | undefined;
  openFileInEditor: OpenDiffInEditor | undefined;
  reviewCountsByFile: ReadonlyMap<string, number> | undefined;
  /** A review thread to show: opens its file, once. */
  reviewTarget: ReviewNavigationTarget | null | undefined;
  /** The Git tab's keyboard commands: given the phone steps' adapter. */
  registerNavigationAdapter: GitNavigationAdapterRegistrar | undefined;
  appearance: ThemeAppearance;
}

/** A stand-in for views whose index cannot change; the stage control state ignores it. */
const NO_INDEX_ACTIONS: GitFileIndexActions = {
  stage: () => undefined,
  reset: () => undefined,
  isPending: false,
  pendingAction: null,
  pendingPath: null,
  error: null,
};

/** The open file's "…" sheet: the tree's file actions, then viewed. */
function useOpenFileActions(
  props: PhoneDiffViewerProps,
  file: ChangedFile | undefined,
  busy: boolean,
): PhoneDiffFileActions {
  const { indexActions, openFileInEditor, supportsViewed, viewedFiles, isViewedPending } = props;
  const { markFileViewed, unmarkFileViewed } = props;
  const { t } = useUiTranslation();
  return useMemo(() => {
    if (!file) return { entries: [], viewed: undefined };
    const entries = gitFileActions({
      file,
      path: file.file,
      indexActions,
      busy,
      onOpenFileInEditor: openFileInEditor,
      t,
    });
    const viewed = supportsViewed
      ? {
          isViewed: viewedFiles.has(file.file),
          pending: isViewedPending,
          mark: () => markFileViewed(file.file),
          unmark: () => unmarkFileViewed(file.file),
        }
      : undefined;
    return { entries, viewed };
  }, [
    busy,
    file,
    indexActions,
    isViewedPending,
    markFileViewed,
    openFileInEditor,
    supportsViewed,
    t,
    unmarkFileViewed,
    viewedFiles,
  ]);
}

/**
 * The Git diff on the phone layout, in two full-width steps instead of the
 * desktop's file tree beside the diff: the list of changed files, then one
 * file's diff (unified) with Back, previous / next and its actions. The data,
 * the per-file lazy fetch, review threads, comments and staging are the
 * desktop viewer's (`LoadedDiffViewer`); this only lays them out, and gives
 * the Git keyboard commands to the file on screen (`usePhoneDiffSteps`).
 */
export function PhoneDiffViewer(props: PhoneDiffViewerProps): ReactElement {
  const { files, renderFiles, viewedFiles, indexActions } = props;
  const ordered = useMemo(() => sortChangedFilesForDiff(files), [files]);
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.file, file])), [files]);
  // One stage state for the list's boxes and the file sheet: both stay held
  // until Git confirms, as the desktop tree's boxes do.
  const control = useGitStageControlState(
    indexActions ?? NO_INDEX_ACTIONS,
    fileByPath,
    indexActions !== undefined,
  );
  const stage = useMemo(
    () => (indexActions ? { control, actions: indexActions } : null),
    [control, indexActions],
  );
  const steps = usePhoneDiffSteps(ordered, props.reviewTarget);
  const { file, index } = steps;
  const actions = useOpenFileActions(props, file, control.isBusy);
  usePhoneNavigationAdapter(props.registerNavigationAdapter, {
    steps,
    entries: actions.entries,
    viewed: actions.viewed,
    diffAreaRef: props.diffAreaRef,
  });
  const diff = useMemo(() => (file ? renderFiles([file]) : null), [file, renderFiles]);

  if (file) {
    return (
      <PhoneDiffFileStep
        file={file}
        backLabel={props.backLabel}
        position={{ index, total: ordered.length }}
        onBack={steps.back}
        onStep={steps.step}
        actions={actions}
      >
        {/* Keyed by file: a new file starts at its top. */}
        <div key={file.file} className="h-full">
          {diff}
        </div>
      </PhoneDiffFileStep>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PhoneDiffFileList
        files={ordered}
        viewedFiles={viewedFiles}
        supportsViewed={props.supportsViewed}
        reviewCountsByFile={props.reviewCountsByFile}
        stage={stage}
        appearance={props.appearance}
        scrollTarget={steps.scrollTarget}
        onOpen={steps.open}
      />
      {props.showCommitBar && <PhoneCommitBar featureId={props.featureId} />}
    </div>
  );
}
