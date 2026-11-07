import { type ReactElement, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { ConflictKind, useGetFileContent, type ChangedFileConflictKind } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { useGitFileIndexActions } from "@/components/diff/useGitFileIndexActions";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import ConflictResultResolver from "./ConflictResultResolver";

interface ConflictResolverEditorProps {
  /** Editor path, relative to the feature's directory. */
  filePath: string;
  /** The same file as Git endpoints name it, relative to the checkout root. */
  gitFilePath: string;
  conflictKind: ChangedFileConflictKind | undefined;
  projectId: number;
  paneId: string;
  featureId: number;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

export default function ConflictResolverEditor(props: ConflictResolverEditorProps): ReactElement {
  const query = useGetFileContent(
    { feature_id: props.featureId, file_path: props.gitFilePath, mode: "uncommitted" },
    { query: { refetchOnWindowFocus: false, refetchOnReconnect: false } },
  );
  const operation = useGitStatusStore(
    (state) => state.byFeature[props.featureId]?.operation ?? null,
  );
  const indexActions = useGitFileIndexActions(props.featureId);

  if (query.isLoading) return <ResolverMessage pending>Loading conflict result…</ResolverMessage>;
  if (query.isError) {
    if (props.conflictKind === ConflictKind.dd) {
      return (
        <StageGuidanceMessage
          filePath={props.gitFilePath}
          message="Both sides deleted this path. Stage the deletion to mark it resolved."
          stageDeletion
          indexActions={indexActions}
        />
      );
    }
    return (
      <ResolverMessage
        error
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Retrying…" : "Retry"}
          </Button>
        }
      >
        Could not load the conflict result: {apiErrorMessage(query.error, "Unknown error")}
      </ResolverMessage>
    );
  }
  if (!query.data) return <ResolverMessage error>No conflict result was returned.</ResolverMessage>;
  if (query.data.is_binary) {
    return (
      <StageGuidanceMessage
        filePath={props.gitFilePath}
        message="Binary content cannot be resolved safely in the text editor. Choose the desired file externally, then stage it."
        stageDeletion={false}
        indexActions={indexActions}
      />
    );
  }
  if (query.data.new_content == null) {
    const deleted =
      props.conflictKind === ConflictKind.dd ||
      props.conflictKind === ConflictKind.du ||
      props.conflictKind === ConflictKind.ud;
    return (
      <StageGuidanceMessage
        filePath={props.gitFilePath}
        message={
          deleted
            ? "The worktree result is deleted. Stage the deletion to mark this conflict resolved."
            : "The conflict result is unavailable. Inspect the repository before staging."
        }
        stageDeletion={deleted}
        indexActions={indexActions}
      />
    );
  }
  return (
    <ConflictResultResolver
      featureId={props.featureId}
      filePath={props.filePath}
      paneId={props.paneId}
      projectId={props.projectId}
      onEditorViewChange={props.onEditorViewChange}
      initialContent={query.data.new_content}
      operation={operation}
    />
  );
}

function ResolverMessage({
  children,
  error = false,
  pending = false,
  action,
}: {
  children: ReactNode;
  error?: boolean;
  pending?: boolean;
  action?: ReactNode;
}): ReactElement {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
      role={error ? "alert" : "status"}
    >
      {pending ? (
        <Loader2Icon className="size-5 animate-spin" aria-hidden />
      ) : (
        <TriangleAlertIcon className="size-5 text-[var(--acc-orange)]" aria-hidden />
      )}
      <p>{children}</p>
      {action}
    </div>
  );
}

function StageGuidanceMessage({
  filePath,
  message,
  stageDeletion,
  indexActions,
}: {
  filePath: string;
  message: string;
  stageDeletion: boolean;
  indexActions: ReturnType<typeof useGitFileIndexActions>;
}): ReactElement {
  const pending = indexActions.pendingPath === filePath && indexActions.pendingAction === "stage";
  const stageError = indexActions.error?.filePath === filePath ? indexActions.error.message : null;
  return (
    <ResolverMessage
      error={stageError != null}
      action={
        <Button
          disabled={indexActions.isPending}
          aria-busy={pending}
          onClick={() => indexActions.stage(filePath, { conflicted: true })}
        >
          {pending ? "Staging…" : stageDeletion ? "Stage deletion" : "Stage"}
        </Button>
      }
    >
      {message}
      {stageError ? ` Stage failed: ${stageError}` : ""}
    </ResolverMessage>
  );
}
