import { lazy, memo, Suspense, useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PluginEditorSurface } from "@/components/plugin-surfaces/PluginEditorSurface";
import { usePluginTabContext } from "@/components/plugin-tabs/usePluginTabContext";
import { useListProjects, useGetFeatureSettings } from "@/api/generated";
import { useFeatureWorktreeInfo } from "@/hooks/useFeatureWorktreePath";
import type { EditorTarget } from "@/lib/editors/editor-registry";
import {
  clearEditorFallback,
  useEditorNavigationStore,
} from "@/lib/editors/editor-navigation-store";

const NeovimPane = lazy(() => import("./neovim/NeovimPane"));
const EMPTY_SETTINGS: Record<string, string> = {};

interface SelectedEditorSurfaceProps {
  featureId: number;
  projectId: number;
  projectPath: string;
  target: EditorTarget;
  visible: boolean;
  children: ReactNode;
}

/** An external editor is one surface per conversation, independent of CodeMirror splits. */
export const SelectedEditorSurface = memo(function SelectedEditorSurface(
  props: SelectedEditorSurfaceProps,
) {
  const { target } = props;
  const canRetry = useEditorNavigationStore(
    (state) => state.fallbacks[props.featureId]?.backendId === target.id,
  );
  if (target.kind === "loading") return <EditorSurfaceLoading />;
  if (target.kind === "neovim")
    return (
      <Suspense fallback={<EditorSurfaceLoading />}>
        <NeovimPane featureId={props.featureId} />
      </Suspense>
    );
  if (target.kind === "plugin") return <PluginEditorFrame {...props} plugin={target.plugin} />;
  return (
    <div className="flex h-full flex-col">
      {target.reason && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <span>{target.reason}</span>
          {canRetry && (
            <Button variant="ghost" size="sm" onClick={() => clearEditorFallback(props.featureId)}>
              Retry editor
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{props.children}</div>
    </div>
  );
});

function EditorSurfaceLoading() {
  return (
    <div role="status" aria-label="Loading editor" className="p-3">
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

function PluginEditorFrame({
  featureId,
  projectId,
  projectPath,
  visible,
  plugin,
}: SelectedEditorSurfaceProps & {
  plugin: Extract<EditorTarget, { kind: "plugin" }>["plugin"];
}) {
  const projects = useListProjects();
  const settings = useGetFeatureSettings(featureId);
  const {
    worktree,
    isResolved,
    error: worktreeError,
  } = useFeatureWorktreeInfo(featureId, projectId);
  const project = projects.data?.find((candidate) => candidate.id === projectId);
  const contextFailed = projects.isError || settings.isError || Boolean(worktreeError);
  useEffect(() => {
    if (contextFailed)
      toast.error("The editor's project context could not be loaded.", {
        id: `editor-context:${featureId}`,
      });
  }, [contextFailed, featureId]);
  const context = usePluginTabContext(
    featureId,
    projectId,
    {
      projectPath: project?.path ?? projectPath,
      projectName: project?.name,
      worktreePath: isResolved ? (worktree?.live ? worktree.worktree_path : null) : undefined,
      gitBranch: worktree?.worktree_branch ?? undefined,
      defaultBranch: undefined,
      featureSettings: settings.data
        ? Object.fromEntries(settings.data.map((item) => [item.key, item.value]))
        : EMPTY_SETTINGS,
    },
    true,
  );
  return (
    <PluginEditorSurface
      featureId={featureId}
      summary={plugin}
      context={context}
      visible={visible}
    />
  );
}
