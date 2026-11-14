import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  useCreateFeature,
  useCreateProject,
  useSetProjectSetting,
  useUpdateFeaturePinned,
  useUpdateFeatureStatus,
  type CreateFeatureRequest,
  type MessageSearchHit,
} from "@/api/generated";
import { useEditorFileNavigator } from "@/hooks/useOpenEditorFile";
import { apiErrorMessage } from "@/lib/api-errors";
import { DEFAULT_WORKTREE_MODE_KEY, type DefaultWorktreeMode } from "@/lib/default-worktree-mode";
import { desktopBridge } from "@/lib/desktop-bridge";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { requestConversationFind } from "@/stores/conversation-find-request-store";
import { activateFeatureTab } from "@/stores/feature-layout-store";

/** How a new conversation gets its working copy. */
export type WorktreePick = { mode: "new" } | { mode: "skip" } | { mode: "reuse"; branch: string };

export interface CreateConversationOptions {
  projectId: number;
  /** Omitted: the project's usual setting, like ⌘⇧N. */
  worktree?: WorktreePick;
  /** The project's current default, to remember a different new/skip pick. */
  projectDefault?: DefaultWorktreeMode;
}

export interface PaletteOperations {
  openConversation: (projectId: number, featureId: number) => void;
  createConversation: (options: CreateConversationOptions) => Promise<void>;
  addProject: () => Promise<void>;
  setPinned: (featureId: number, pinned: boolean) => void;
  restore: (featureId: number) => void;
  /** Opens `path` in the open conversation's editor using its selected editor. */
  openFile: (featureId: number, path: string) => void;
  openMessage: (hit: MessageSearchHit, query: string) => void;
}

/** Open through the conversation's selected editor, including cold surfaces. */
function useOpenFile(): PaletteOperations["openFile"] {
  const navigate = useEditorFileNavigator();
  return useCallback((featureId, path) => navigate(featureId, { path }), [navigate]);
}

/** What the palette does to the app; every failure ends in a toast. */
export function usePaletteOperations(_activeFeatureId: number | null): PaletteOperations {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useCallback(() => {
    void invalidateByUrlPrefix(queryClient, "/api/features");
    void invalidateByUrlPrefix(queryClient, "/api/search");
  }, [queryClient]);
  const { mutateAsync: createFeature } = useCreateFeature();
  const { mutateAsync: createProject } = useCreateProject();
  const { mutateAsync: setProjectSetting } = useSetProjectSetting();
  const onWriteError = (fallback: string) => (error: unknown) =>
    toast.error(apiErrorMessage(error, fallback));
  const { mutate: updatePinned } = useUpdateFeaturePinned({
    mutation: { onSuccess: refresh, onError: onWriteError("Couldn't update the pin") },
  });
  const { mutate: updateStatus } = useUpdateFeatureStatus({
    mutation: { onSuccess: refresh, onError: onWriteError("Couldn't restore the conversation") },
  });
  const openFile = useOpenFile();

  const openConversation = useCallback(
    (projectId: number, featureId: number) => {
      void navigate({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: String(projectId), featureId: String(featureId) },
      });
    },
    [navigate],
  );

  const createConversation = useCallback(
    async ({ projectId, worktree, projectDefault }: CreateConversationOptions) => {
      const data: CreateFeatureRequest = { project_id: projectId, type: "ws-session" };
      if (worktree) data.worktree_mode = worktree.mode;
      if (worktree?.mode === "reuse") data.reuse_branch = worktree.branch;
      const toastId = toast.loading("Creating conversation…");
      try {
        if (worktree && worktree.mode !== "reuse" && worktree.mode !== projectDefault) {
          await setProjectSetting({
            id: projectId,
            data: { key: DEFAULT_WORKTREE_MODE_KEY, value: worktree.mode },
          });
        }
        const created = await createFeature({ data });
        refresh();
        openConversation(projectId, created.id);
        toast.dismiss(toastId);
      } catch (error) {
        toast.error(apiErrorMessage(error, "Couldn't create the conversation"), { id: toastId });
      }
    },
    [createFeature, openConversation, refresh, setProjectSetting],
  );

  const addProject = useCallback(async () => {
    try {
      const folder = await desktopBridge.pickDirectory();
      if (!folder) return;
      await createProject({
        data: { name: folder.split("/").pop() || folder, path: folder },
      });
      void invalidateByUrlPrefix(queryClient, "/api/projects");
      toast.success("Project added");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Couldn't add the project"));
    }
  }, [createProject, queryClient]);

  const openMessage = useCallback(
    (hit: MessageSearchHit, query: string) => {
      activateFeatureTab(hit.feature_id, "agent");
      requestConversationFind(hit.feature_id, query);
      openConversation(hit.project_id, hit.feature_id);
    },
    [openConversation],
  );

  return useMemo(
    () => ({
      openConversation,
      createConversation,
      addProject,
      setPinned: (featureId: number, pinned: boolean) =>
        updatePinned({ id: featureId, data: { pinned } }),
      restore: (featureId: number) => updateStatus({ id: featureId, data: { status: "active" } }),
      openFile,
      openMessage,
    }),
    [
      addProject,
      createConversation,
      openConversation,
      openFile,
      openMessage,
      updatePinned,
      updateStatus,
    ],
  );
}
